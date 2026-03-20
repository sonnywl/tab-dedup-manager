import { ChromeTabAdapter } from "../infrastructure/ChromeTabAdapter.js";
import {
  BrowserState,
  GroupMap,
  GroupingConfig,
  ProtectedTabMetaMap,
  Result,
  RulesByDomain,
  SyncStore,
  Tab,
  TabId,
  WindowId,
  asGroupId,
  asTabId,
  asWindowId,
  isDefined,
  validateRule,
} from "../types.js";
import {
  TabGroupingService,
  WindowManagementService,
} from "../utils/grouping.js";
// @ts-ignore
import startSyncStore from "../utils/startSyncStore.js";

export class TabGroupingController {
  private isProcessing = false;
  private lastStateHash: string | null = null;

  constructor(
    private readonly service: TabGroupingService,
    private readonly windowService: WindowManagementService,
    private readonly adapter: ChromeTabAdapter,
  ) {}

  private stateHash(
    tabs: Tab[],
    rulesByDomain: RulesByDomain,
    config: GroupingConfig,
  ): string {
    return JSON.stringify({
      tabs: [...tabs]
        .sort((a, b) => (a.id ?? 0) - (b.id ?? 0))
        .map((t) => ({
          id: t.id,
          url: t.url,
          groupId: t.groupId,
          windowId: t.windowId,
          index: t.index,
          pinned: t.pinned,
        })),
      rules: rulesByDomain,
      config,
    });
  }

  async groupByWindow(tabs: Tab[]): Promise<Map<WindowId, Tab[]>> {
    const map = new Map<WindowId, Tab[]>();
    for (const tab of tabs) {
      if (!tab.windowId) {
        console.warn(
          `[W7] Tab ${tab.id} (${tab.url}) has no windowId — left in place`,
        );
        continue;
      }
      const wid = asWindowId(tab.windowId);
      if (!map.has(wid)) map.set(wid, []);
      map.get(wid)!.push(tab);
    }
    return map;
  }

  private async captureBrowserState(): Promise<BrowserState> {
    const [tabs, groups] = await Promise.all([
      this.adapter.getNormalTabs(),
      chrome.tabGroups.query({}),
    ]);
    return {
      allTabs: tabs,
      groupIdToGroup: new Map(groups.map((g) => [g.id, g])),
    };
  }

  async processGrouping(
    allTabs: Tab[],
    windowTabs: Tab[],
    groupMap: GroupMap,
    managedGroupIds: Map<number, string>,
    protectedMeta: ProtectedTabMetaMap,
    groupIdToGroup: Map<number, chrome.tabGroups.TabGroup>,
    windowId?: WindowId,
  ): Promise<Result<void, Error>> {
    try {
      const groupsByTitle = new Map<string, number>(); // Using number for GroupId
      for (const [gid, g] of groupIdToGroup.entries()) {
        const isCorrectWindow = !windowId || g.windowId === windowId;
        if (isCorrectWindow && g.title) {
          groupsByTitle.set(g.title, asGroupId(gid));
        }
      }

      // Mandate: Use windowTabs (the INTENDED state) for the cache during planning.
      // This ensures that reposition needs are calculated against where the tab SHOULD be.
      const planningCache = new Map<TabId, Tab>(
        windowTabs.map((t) => [asTabId(t.id)!, t]),
      );

      // Pipeline:
      // 1. Virtual Mapping: Build initial group states based on intended tab distribution
      const groupStates = this.service.buildGroupStates(
        groupMap,
        planningCache,
        groupsByTitle as unknown as Map<string, number>, // Types conflict fix
        managedGroupIds,
      );

      // 2. Reposition Needs: Calculate based on intended positions
      const withReposition = this.service.calculateRepositionNeeds(
        groupStates,
        planningCache,
        windowId,
        managedGroupIds,
      );

      // 3. Plan Creation
      const plan = this.service.createGroupPlan(
        withReposition,
        planningCache,
        managedGroupIds,
        windowId,
      );

      if (plan.states.length === 0 && plan.tabsToUngroup.length === 0) {
        return { success: true, value: undefined };
      }

      // 4. Surgical Execution: Still use the PHYSICAL snapshot (allTabs) for lazy checks and moves
      return this.adapter.executeGroupPlan(plan, protectedMeta, windowId, {
        tabs: allTabs,
        groups: Array.from(groupIdToGroup.values()),
      });
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err : new Error(String(err)),
      };
    }
  }

  private async loadConfiguration(): Promise<{
    rulesByDomain: RulesByDomain;
    config: GroupingConfig;
  } | null> {
    const store: SyncStore = await startSyncStore({
      rules: [],
      grouping: {
        byWindow: false,
        numWindowsToKeep: 2,
        ungroupSingleTab: false,
      },
    });
    const state = await store.getState();
    if (!state?.rules || !state?.grouping) {
      console.error("Invalid store state:", state);
      return null;
    }

    const valid = state.rules.filter(validateRule);
    if (valid.length !== state.rules.length)
      console.warn(
        `Filtered ${state.rules.length - valid.length} invalid rules`,
      );

    const rulesByDomain: RulesByDomain = {};
    for (const r of valid) {
      if (r.domain.length > 0) {
        const normalized = this.service.normalizeDomain(r.domain);
        rulesByDomain[normalized] = r;
      }
    }

    return {
      rulesByDomain,
      config: {
        byWindow: state.grouping.byWindow,
        numWindowsToKeep: state.grouping.numWindowsToKeep,
        ungroupSingleTab: state.grouping.ungroupSingleTab,
      },
    };
  }

  private async prepareTabs(
    tabs: Tab[],
    rulesByDomain: RulesByDomain,
    config: GroupingConfig,
  ): Promise<void> {
    const unique = await this.adapter.deduplicateAllTabs(tabs);
    const remaining = await this.adapter.cleanupTabsByRules(
      unique,
      rulesByDomain,
      this.service,
    );
    if (config.ungroupSingleTab) {
      await this.adapter.ungroupSingleTabGroups(remaining);
    }
  }

  private async ensureActiveWindowId(): Promise<number | undefined> {
    const activeWindow = await chrome.windows.getCurrent();
    if (activeWindow.type === "normal" && activeWindow.id !== undefined) {
      return activeWindow.id;
    }
    const allWindows = await chrome.windows.getAll({ windowTypes: ["normal"] });
    return allWindows[0]?.id;
  }

  private async runConsolidationPhase(
    state: BrowserState,
    rulesByDomain: RulesByDomain,
    groupingConfig: GroupingConfig,
  ): Promise<BrowserState> {
    if (
      !groupingConfig.byWindow ||
      !isDefined(groupingConfig.numWindowsToKeep)
    ) {
      return state;
    }

    const { protectedMeta, managedGroupIds } =
      this.service.identifyProtectedTabs(
        state.allTabs,
        state.groupIdToGroup,
        rulesByDomain,
      );

    const plan = this.windowService.createConsolidationPlan(
      state.allTabs,
      groupingConfig.numWindowsToKeep,
      this.service,
      protectedMeta,
      managedGroupIds,
    );

    if (plan) {
      const res = await this.adapter.executeConsolidationPlan(
        plan,
        state.allTabs,
      );
      if (!res.success) throw res.error;
      return this.captureBrowserState();
    }

    return state;
  }

  private async runGroupingPhase(
    state: BrowserState,
    rulesByDomain: RulesByDomain,
    groupingConfig: GroupingConfig,
    activeWindowId: number,
  ): Promise<void> {
    const windowMap = groupingConfig.byWindow
      ? await this.groupByWindow(state.allTabs)
      : new Map([[asWindowId(activeWindowId), state.allTabs]]);

    for (const [wid, tabs] of windowMap) {
      const { protectedMeta, managedGroupIds } =
        this.service.identifyProtectedTabs(
          tabs,
          state.groupIdToGroup,
          rulesByDomain,
        );

      const groupMap = this.service.buildGroupMap(
        tabs,
        rulesByDomain,
        state.groupIdToGroup,
        protectedMeta,
      );

      await this.processGrouping(
        state.allTabs,
        tabs,
        groupMap,
        managedGroupIds,
        protectedMeta,
        state.groupIdToGroup,
        wid,
      );
    }
  }

  async execute(): Promise<void> {
    if (this.isProcessing) return;
    this.isProcessing = true;

    try {
      const config = await this.loadConfiguration();
      if (!config) return;
      const { rulesByDomain, config: groupingConfig } = config;

      let state = await this.captureBrowserState();
      const activeWindowId = await this.ensureActiveWindowId();
      if (activeWindowId === undefined) {
        console.warn("No normal windows found to group tabs in.");
        return;
      }

      const hash = this.stateHash(state.allTabs, rulesByDomain, groupingConfig);
      if (this.lastStateHash === hash) {
        console.log("No state changes, skipping...");
        return;
      }

      // 1. Cleanup & Refresh
      await this.prepareTabs(state.allTabs, rulesByDomain, groupingConfig);
      state = await this.captureBrowserState();

      // 2. Phase 1: Window Consolidation
      state = await this.runConsolidationPhase(
        state,
        rulesByDomain,
        groupingConfig,
      );

      // 3. Phase 2: Grouping Pass
      await this.runGroupingPhase(
        state,
        rulesByDomain,
        groupingConfig,
        activeWindowId,
      );

      // 4. Finalize state hash
      const finalState = await this.captureBrowserState();
      this.lastStateHash = this.stateHash(
        finalState.allTabs,
        rulesByDomain,
        groupingConfig,
      );
    } catch (err) {
      console.warn("Execute error:", err);
    } finally {
      this.isProcessing = false;
    }
  }
}
