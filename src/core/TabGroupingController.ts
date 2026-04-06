import {
  BrowserState,
  GroupingConfig,
  Result,
  RulesByDomain,
  SyncStore,
  Tab,
  TabId,
  WindowId,
  asTabId,
  asWindowId,
  isDefined,
  validateRule,
} from "@/types";
import { TabGroupingService, WindowManagementService } from "utils/grouping";

import ChromeTabAdapter from "./ChromeTabAdapter";

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
    groups: Map<number, chrome.tabGroups.TabGroup>,
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
      groups: Array.from(groups.values())
        .sort((a, b) => a.id - b.id)
        .map((g) => ({
          id: g.id,
          title: g.title,
          collapsed: g.collapsed,
        })),
    });
  }

  private async captureBrowserState(): Promise<BrowserState> {
    const [tabs, groups] = await Promise.all([
      this.adapter.getNormalTabs(),
      chrome.tabGroups.query({}),
    ]);

    // Mandate: Ensure tabs are sorted by windowId and index for stable processing
    tabs.sort((a, b) => {
      if (a.windowId !== b.windowId)
        return (a.windowId || 0) - (b.windowId || 0);
      return a.index - b.index;
    });

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
      await this.adapter.ungroupSingleTabGroups(
        remaining,
        this.service,
        rulesByDomain,
      );
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

    for (const [wid, tabs] of windowMap) {
      const res = await this.processGrouping(
        wid,
        rulesByDomain,
        !groupingConfig.byWindow ? tabs : undefined,
      );
      if (!res.success) throw res.error;
    }
  }

  /**
   * Encapsulates the core transformation pipeline from raw tabs to grouping logic context.
   */
  private async getGroupingContext(
    windowId: WindowId,
    rulesByDomain: RulesByDomain,
    overrideTabs?: Tab[],
  ) {
    const state = await this.captureBrowserState();
    return this.buildGroupingContext(
      state,
      windowId,
      rulesByDomain,
      overrideTabs,
    );
  }

  /**
   * Pure logic transformation from a known browser state to grouping context.
   */
  private buildGroupingContext(
    state: BrowserState,
    windowId: WindowId,
    rulesByDomain: RulesByDomain,
    overrideTabs?: Tab[],
  ) {
    const scopedTabs =
      overrideTabs || state.allTabs.filter((t) => t.windowId === windowId);

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

    const tabCache = new Map<TabId, Tab>(
      scopedTabs.map((t) => [asTabId(t.id)!, t]),
    );

    const groupStates = this.service.buildGroupStates(
      groupMap,
      tabCache,
      undefined,
      managedGroupIds,
    );

    return {
      allTabs: state.allTabs,
      scopedTabs,
      groupStates,
      managedGroupIds,
      tabCache,
    };
  }

  async processGrouping(
    windowId: WindowId,
    rulesByDomain: RulesByDomain,
    overrideTabs?: Tab[],
  ): Promise<Result<void, Error>> {
    try {
      // Phase 2a: Membership
      // We start by calculating the memberships based on the current reality
      const pre = await this.getGroupingContext(
        windowId,
        rulesByDomain,
        overrideTabs,
      );
      const membershipPlan = this.service.buildMembershipPlan(
        pre.groupStates,
        pre.tabCache,
        pre.managedGroupIds,
        windowId,
      );

      const memRes = await this.adapter.executeMembershipPlan(
        membershipPlan,
        pre.allTabs,
      );
      if (!memRes.success) return memRes;

      // Phase 2b: Ordering (The "Reality Check" way)
      // Capture a fresh context to see the ACTUAL indices and IDs after Phase 2a
      // In global mode, Phase 2a has moved all tabs into the target window,
      // so we don't need overrideTabs anymore for the reality check.
      const fresh = await this.getGroupingContext(windowId, rulesByDomain);

      const repositionStates = this.service.calculateRepositionNeeds(
        fresh.groupStates,
        fresh.tabCache,
        windowId,
        fresh.managedGroupIds,
      );

      const desired = this.service.mapToOrderUnits(repositionStates);
      const live = this.service.getLiveUnits(fresh.scopedTabs);

      const orderPlan = this.service.buildOrderPlan(desired, live);
      return this.adapter.executeOrderPlan(
        orderPlan,
        windowId,
        fresh.scopedTabs,
      );
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err : new Error(String(err)),
      };
    }
  }

  async updateBadge(): Promise<void> {
    try {
      const config = await this.loadConfiguration();
      if (!config) return;
      const { rulesByDomain } = config;

      const state = await this.captureBrowserState();
      const total = state.allTabs.length;
      if (total === 0) {
        await this.adapter.updateBadge(0);
        return;
      }

      const affectedIds = new Set<TabId>();

      this.service
        .getDuplicateTabIds(state.allTabs)
        .forEach((id) => affectedIds.add(id));
      this.service
        .getAutoDeleteTabIds(state.allTabs, rulesByDomain)
        .forEach((id) => affectedIds.add(id));

      await this.adapter.updateBadge(affectedIds.size);
    } catch (err) {
      console.warn("Failed to calculate affected tabs for badge:", err);
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

      const hash = this.stateHash(state.allTabs, state.groupIdToGroup);
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
        finalState.groupIdToGroup,
      );
    } catch (err) {
      console.warn("Execute error:", err);
    } finally {
      this.isProcessing = false;
    }
  }
}
