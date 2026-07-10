import {
  BrowserState,
  GroupingConfig,
  ProtectedTabMetaMap,
  Result,
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

const STABILITY_DELAY =
  // ms to wait for Chrome concurrent calls to settle. See background.ts
  typeof process !== "undefined" && process.env.NODE_ENV === "test" ? 1 : 250;

export default class TabGroupingController {
  private isProcessing = false;

  constructor(
    private readonly service: TabGroupingService,
    private readonly windowService: WindowManagementService,
    private readonly adapter: ChromeTabAdapter,
    private readonly store: SyncStore,
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
      this.adapter.getGroups(),
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

  private async loadConfiguration(providedState?: SyncStoreState): Promise<{
    rulesByDomain: RulesByDomain;
    config: GroupingConfig;
  }> {
    const state = providedState || (await this.store.getState());
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
        sortManualGroupTabs: !!grouping.sortManualGroupTabs,
      },
    };
  }

  /**
   * Phase 0: Cleanup (Deduplication, Auto-Delete, Internal Pre-sort).
   */
  private async runCleanupPhase(
    state: BrowserState,
    config: GroupingConfig,
    rulesByDomain: RulesByDomain,
  ): Promise<BrowserState> {
    let modified = false;

    const internalMoves = this.service.calculateInternalPageMoves(
      state.allTabs,
    );
    if (internalMoves.length > 0) {
      await this.adapter.applyInternalPageMoves(internalMoves);
      modified = true;
    }

    if (config.ungroupSingleTab) {
      await this.adapter.ungroupSingleTabGroups(state.allTabs);
      modified = true;
    }

    // Deduplication & Auto-Delete
    const toRemove = this.service.getCleanupTabIds(
      state.allTabs,
      rulesByDomain,
    );
    if (toRemove.size > 0) {
      await this.adapter.removeTabs([...toRemove]);
      modified = true;
    }

    return modified ? this.refreshState() : state;
  }

  private async ensureActiveWindowId(): Promise<number> {
    const activeWindow = await this.adapter.getCurrentWindow();
    if (activeWindow && activeWindow.id !== undefined) {
      return activeWindow.id;
    }
    const allWindows = await this.adapter.getAllNormalWindows();
    if (allWindows.length > 0 && allWindows[0].id !== undefined) {
      return allWindows[0].id;
    }
    throw new Error("No normal browser windows found.");
  }

  /**
   * Phase 1: Window Consolidation (Merge excess windows into retained targets).
   */
  private async runConsolidationPhase(
    state: BrowserState,
    groupingConfig: GroupingConfig,
    activeWindowId: number,
  ): Promise<BrowserState> {
    const numToKeep = groupingConfig.byWindow
      ? groupingConfig.numWindowsToKeep
      : 1;

    if (!isDefined(numToKeep)) return state;

    const plan = this.windowService.createConsolidationPlan(
      state.allTabs,
      numToKeep,
      this.service,
      asWindowId(activeWindowId),
    );

    if (plan) {
      const res = await this.adapter.executeConsolidationPlan(
        plan,
        state.allTabs,
      );
      if (!res.success) throw res.error;
      return this.refreshState();
    }

    return state;
  }

  /**
   * Phase 2: Grouping Pass (Membership and Ordering).
   */
  private async runGroupingPhase(
    state: BrowserState,
    groupingConfig: GroupingConfig,
    rulesByDomain: RulesByDomain,
    activeWindowId: number,
    protectedMeta: ProtectedTabMetaMap,
    managedGroupIds: Map<number, string>,
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
        protectedMeta,
        managedGroupIds,
        !!groupingConfig.sortManualGroupTabs,
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
    isGlobal: boolean,
    protectedMeta: ProtectedTabMetaMap,
    managedGroupIds: Map<number, string>,
  ) {
    const scopedTabs = isGlobal
      ? state.allTabs
      : state.allTabs.filter((t) => t.windowId === windowId);

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
    providedProtectedMeta: ProtectedTabMetaMap,
    providedManagedGroupIds: Map<number, string>,
    sortManualGroupTabs: boolean,
  ): Promise<Result<BrowserState, Error>> {
    try {
      // Phase 2a: Membership
      const pre = this.buildGroupingContext(
        state,
        windowId,
        rulesByDomain,
        isGlobal,
        providedProtectedMeta,
        providedManagedGroupIds,
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
      const freshState = await this.refreshState();
      const fresh = this.buildGroupingContext(
        freshState,
        windowId,
        rulesByDomain,
        isGlobal,
        providedProtectedMeta,
        providedManagedGroupIds,
      );

      const repositionStates = this.service.calculateRepositionNeeds(
        fresh.groupStates,
        fresh.tabCache,
        windowId,
        fresh.managedGroupIds,
        sortManualGroupTabs,
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

      return { success: true, value: await this.refreshState() };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err : new Error(String(err)),
      };
    }
  }

  async updateBadge(): Promise<void> {
    if (this.isProcessing) return;

    try {
      const [state, rawStore, _] = await Promise.all([
        this.refreshState(),
        this.store.getState(),
        this.ensureActiveWindowId(),
      ]);
      const configResult = await this.loadConfiguration(rawStore);
      const { rulesByDomain } = configResult;

      const toRemove = this.service.getCleanupTabIds(
        state.allTabs,
        rulesByDomain,
      );

      if (toRemove.size > 0) {
        await this.adapter.updateBadge(toRemove.size.toString());
        return;
      }
    } catch (err) {
      console.warn("Failed to update badge:", err);
    }
  }

  async execute(): Promise<void> {
    if (this.isProcessing) return;
    this.isProcessing = true;

    try {
      this.adapter.updateBadge("O", "#FFD700");
      const [initialState, rawStore, activeWindowId] = await Promise.all([
        this.refreshState(),
        this.store.getState(),
        this.ensureActiveWindowId(),
      ]);
      let state = initialState;

      const configResult = await this.loadConfiguration(rawStore);
      const { rulesByDomain, config } = configResult;

      // Phase 0: Cleanup (skip if explicitly requested)
      state = await this.runCleanupPhase(state, config, rulesByDomain);

      // This ensures that manual groups moving across windows are remembered and re-bundled.
      const { protectedMeta, managedGroupIds } =
        this.service.identifyProtectedTabs(
          state.allTabs,
          state.groupIdToGroup,
          rulesByDomain,
        );

      // Phase 1: Consolidation
      state = await this.runConsolidationPhase(state, config, activeWindowId);

      // Phase 2: Grouping
      state = await this.runGroupingPhase(
        state,
        config,
        rulesByDomain,
        activeWindowId,
        protectedMeta,
        managedGroupIds,
      );

      // Phase 3: Verification
      const isVerified = this.service.verifyState(
        state.allTabs,
        state.groupIdToGroup,
        rulesByDomain,
        config,
        asWindowId(activeWindowId),
        this.windowService,
      );

      if (!isVerified) {
        console.warn("Verification failed, skipping retry for idempotency.");
      }

      this.adapter.updateBadge("");
    } catch (err) {
      console.warn("Execute error:", err);
      console.trace();
      this.adapter.updateBadge("!", "#FFA500");
    } finally {
      this.isProcessing = false;
    }
  }
}
