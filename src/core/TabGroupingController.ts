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
  private lastFullStateHash: string | null = null;
  private lastAutoStateHash: string | null = null;

  constructor(
    private readonly service: TabGroupingService,
    private readonly windowService: WindowManagementService,
    private readonly adapter: ChromeTabAdapter,
    private readonly store: SyncStore,
  ) {}

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
  }> {
    const state = await this.store.getState();
    const rules = state?.rules ?? [];
    const grouping = state?.grouping ?? {};

    const valid = rules.filter(validateRule);
    if (valid.length !== rules.length)
      console.warn(`Filtered ${rules.length - valid.length} invalid rules`);

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
        byWindow: grouping.byWindow,
        numWindowsToKeep: grouping.numWindowsToKeep,
        ungroupSingleTab: grouping.ungroupSingleTab,
      },
    };
  }

  private async prepareTabs(
    tabs: Tab[],
    rulesByDomain: RulesByDomain,
    config: GroupingConfig,
    skipCleanup?: boolean,
  ): Promise<Tab[]> {
    let currentTabs = tabs;

    if (!skipCleanup) {
      const unique = await this.adapter.deduplicateAllTabs(currentTabs);
      currentTabs = await this.adapter.cleanupTabsByRules(
        unique,
        rulesByDomain,
        this.service,
      );
    }

    // Pre-sort internal browser pages to the start of each window
    await this.adapter.moveInternalTabsToStart(currentTabs);

    if (config.ungroupSingleTab) {
      await this.adapter.ungroupSingleTabGroups(
        currentTabs,
        this.service,
        rulesByDomain,
      );
    }

    return currentTabs;
  }

  private async ensureActiveWindowId(): Promise<number> {
    const activeWindow = await chrome.windows.getCurrent();
    if (activeWindow.type === "normal" && activeWindow.id !== undefined) {
      return activeWindow.id;
    }
    const allWindows = await chrome.windows.getAll({ windowTypes: ["normal"] });
    return allWindows[0]?.id as number;
  }

  private async runConsolidationPhase(
    state: BrowserState,
    rulesByDomain: RulesByDomain,
    groupingConfig: GroupingConfig,
    activeWindowId: number,
  ): Promise<BrowserState> {
    const numToKeep = groupingConfig.byWindow
      ? groupingConfig.numWindowsToKeep
      : 1;

    if (!isDefined(numToKeep)) {
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
      numToKeep,
      this.service,
      protectedMeta,
      managedGroupIds,
      asWindowId(activeWindowId),
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

    for (const [wid] of windowMap) {
      const res = await this.processGrouping(
        wid,
        rulesByDomain,
        !groupingConfig.byWindow,
        state,
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
    isGlobal?: boolean,
  ) {
    const state = await this.captureBrowserState();
    return this.buildGroupingContext(state, windowId, rulesByDomain, isGlobal);
  }

  /**
   * Pure logic transformation from a known browser state to grouping context.
   */
  private buildGroupingContext(
    state: BrowserState,
    windowId: WindowId,
    rulesByDomain: RulesByDomain,
    isGlobal?: boolean,
  ) {
    const scopedTabs = isGlobal
      ? state.allTabs
      : state.allTabs.filter((t) => t.windowId === windowId);

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
    isGlobal?: boolean,
    state?: BrowserState,
  ): Promise<Result<void, Error>> {
    try {
      // Phase 2a: Membership
      // We start by calculating the memberships based on the provided state or fresh context
      const pre = state
        ? this.buildGroupingContext(state, windowId, rulesByDomain, isGlobal)
        : await this.getGroupingContext(windowId, rulesByDomain, isGlobal);

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
      const fresh = await this.getGroupingContext(
        windowId,
        rulesByDomain,
        isGlobal,
      );

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
      const state = await this.captureBrowserState();
      const currentHash = this.service.hashState(
        state.allTabs,
        state.groupIdToGroup,
      );

      // Identity check: skip if state matches the perfect "ideal" state from the last full execution
      if (this.lastFullStateHash === currentHash) {
        await this.adapter.updateBadge("");
        return;
      }

      const configResult = await this.loadConfiguration();
      if (!configResult) return;
      const { rulesByDomain } = configResult;

      // 1. Closures (Duplicates + Auto-Delete)
      const dupes = this.service.getDuplicateTabIds(state.allTabs);
      const autoDeletes = this.service.getAutoDeleteTabIds(
        state.allTabs,
        rulesByDomain,
      );
      const closeCount = new Set([...dupes, ...autoDeletes]).size;

      if (closeCount > 0) {
        await this.adapter.updateBadge(closeCount.toString());
      } else {
        // We know something is off because currentHash !== lastStateHash,
        // and it's not a closure. So it must be a sort or grouping change.
        await this.adapter.updateBadge("!");
      }
    } catch (err) {
      console.warn("Failed to calculate affected tabs for badge:", err);
    }
  }

  async execute(options?: { skipCleanup?: boolean }): Promise<void> {
    if (this.isProcessing) {
      console.warn("Tab grouping in progress");
      return;
    }
    this.isProcessing = true;

    try {
      this.adapter.updateBadge("O", "#FFD700");
      const [activeWindowId, config] = await Promise.all([
        this.ensureActiveWindowId(),
        this.loadConfiguration(),
      ]);
      const { rulesByDomain, config: groupingConfig } = config;

      let state = await this.captureBrowserState();
      const currentHash = this.service.hashState(
        state.allTabs,
        state.groupIdToGroup,
      );

      if (options?.skipCleanup) {
        // Automatic: Skip if we match either last auto state OR last full state
        if (
          currentHash === this.lastAutoStateHash ||
          currentHash === this.lastFullStateHash
        ) {
          console.log("No state changes (auto), skipping...");
          this.adapter.updateBadge("");
          return;
        }
      } else {
        // Manual: Only skip if we match the last full (clean) state
        if (currentHash === this.lastFullStateHash) {
          console.log("No state changes (manual), skipping...");
          this.adapter.updateBadge("");
          return;
        }
      }

      // 1. Cleanup & Refresh
      const remainingTabs = await this.prepareTabs(
        state.allTabs,
        rulesByDomain,
        groupingConfig,
        options?.skipCleanup,
      );

      // Use the tabs returned by prepareTabs for the rest of the flow
      state.allTabs = remainingTabs;

      // 2. Phase 1: Window Consolidation
      state = await this.runConsolidationPhase(
        state,
        rulesByDomain,
        groupingConfig,
        activeWindowId,
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
      const finalHash = this.service.hashState(
        finalState.allTabs,
        finalState.groupIdToGroup,
      );

      this.lastStateHash = finalHash;
      if (options?.skipCleanup) {
        this.lastAutoStateHash = finalHash;
      } else {
        this.lastFullStateHash = finalHash;
        this.lastAutoStateHash = finalHash;
      }
      this.adapter.updateBadge("");
    } catch (err) {
      console.warn("Execute error:", err);
    } finally {
      this.isProcessing = false;
    }
  }
}
