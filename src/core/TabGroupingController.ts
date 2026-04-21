import {
  BrowserState,
  GroupId,
  GroupingConfig,
  Result,
  Rule,
  RulesByDomain,
  SyncStore,
  SyncStoreState,
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

const STABILITY_DELAY = 60; // ms to wait for Chrome to propagate moves/indices

export default class TabGroupingController {
  private isProcessing = false;
  private lastStateHash: string | null = null;
  private lastFullStateHash: string | null = null;
  private lastAutoStateHash: string | null = null;

  constructor(
    private readonly service: TabGroupingService,
    private readonly windowService: WindowManagementService,
    private readonly adapter: ChromeTabAdapter,
    private readonly store: SyncStore<SyncStoreState>,
  ) {}

  /**
   * Refreshes the browser state, optionally waiting for Chrome's internal indices to stabilize.
   */
  private async refreshState(withDelay = false): Promise<BrowserState> {
    if (withDelay) {
      await new Promise((r) => setTimeout(r, STABILITY_DELAY));
    }

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
    const rulesByDomain: RulesByDomain = {};
    for (const r of valid) {
      if (r.domain.length > 0) {
        rulesByDomain[this.service.normalizeDomain(r.domain)] = r;
      }
    }

    return {
      rulesByDomain,
      config: {
        byWindow: !!grouping.byWindow,
        numWindowsToKeep: grouping.numWindowsToKeep,
        ungroupSingleTab: !!grouping.ungroupSingleTab,
        processGroupOnChange: !!grouping.processGroupOnChange,
      },
    };
  }

  /**
   * Phase 0: Cleanup (Duplicates, Auto-Delete, Internal Pre-sort).
   */
  private async runCleanupPhase(
    state: BrowserState,
    rulesByDomain: RulesByDomain,
    config: GroupingConfig,
    skipDestructive?: boolean,
  ): Promise<BrowserState> {
    let currentState = state;
    let modified = false;

    if (!skipDestructive) {
      const dupes = this.service.getDuplicateTabIds(currentState.allTabs);
      const autoDeletes = this.service.getAutoDeleteTabIds(
        currentState.allTabs,
        rulesByDomain,
      );
      const toRemove = Array.from(new Set([...dupes, ...autoDeletes]));

      if (toRemove.length > 0) {
        await this.adapter.removeTabs(toRemove);
        currentState = await this.refreshState(true);
      }
    }

    // Pre-sort internal browser pages (chrome:// etc.) to the start
    await this.adapter.moveInternalTabsToStart(currentState.allTabs);
    modified = true;

    if (config.ungroupSingleTab) {
      await this.adapter.ungroupSingleTabGroups(
        currentState.allTabs,
        this.service,
        rulesByDomain,
      );
      modified = true;
    }

    return modified ? this.refreshState(true) : currentState;
  }

  private async ensureActiveWindowId(): Promise<number> {
    const activeWindow = await chrome.windows.getCurrent();
    if (activeWindow.type === "normal" && activeWindow.id !== undefined) {
      return activeWindow.id;
    }
    const allWindows = await chrome.windows.getAll({ windowTypes: ["normal"] });
    return allWindows[0]?.id as number;
  }

  /**
   * Phase 1: Window Consolidation (Merge excess windows into retained targets).
   */
  private async runConsolidationPhase(
    state: BrowserState,
    rulesByDomain: RulesByDomain,
    groupingConfig: GroupingConfig,
    activeWindowId: number,
  ): Promise<BrowserState> {
    const numToKeep = groupingConfig.byWindow
      ? groupingConfig.numWindowsToKeep
      : 1;

    if (!isDefined(numToKeep)) return state;

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
      return this.refreshState(true);
    }

    return state;
  }

  /**
   * Phase 2: Grouping Pass (Membership and Ordering).
   */
  private async runGroupingPhase(
    state: BrowserState,
    rulesByDomain: RulesByDomain,
    groupingConfig: GroupingConfig,
    activeWindowId: number,
  ): Promise<BrowserState> {
    const windowMap = groupingConfig.byWindow
      ? this.windowService.groupByWindow(state.allTabs)
      : new Map([[asWindowId(activeWindowId), state.allTabs]]);

    let currentState = state;
    for (const [wid] of windowMap) {
      const res = await this.processGrouping(
        wid,
        rulesByDomain,
        !groupingConfig.byWindow,
        currentState,
      );
      if (!res.success) throw res.error;
      currentState = res.value;
    }

    return currentState;
  }

  /**
   * Pure logic transformation from a known browser state to grouping logic context.
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
      scopedTabs,
      groupStates,
      managedGroupIds,
      tabCache,
    };
  }

  async processGrouping(
    windowId: WindowId,
    rulesByDomain: RulesByDomain,
    isGlobal: boolean,
    state: BrowserState,
  ): Promise<Result<BrowserState, Error>> {
    try {
      // Phase 2a: Membership
      const pre = this.buildGroupingContext(
        state,
        windowId,
        rulesByDomain,
        isGlobal,
      );

      const membershipPlan = this.service.buildMembershipPlan(
        pre.groupStates,
        pre.tabCache,
        pre.managedGroupIds,
        windowId,
      );

      const memRes = await this.adapter.executeMembershipPlan(
        membershipPlan,
        state.allTabs,
      );
      if (!memRes.success) return memRes;

      // Phase 2b: Ordering (The "Reality Check" way)
      const freshState = await this.refreshState(true);
      const fresh = this.buildGroupingContext(
        freshState,
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
      const orderRes = await this.adapter.executeOrderPlan(
        orderPlan,
        windowId,
        fresh.scopedTabs,
      );
      if (!orderRes.success) return orderRes;

      // Final settle-refresh for this window/unit
      return { success: true, value: await this.refreshState(true) };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err : new Error(String(err)),
      };
    }
  }

  private shouldSkip(
    currentHash: string,
    isAuto: boolean,
  ): { skip: boolean; reason?: string } {
    if (currentHash === this.lastFullStateHash) {
      return { skip: true, reason: "Matches last full state" };
    }
    if (isAuto && currentHash === this.lastAutoStateHash) {
      return { skip: true, reason: "Matches last auto state" };
    }
    return { skip: false };
  }

  async updateBadge(): Promise<void> {
    if (this.isProcessing) return;

    try {
      const state = await this.refreshState();
      const configResult = await this.loadConfiguration();
      const { rulesByDomain } = configResult;

      const dupes = this.service.getDuplicateTabIds(state.allTabs);
      const autoDeletes = this.service.getAutoDeleteTabIds(
        state.allTabs,
        rulesByDomain,
      );
      const closeCount = new Set([...dupes, ...autoDeletes]).size;

      if (closeCount > 0) {
        await this.adapter.updateBadge(closeCount.toString());
        return;
      }

      const currentHash = this.service.hashState(
        state.allTabs,
        state.groupIdToGroup,
      );

      if (this.shouldSkip(currentHash, false).skip) {
        await this.adapter.updateBadge("");
        return;
      }

      await this.adapter.updateBadge("!");
    } catch (err) {
      console.warn("Failed to update badge:", err);
    }
  }

  async execute(options?: { skipCleanup?: boolean }): Promise<void> {
    if (this.isProcessing) return;
    this.isProcessing = true;

    try {
      this.adapter.updateBadge("O", "#FFD700");
      const [activeWindowId, configResult] = await Promise.all([
        this.ensureActiveWindowId(),
        this.loadConfiguration(),
      ]);
      const { rulesByDomain, config: groupingConfig } = configResult;

      let state = await this.refreshState();
      const currentHash = this.service.hashState(
        state.allTabs,
        state.groupIdToGroup,
      );

      const { skip, reason } = this.shouldSkip(
        currentHash,
        !!options?.skipCleanup,
      );
      if (skip) {
        console.log(`Skipping: ${reason}`);
        this.adapter.updateBadge("");
        return;
      }

      // Phase 0: Cleanup
      state = await this.runCleanupPhase(
        state,
        rulesByDomain,
        groupingConfig,
        options?.skipCleanup,
      );

      // Phase 1: Consolidation
      state = await this.runConsolidationPhase(
        state,
        rulesByDomain,
        groupingConfig,
        activeWindowId,
      );

      // Phase 2: Grouping
      state = await this.runGroupingPhase(
        state,
        rulesByDomain,
        groupingConfig,
        activeWindowId,
      );

      // Final Fingerprinting (after all phases)
      const finalState = await this.refreshState(true);
      const finalHash = this.service.hashState(
        finalState.allTabs,
        finalState.groupIdToGroup,
      );

      this.lastStateHash = finalHash;
      this.lastAutoStateHash = finalHash;
      this.lastFullStateHash = finalHash;

      this.adapter.updateBadge("");
    } catch (err) {
      console.warn("Execute error:", err);
    } finally {
      this.isProcessing = false;
    }
  }
}
