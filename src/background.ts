import {
  ConsolidationPlan,
  GroupId,
  GroupMap,
  GroupPlan,
  RulesByDomain,
  Tab,
  TabGroupingService,
  TabId,
  WindowId,
  WindowManagementService,
  asGroupId,
  asTabId,
  asWindowId,
  isDefined,
  isGrouped,
  ProtectedTabMetaMap,
} from "./utils/grouping.js";
import {
  GroupingConfig,
  SyncStoreState,
  validateRule,
} from "./utils/storage.js";

// @ts-ignore
import startSyncStore from "./utils/startSyncStore.js";

// ============================================================================
// TYPES
// ============================================================================

interface SyncStore {
  getState: () => Promise<SyncStoreState>;
}

interface BrowserState {
  allTabs: Tab[];
  groupIdToGroup: Map<number, chrome.tabGroups.TabGroup>;
}

type Result<T, E> = { success: true; value: T } | { success: false; error: E };

// ============================================================================
// UTILITIES
// ============================================================================

function debounce<T extends (...args: any[]) => any>(fn: T, delay: number) {
  let t: ReturnType<typeof setTimeout> | undefined;
  return (...args: Parameters<T>) => {
    if (t) clearTimeout(t);
    t = setTimeout(() => fn(...args), delay);
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function retry<T>(
  fn: () => Promise<T>,
  maxAttempts = 3,
  delayMs = 100,
): Promise<Result<T, Error>> {
  let lastError: any;
  for (let i = 1; i <= maxAttempts; i++) {
    try {
      return { success: true, value: await fn() };
    } catch (err) {
      lastError = err;
      if (i < maxAttempts) {
        console.warn(
          `[Retry] Attempt ${i}/${maxAttempts} failed, retrying in ${delayMs * i}ms...`,
        );
        await new Promise((r) => setTimeout(r, delayMs * i));
      }
    }
  }
  const finalError =
    lastError instanceof Error
      ? lastError
      : new Error(String(lastError || "Retry failed"));
  console.error(
    `[Retry] All ${maxAttempts} attempts failed. Final error:`,
    finalError.message,
    finalError.stack,
  );
  return { success: false, error: finalError };
}

async function bestEffortRollback(snapshotTabs: Tab[]): Promise<void> {
  console.warn("Rolling back (best-effort ungroup only)...");
  try {
    const current = new Map(
      (await chrome.tabs.query({})).map((t) => [t.id, t]),
    );
    for (const snap of snapshotTabs) {
      if (!snap.id) continue;
      const cur = current.get(snap.id);
      if (cur && snap.groupId !== cur.groupId && snap.groupId === -1)
        await chrome.tabs.ungroup([snap.id]).catch(() => {});
    }
  } catch (err) {
    console.error("Rollback failed:", err);
  }
}

/**
 * Higher-order utility to run an async operation with retry,
 * automatic rollback on failure, and success delay.
 */
async function runAtomicOperation<T>(
  operation: () => Promise<T>,
  snapshotTabs: Tab[],
  delayMs: number,
): Promise<T> {
  const res = await retry(operation);
  if (!res.success) {
    console.error(
      "Atomic operation failed, triggering rollback. Error:",
      res.error.message,
      res.error.stack,
    );
    await bestEffortRollback(snapshotTabs);
    throw res.error;
  }
  await sleep(delayMs);
  return res.value;
}

function validateTab(tab: any): tab is Tab {
  return (
    typeof tab === "object" &&
    tab !== null &&
    (tab.id === undefined || typeof tab.id === "number") &&
    (tab.url === undefined || typeof tab.url === "string")
  );
}

// ============================================================================
// INFRASTRUCTURE LAYER
// ============================================================================

export class ChromeTabAdapter {
  private readonly MAX_BATCH = 100;
  private readonly RATE_DELAY = 30;

  async getNormalTabs(): Promise<Tab[]> {
    const result = await retry(async () => {
      const tabs = await chrome.tabs.query({ windowType: "normal" });
      const selfBase = chrome.runtime.getURL(""); // e.g. chrome-extension://[id]/

      return tabs.filter((t) => {
        if (!validateTab(t) || !t.url) return false;

        // Exclude the extension's OWN internal pages (options/popup)
        if (t.url.startsWith(selfBase)) return false;

        // Exclude system/browser internal pages
        const internalProtocols = ["chrome:", "about:", "edge:", "brave:"];
        return !internalProtocols.some((p) => t.url!.startsWith(p));
      });
    });
    if (!result.success) {
      console.error("Failed to get tabs:", result.error);
      return [];
    }
    return result.value;
  }

  async deduplicateAllTabs(tabs: Tab[]): Promise<Tab[]> {
    const seen = new Set<string>();
    const unique: Tab[] = [];
    const dupes: TabId[] = [];

    for (const tab of tabs) {
      if (tab.url && !seen.has(tab.url)) {
        seen.add(tab.url);
        unique.push(tab);
      } else if (tab.id) {
        dupes.push(asTabId(tab.id)!);
      } else {
        unique.push(tab);
      }
    }

    for (const batch of this.batch(dupes)) {
      const r = await retry(() => chrome.tabs.remove(batch as number[]));
      if (!r.success) console.warn("Failed to remove duplicates:", r.error);
      await sleep(this.RATE_DELAY);
    }

    return unique;
  }

  async cleanupTabsByRules(
    tabs: Tab[],
    rulesByDomain: RulesByDomain,
    service: TabGroupingService,
  ): Promise<Tab[]> {
    const toDelete: TabId[] = [];
    const remaining: Tab[] = [];

    for (const tab of tabs) {
      const domain = service.getDomain(tab.url);
      const rule = rulesByDomain[domain];

      if (rule?.autoDelete && tab.id) {
        toDelete.push(asTabId(tab.id)!);
      } else {
        remaining.push(tab);
      }
    }

    for (const batch of this.batch(toDelete)) {
      const r = await retry(() => chrome.tabs.remove(batch as number[]));
      if (!r.success) console.warn("Failed to auto-delete:", r.error);
      await sleep(this.RATE_DELAY);
    }

    return remaining;
  }

  async ungroupSingleTabGroups(tabs: Tab[]): Promise<void> {
    const groupCounts = new Map<number, number>();
    for (const tab of tabs) {
      if (tab.groupId !== -1 && tab.groupId !== undefined) {
        groupCounts.set(tab.groupId, (groupCounts.get(tab.groupId) || 0) + 1);
      }
    }

    const toUngroup: number[] = [];
    for (const tab of tabs) {
      if (tab.id && tab.groupId !== -1 && tab.groupId !== undefined) {
        if (groupCounts.get(tab.groupId) === 1) {
          toUngroup.push(tab.id);
        }
      }
    }

    for (const batch of this.batch(toUngroup)) {
      if (batch.length === 0) continue;
      await retry(() =>
        chrome.tabs.ungroup(
          batch.length === 1 ? batch[0] : (batch as [number, ...number[]]),
        ),
      );
      await sleep(this.RATE_DELAY);
    }
  }

  async executeConsolidationPlan(
    plan: ConsolidationPlan,
    snapshotTabs: Tab[],
  ): Promise<Result<void, Error>> {
    try {
      // 1. Move Groups
      for (const gm of plan.groupMoves) {
        await runAtomicOperation(
          () =>
            chrome.tabGroups.move(gm.groupId, {
              windowId: gm.windowId,
              index: -1,
            }),
          snapshotTabs,
          this.RATE_DELAY,
        );
      }

      // 2. Move Individual Tabs
      for (const tm of plan.tabMoves) {
        await runAtomicOperation(
          () =>
            chrome.tabs.move(tm.tabIds, { windowId: tm.windowId, index: -1 }),
          snapshotTabs,
          this.RATE_DELAY,
        );
      }

      return { success: true, value: undefined };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err : new Error(String(err)),
      };
    }
  }

  async executeGroupPlan(
    plan: GroupPlan,
    protectedMeta: ProtectedTabMetaMap,
    targetWindowId?: number,
    snapshotOverride?: { tabs: Tab[]; groups: chrome.tabGroups.TabGroup[] },
  ): Promise<Result<void, Error>> {
    const snapshot = snapshotOverride || (await this.captureState());
    const titlesToUpdate = new Map<number, string>();

    try {
      // 0. Ungroup tabs explicitly requested
      if (plan.tabsToUngroup.length > 0) {
        const freshTabIds = new Set(snapshot.tabs.map((t) => asTabId(t.id)));
        const validUngroup = plan.tabsToUngroup.filter((id) =>
          freshTabIds.has(id),
        );

        if (validUngroup.length > 0) {
          await runAtomicOperation(
            () =>
              chrome.tabs.ungroup(
                validUngroup.length === 1
                  ? (validUngroup[0] as number)
                  : (validUngroup as unknown as [number, ...number[]]),
              ),
            snapshot.tabs,
            this.RATE_DELAY,
          );
        }
      }

      const freshTabs = new Map(snapshot.tabs.map((t) => [asTabId(t.id)!, t]));
      const freshGroups = new Map(snapshot.groups.map((g) => [g.id, g]));

      for (const state of plan.states) {
        // 1. Block Move Optimization (Still useful for performance, but no lazy checks)
        if (state.groupId && (state.isExternal || state.tabIds.length >= 2)) {
          const group = freshGroups.get(state.groupId as number);
          if (group) {
            const groupTabs = snapshot.tabs.filter(
              (t) => t.groupId === state.groupId,
            );
            const currentIds = new Set(groupTabs.map((t) => asTabId(t.id)));
            const isMatch =
              groupTabs.length === state.tabIds.length &&
              state.tabIds.every((id) => currentIds.has(id));

            if (isMatch) {
              await runAtomicOperation(
                () =>
                  chrome.tabGroups.move(state.groupId as number, {
                    windowId: targetWindowId,
                    index: state.targetIndex,
                  }),
                snapshot.tabs,
                this.RATE_DELAY,
              );

              // Queue title update for moved group
              const targetTitle =
                state.displayName ||
                (state.isExternal ? "" : state.sourceDomain || "Managed Group");
              titlesToUpdate.set(state.groupId as number, targetTitle);
              continue;
            }
          }
        }

        // 2. Prepare for Move: Handle Ungrouping (only if target is NO GROUP)
        if (
          state.groupId === null &&
          !(state.isExternal || state.tabIds.length >= 2)
        ) {
          const toUngroup = state.tabIds.filter((id) => {
            const t = freshTabs.get(id);
            return t && isGrouped(t);
          });
          if (toUngroup.length > 0) {
            await runAtomicOperation(
              () =>
                chrome.tabs.ungroup(
                  toUngroup.length === 1
                    ? (toUngroup[0] as number)
                    : (toUngroup as unknown as [number, ...number[]]),
                ),
              snapshot.tabs,
              this.RATE_DELAY,
            );
          }
        }

        // 3. Move Tabs (Atomic block)
        if (state.tabIds.length > 0) {
          await runAtomicOperation(
            () =>
              chrome.tabs.move(state.tabIds as unknown as number[], {
                windowId: targetWindowId,
                index: state.targetIndex,
              }),
            snapshot.tabs,
            this.RATE_DELAY,
          );
        }

        // 4. Ensure Grouping & Title update only if needed
        const shouldGroup =
          state.groupId !== null ||
          state.isExternal ||
          state.tabIds.length >= 2;

        if (shouldGroup) {
          await runAtomicOperation(
            async () => {
              const ids = state.tabIds as unknown as number[];
              const options: chrome.tabs.GroupOptions = {
                tabIds:
                  ids.length === 1 ? ids[0] : (ids as [number, ...number[]]),
              };
              if (state.groupId !== null) {
                options.groupId = state.groupId as number;
              }

              const gid = await chrome.tabs.group(options);
              const targetTitle =
                state.displayName ||
                (state.isExternal ? "" : state.sourceDomain || "Managed Group");

              if (targetTitle || state.groupId === null) {
                titlesToUpdate.set(gid, targetTitle || "Managed Group");
              }
              return gid;
            },
            snapshot.tabs,
            this.RATE_DELAY,
          );
        }
      }

      // Final Phase: Apply all collected title updates after layout is stable
      for (const [gid, title] of titlesToUpdate) {
        const r = await retry(() =>
          chrome.tabGroups.update(gid, { title, collapsed: false }),
        );
        if (!r.success)
          console.warn(
            `[Warning] Failed to update title for group ${gid}:`,
            r.error,
          );
      }

      // Mandate: Final cleanup pass to ungroup any groups that have only a single tab.
      // This handles cases where groups were left with 1 tab after moves/evictions.
      const finalState = await this.captureState();
      const groupCounts = new Map<number, number>();
      for (const t of finalState.tabs) {
        if (isGrouped(t)) {
          groupCounts.set(t.groupId!, (groupCounts.get(t.groupId!) || 0) + 1);
        }
      }

      const toUngroupIds: number[] = [];
      for (const t of finalState.tabs) {
        if (!t.id || !isGrouped(t)) continue;
        const tid = asTabId(t.id)!;
        const isSingle = groupCounts.get(t.groupId!) === 1;
        
        // Use the passed-in protectedMeta instead of recalculating
        const isProtected = protectedMeta.has(tid);
        if (isSingle && !isProtected) {
          toUngroupIds.push(t.id);
        }
      }

      if (toUngroupIds.length > 0) {
        await retry(() =>
          chrome.tabs.ungroup(
            toUngroupIds.length === 1
              ? toUngroupIds[0]
              : (toUngroupIds as [number, ...number[]]),
          ),
        );
      }

      return { success: true, value: undefined };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err : new Error(String(err)),
      };
    }
  }

  async updateBadge(service: TabGroupingService): Promise<void> {
    try {
      const tabs = await this.getNormalTabs();
      const count = service.countDuplicates(tabs);
      if (count > 0) {
        chrome.action.setBadgeText({ text: count.toString() });
        chrome.action.setBadgeBackgroundColor({ color: "#9688F1" });
      } else {
        chrome.action.setBadgeText({ text: "" });
      }
    } catch (err) {
      console.warn("Failed to update badge accurately:", err);
    }
  }

  private batch<T>(arr: readonly T[]): T[][] {
    const out: T[][] = [];
    for (let i = 0; i < arr.length; i += this.MAX_BATCH)
      out.push(arr.slice(i, i + this.MAX_BATCH) as T[]);
    return out;
  }

  private async captureState() {
    const [tabs, groups] = await Promise.all([
      chrome.tabs.query({}),
      chrome.tabGroups.query({}),
    ]);
    return { tabs, groups };
  }
}

// ============================================================================
// APPLICATION LAYER
// ============================================================================

export class TabGroupingController {
  private isProcessing = false;
  private lastStateHash: string | null = null;
  private service = new TabGroupingService();
  private windowService = new WindowManagementService();
  private adapter = new ChromeTabAdapter();

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
    rulesByDomain: RulesByDomain,
    windowId?: WindowId,
  ): Promise<Result<void, Error>> {
    try {
      const groupsByTitle = new Map<string, GroupId>();
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
        groupsByTitle,
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
      return this.adapter.executeGroupPlan(
        plan,
        protectedMeta,
        windowId,
        {
          tabs: allTabs,
          groups: Array.from(groupIdToGroup.values()),
        },
      );
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
        rulesByDomain,
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

// ============================================================================
// EVENT HANDLERS
// ============================================================================

const controller = new TabGroupingController();

export function init() {
  const service = new TabGroupingService();
  const adapter = new ChromeTabAdapter();
  const debouncedUpdateBadge = debounce(
    () => adapter.updateBadge(service),
    300,
  );

  chrome.action.onClicked.addListener(() => controller.execute());
  chrome.tabs.onCreated.addListener(debouncedUpdateBadge);
  chrome.tabs.onRemoved.addListener(debouncedUpdateBadge);
  chrome.tabs.onUpdated.addListener(debouncedUpdateBadge);
}

if (typeof process === "undefined" || process.env.NODE_ENV !== "test") {
  init();
}
