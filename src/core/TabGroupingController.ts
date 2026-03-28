import {
  BrowserState,
  GroupId,
  GroupMap,
  GroupingConfig,
  MembershipPlan,
  OrderPlan,
  OrderUnit,
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
  extractTabIds,
  isDefined,
  isGrouped,
  validateRule,
} from "../types.js";
import {
  TabGroupingService,
  WindowManagementService,
} from "../utils/grouping.js";

import ChromeTabAdapter from "./ChromeTabAdapter.js";

export default class TabGroupingController {
  private isProcessing = false;
  private lastStateHash: string | null = null;

  constructor(
    private readonly service: TabGroupingService,
    private readonly windowService: WindowManagementService,
    private readonly adapter: ChromeTabAdapter,
    private readonly store: SyncStore,
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

  private async loadConfiguration(): Promise<{
    rulesByDomain: RulesByDomain;
    config: GroupingConfig;
  } | null> {
    const state = await this.store.getState();
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
    // Pre-sort internal browser pages to the start of each window
    await this.adapter.moveInternalTabsToStart(remaining);

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
      ? this.windowService.groupByWindow(state.allTabs)
      : new Map([[asWindowId(activeWindowId), state.allTabs]]);

    for (const [wid, scopedTabs] of windowMap) {
      const { protectedMeta, managedGroupIds } =
        this.service.identifyProtectedTabs(
          scopedTabs,
          state.groupIdToGroup,
          rulesByDomain,
        );

      const groupMap = this.service.buildGroupMap(
        scopedTabs,
        rulesByDomain,
        state.groupIdToGroup,
        protectedMeta,
      );

      const res = await this.processGrouping(
        state.allTabs,
        scopedTabs,
        groupMap,
        managedGroupIds,
        protectedMeta,
        state.groupIdToGroup,
        rulesByDomain,
        wid,
      );
      if (!res.success) throw res.error;
    }
  }

  async processGrouping(
    allTabs: Tab[],
    scopedTabs: Tab[],
    groupMap: GroupMap,
    managedGroupIds: Map<number, string>,
    protectedMeta: ProtectedTabMetaMap,
    groupIdToGroup: Map<number, chrome.tabGroups.TabGroup>,
    rulesByDomain: RulesByDomain,
    windowId: WindowId,
  ): Promise<Result<void, Error>> {
    try {
      const groupsByTitle = new Map<string, GroupId>();
      for (const [gid, g] of groupIdToGroup.entries()) {
        if (g.windowId === windowId && g.title) {
          groupsByTitle.set(g.title, asGroupId(gid));
        }
      }

      const planningCache = new Map<TabId, Tab>(
        scopedTabs.map((t) => [asTabId(t.id)!, t]),
      );

      // Phase 2a: Membership
      const groupStates = this.service.buildGroupStates(
        groupMap,
        planningCache,
        groupsByTitle,
        managedGroupIds,
      );

      const membershipPlan = this.service.buildMembershipPlan(
        groupStates,
        planningCache,
        managedGroupIds,
        windowId,
      );

      const memRes = await this.adapter.executeMembershipPlan(
        membershipPlan,
        allTabs,
      );
      if (!memRes.success) return memRes;

      // Phase 2b: Ordering
      // Re-capture state after membership changes
      const freshState = await this.captureBrowserState();
      const freshScopedTabs = freshState.allTabs.filter(
        (t) => t.windowId === windowId,
      );
      const freshGroups = Array.from(freshState.groupIdToGroup.values()).filter(
        (g) => g.windowId === windowId,
      );
      const freshTabCache = new Map<TabId, Tab>(
        freshState.allTabs.map((t) => [asTabId(t.id)!, t]),
      );

      // Build desired OrderUnit[] from repositioned groupStates
      // Use freshTabCache to get accurate current positions for needsReposition check
      const withReposition = this.service.calculateRepositionNeeds(
        groupStates,
        freshTabCache,
        windowId,
        managedGroupIds,
      );

      const desired: OrderUnit[] = withReposition.map((s) => {
        if (s.isExternal || s.tabIds.length >= 2) {
          // Find the actual groupId in fresh state by title
          const g = freshGroups.find((g) => g.title === s.displayName);
          return {
            kind: "group",
            groupId: g ? asGroupId(g.id) : (s.groupId as GroupId),
            tabIds: [...s.tabIds],
            targetIndex: s.targetIndex!,
          };
        } else {
          return {
            kind: "solo",
            tabId: s.tabIds[0],
            targetIndex: s.targetIndex!,
          };
        }
      });

      // Build live OrderUnit[] from fresh snapshot tab order
      const live: OrderUnit[] = [];
      const seenGroups = new Set<number>();

      for (const t of freshScopedTabs) {
        if (isGrouped(t)) {
          if (!seenGroups.has(t.groupId)) {
            seenGroups.add(t.groupId);
            const gTabs = freshScopedTabs.filter(
              (gt) => gt.groupId === t.groupId,
            );
            live.push({
              kind: "group",
              groupId: asGroupId(t.groupId),
              tabIds: extractTabIds(gTabs),
              targetIndex: t.index, // Using current index for live units
            });
          }
        } else {
          live.push({
            kind: "solo",
            tabId: asTabId(t.id)!,
            targetIndex: t.index, // Using current index for live units
          });
        }
      }

      const orderPlan = this.service.buildOrderPlan(desired, live);
      return this.adapter.executeOrderPlan(
        orderPlan,
        windowId,
        freshScopedTabs,
      );
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err : new Error(String(err)),
      };
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
