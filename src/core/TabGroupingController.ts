import {
  BrowserState,
  GroupingConfig,
  ProtectedTabMetaMap,
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

const STABILITY_DELAY =
  // ms to wait for Chrome concurrent calls to settle. See background.ts
  typeof process !== "undefined" && process.env.NODE_ENV === "test" ? 1 : 250;

export default class TabGroupingController {
  private isProcessing = false;
  private lastFullStateHash: string | null = null;
  private lastAutoStateHash: string | null = null;

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
    config: GroupingConfig,
    rulesByDomain: RulesByDomain,
    skipDestructive?: boolean,
  ): Promise<BrowserState> {
    let modified = false;

    if (!skipDestructive) {
      const toRemove = Array.from(
        this.service.getCleanupTabIds(state.allTabs, rulesByDomain),
      );

      if (toRemove.length > 0) {
        await this.adapter.removeTabs(toRemove);
        modified = true;
      }
    }

    const internalMoves = this.service.calculateInternalPageMoves(
      state.allTabs,
    );
    if (internalMoves.length > 0) {
      await this.adapter.applyInternalPageMoves(internalMoves);
      modified = true;
    }

    if (config.ungroupSingleTab) {
      await this.adapter.ungroupSingleTabGroups(
        state.allTabs,
        this.service,
        rulesByDomain,
      );
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
    protectedMeta: ProtectedTabMetaMap,
    managedGroupIds: Map<number, string>,
  ): Promise<BrowserState> {
    const numToKeep = groupingConfig.byWindow
      ? groupingConfig.numWindowsToKeep
      : 1;

    if (!isDefined(numToKeep)) return state;

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

  clearHash(): void {
    this.lastAutoStateHash = null;
    this.lastFullStateHash = null;
  }

  async updateBadge(): Promise<void> {
    if (this.isProcessing) return;

    try {
      const state = await this.refreshState();
      const configResult = await this.loadConfiguration();
      const { rulesByDomain } = configResult;

      const toRemove = this.service.getCleanupTabIds(
        state.allTabs,
        rulesByDomain,
      );

      if (toRemove.size > 0) {
        await this.adapter.updateBadge(toRemove.size.toString());
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
      let state = await this.refreshState();
      const currentHash = this.service.hashState(
        state.allTabs,
        state.groupIdToGroup,
      );
      const isAuto = !!options?.skipCleanup;
      const { skip, reason } = this.shouldSkip(currentHash, isAuto);
      if (skip) {
        console.log(`Skipping: ${reason}`);
        this.adapter.updateBadge("");
        return;
      }
      if (!isAuto) {
        this.clearHash();
      }

      const [activeWindowId, configResult] = await Promise.all([
        this.ensureActiveWindowId(),
        this.loadConfiguration(),
      ]);
      const { rulesByDomain, config } = configResult;

      // Phase 0: Cleanup
      state = await this.runCleanupPhase(
        state,
        config,
        rulesByDomain,
        options?.skipCleanup,
      );

      // This ensures that manual groups moving across windows are remembered and re-bundled.
      const { protectedMeta, managedGroupIds } =
        this.service.identifyProtectedTabs(
          state.allTabs,
          state.groupIdToGroup,
          rulesByDomain,
        );

      // Phase 1: Consolidation
      state = await this.runConsolidationPhase(
        state,
        config,
        activeWindowId,
        protectedMeta,
        managedGroupIds,
      );

      // Phase 2: Grouping
      state = await this.runGroupingPhase(
        state,
        config,
        rulesByDomain,
        activeWindowId,
        protectedMeta,
        managedGroupIds,
      );

      // Final Fingerprinting (after all phases)
      const finalState = await this.refreshState(true);
      const finalHash = this.service.hashState(
        finalState.allTabs,
        finalState.groupIdToGroup,
      );

      this.lastAutoStateHash = finalHash;
      if (!options?.skipCleanup) {
        this.lastFullStateHash = finalHash;
      }

      this.adapter.updateBadge("");
    } catch (err) {
      console.warn("Execute error:", err);
    } finally {
      this.isProcessing = false;
    }
  }
}
