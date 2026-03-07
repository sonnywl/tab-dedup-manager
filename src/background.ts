import {
  CacheManager,
  GroupId,
  GroupMap,
  GroupPlan,
  ProtectedTabMetaMap,
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
} from "./utils/grouping.js";
import {
  GroupingConfig,
  SyncStoreState,
  validateRule,
} from "./utils/storage.js";

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

const TAB_UPDATE_DELAY = 50;

async function retry<T>(
  fn: () => Promise<T>,
  maxAttempts = 3,
  delayMs = 100,
): Promise<Result<T, Error>> {
  for (let i = 1; i <= maxAttempts; i++) {
    try {
      return { success: true, value: await fn() };
    } catch (err) {
      if (i === maxAttempts)
        return {
          success: false,
          error: err instanceof Error ? err : new Error(String(err)),
        };
      await new Promise((r) => setTimeout(r, delayMs * i));
    }
  }
  return { success: false, error: new Error("Retry failed") };
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
  private readonly RATE_DELAY = 50;

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

  async executeGroupPlan(
    plan: GroupPlan,
    _initialCache: ReadonlyMap<TabId, Tab>,
    existingGroups: Map<number, chrome.tabGroups.TabGroup>,
    targetWindowId?: number,
    snapshotOverride?: { tabs: Tab[]; groups: chrome.tabGroups.TabGroup[] },
  ): Promise<Result<void, Error>> {
    const snapshot = snapshotOverride || (await this.captureState());

    try {
      // 0. Ungroup tabs explicitly requested
      if (plan.tabsToUngroup.length > 0) {
        const freshTabIds = new Set(snapshot.tabs.map((t) => asTabId(t.id)));
        const validUngroup = plan.tabsToUngroup.filter((id) =>
          freshTabIds.has(id),
        );

        if (validUngroup.length > 0) {
          await runAtomicOperation(
            () => chrome.tabs.ungroup(validUngroup as number[]),
            snapshot.tabs,
            this.RATE_DELAY,
          );
        }
      }

      const freshTabs = new Map(snapshot.tabs.map((t) => [asTabId(t.id)!, t]));
      const freshGroups = new Map(snapshot.groups.map((g) => [g.id, g]));

      for (const state of plan.states) {
        // 1. Block Move Optimization
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
              // Lazy Check: Is the group already at its target index and window?
              const firstTabInGroup = snapshot.tabs.find(
                (t) => t.id === state.tabIds[0],
              );

              const isCorrectWindow =
                !targetWindowId ||
                (firstTabInGroup &&
                  firstTabInGroup.windowId === targetWindowId);
              const isCorrectIndex =
                firstTabInGroup && firstTabInGroup.index === state.targetIndex;

              if (isCorrectWindow && isCorrectIndex) {
                continue;
              }

              await runAtomicOperation(
                () =>
                  chrome.tabGroups.move(state.groupId as number, {
                    windowId: targetWindowId,
                    index: state.targetIndex,
                  }),
                snapshot.tabs,
                this.RATE_DELAY,
              );
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
              () => chrome.tabs.ungroup(toUngroup as number[]),
              snapshot.tabs,
              this.RATE_DELAY,
            );
          }
        }

        // 3. Move Tabs (Atomic block)
        if (state.tabIds.length > 0) {
          // Optimization: Check if the first tab is already at the target index and window.
          const firstTab = snapshot.tabs.find((t) => t.id === state.tabIds[0]);

          const isCorrectWindow =
            !targetWindowId ||
            (firstTab && firstTab.windowId === targetWindowId);
          const isCorrectIndex =
            firstTab && firstTab.index === state.targetIndex;

          if (isCorrectWindow && isCorrectIndex) {
            // Already correct, skip this move
          } else {
            await runAtomicOperation(
              () =>
                chrome.tabs.move(state.tabIds as number[], {
                  windowId: targetWindowId,
                  index: state.targetIndex,
                }),
              snapshot.tabs,
              this.RATE_DELAY,
            );
          }
        }

        // 4. Ensure Grouping & Title update only if needed
        const shouldGroup =
          state.groupId !== null ||
          state.isExternal ||
          state.tabIds.length >= 2;

        if (shouldGroup) {
          await runAtomicOperation(
            async () => {
              const options: chrome.tabs.GroupOptions = {
                tabIds: state.tabIds as number[],
              };
              if (state.groupId !== null) {
                options.groupId = state.groupId as number;
              }

              const gid = await chrome.tabs.group(options);
              const currentGroup =
                freshGroups.get(gid) || existingGroups.get(gid);

              // Wait for Chrome to register the group creation before updating
              await sleep(TAB_UPDATE_DELAY);

              // Update title ONLY if requested, if current title is empty, or if it's a new group (not in snapshot)
              const needsUpdate =
                state.needsTitleUpdate || !currentGroup || !currentGroup.title;

              if (needsUpdate) {
                const targetTitle =
                  state.displayName ||
                  (state.isExternal
                    ? ""
                    : state.sourceDomain || "Managed Group");
                if (targetTitle) {
                  await chrome.tabGroups.update(gid, {
                    collapsed: false,
                    title: targetTitle,
                  });
                }
              }
              return gid;
            },
            snapshot.tabs,
            this.RATE_DELAY,
          );
        }
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
    activeWindowId: number | undefined,
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
      activeWindowId,
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
    groupMap: GroupMap,
    managedGroupIds: Map<number, string>,
    groupIdToGroup: Map<number, chrome.tabGroups.TabGroup>,
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

      const cache = new CacheManager(allTabs);

      // Pipeline:
      // 1. Virtual Mapping: Build initial group states based on current tab distribution and group ownership
      const groupStates = this.service.buildGroupStates(
        groupMap,
        cache.snapshot(),
        groupsByTitle,
        managedGroupIds,
        windowId,
      );

      // 2. Reposition Needs: Calculate which groups need physical changes (repositioning, regrouping, or title updates)
      const withReposition = this.service.calculateRepositionNeeds(
        groupStates,
        cache.snapshot(),
        windowId,
        managedGroupIds,
      );

      // 3. Plan Creation: Create a concrete plan of physical actions (moves, groups, ungroups)
      const plan = this.service.createGroupPlan(
        withReposition,
        cache.snapshot(),
        managedGroupIds,
        windowId,
      );

      if (plan.states.length === 0 && plan.tabsToUngroup.length === 0) {
        return { success: true, value: undefined };
      }

      // 4. Surgical Execution: Execute the plan atomically
      const [freshTabs, freshGroups] = await Promise.all([
        this.adapter.getNormalTabs(),
        chrome.tabGroups.query({}),
      ]);

      return this.adapter.executeGroupPlan(
        plan,
        cache.snapshot(),
        groupIdToGroup,
        windowId,
        { tabs: freshTabs, groups: freshGroups },
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
      grouping: { byWindow: false, numWindowsToKeep: 2 },
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
      },
    };
  }

  private async prepareTabs(
    tabs: Tab[],
    rulesByDomain: RulesByDomain,
    protectedTabMeta: ProtectedTabMetaMap = new Map(),
  ): Promise<Tab[]> {
    const unique = await this.adapter.deduplicateAllTabs(tabs);
    const cleaned = await this.adapter.cleanupTabsByRules(
      unique,
      rulesByDomain,
      this.service,
    );

    return [...cleaned].sort((a, b) => {
      const aId = asTabId(a.id);
      const bId = asTabId(b.id);
      const aProt =
        aId &&
        protectedTabMeta &&
        typeof protectedTabMeta.has === "function" &&
        protectedTabMeta.has(aId)
          ? 1
          : 0;
      const bProt =
        bId &&
        protectedTabMeta &&
        typeof protectedTabMeta.has === "function" &&
        protectedTabMeta.has(bId)
          ? 1
          : 0;

      if (aProt !== bProt) return bProt - aProt; // Protected first
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1; // Pinned first
      return (a.id ?? 0) - (b.id ?? 0); // Stability
    });
  }

  private async consolidateWindows(
    tabs: Tab[],
    numWindowsToKeep: number,
    protectedTabMeta: ProtectedTabMetaMap,
    managedGroupIds: Map<number, string>,
  ): Promise<Map<WindowId, Tab[]>> {
    const windowGroups = await this.groupByWindow(tabs);
    const entries = Array.from(windowGroups.entries()).sort(
      (a, b) => b[1].length - a[1].length,
    );
    if (entries.length <= numWindowsToKeep) return windowGroups;

    const retained = new Map(entries.slice(0, numWindowsToKeep));
    const excess = entries.slice(numWindowsToKeep).flatMap((e) => e[1]);
    const mergePlan = this.windowService.calculateMergePlan(
      retained,
      excess,
      this.service,
      protectedTabMeta,
      managedGroupIds,
    );

    // Build the final map by adding excess tabs to their target windows
    const result = new Map<WindowId, Tab[]>(retained);
    const tabsById = new Map(tabs.map((t) => [asTabId(t.id)!, t]));

    for (const [wid, tabIds] of mergePlan) {
      const targetWid = asWindowId(wid as number);
      const targetWindowTabs = result.get(targetWid) || [];
      const incomingTabs = tabIds
        .map((id) => {
          const t = tabsById.get(id);
          // Clone and update windowId to reflect its intended destination
          return t ? { ...t, windowId: targetWid } : undefined;
        })
        .filter(isDefined);

      result.set(targetWid, [...targetWindowTabs, ...incomingTabs]);
    }

    return result;
  }

  async execute(): Promise<void> {
    if (this.isProcessing) return;
    this.isProcessing = true;

    try {
      const config = await this.loadConfiguration();
      if (!config) return;
      const { rulesByDomain, config: groupingConfig } = config;

      let state = await this.captureBrowserState();
      const activeWindow = await chrome.windows.getCurrent();
      let activeWindowId =
        activeWindow.type === "normal" ? activeWindow.id : undefined;

      // Ensure we have a valid target window for global grouping
      if (activeWindowId === undefined) {
        const allWindows = await chrome.windows.getAll({
          windowTypes: ["normal"],
        });
        activeWindowId = allWindows[0]?.id
          ? asWindowId(allWindows[0].id)
          : undefined;
      }

      if (activeWindowId === undefined) {
        console.warn("No normal windows found to group tabs in.");
        return;
      }

      // 1. Identify Protected Tabs (External groups)
      const { protectedMeta, managedGroupIds } =
        this.service.identifyProtectedTabs(
          state.allTabs,
          state.groupIdToGroup,
          rulesByDomain,
        );

      const hash = this.stateHash(
        state.allTabs,
        rulesByDomain,
        groupingConfig,
        activeWindowId,
      );
      if (this.lastStateHash === hash) {
        console.log("No state changes, skipping...");
        return;
      }

      // 2. Prepare Tabs (Deduplication, Auto-Delete, and Sort Stability)
      const processed = await this.prepareTabs(
        state.allTabs,
        rulesByDomain,
        protectedMeta,
      );

      // 3. Window Consolidation & Mapping (Unified)
      const windowMap = groupingConfig.byWindow
        ? isDefined(groupingConfig.numWindowsToKeep)
          ? await this.consolidateWindows(
              processed,
              groupingConfig.numWindowsToKeep,
              protectedMeta,
              managedGroupIds,
            )
          : await this.groupByWindow(processed)
        : new Map([[asWindowId(activeWindowId), processed]]);

      // 4. Grouping Pass
      for (const [wid, tabs] of windowMap) {
        const groupMap = this.service.buildGroupMap(
          tabs,
          rulesByDomain,
          state.groupIdToGroup,
          protectedMeta,
        );
        await this.processGrouping(
          state.allTabs,
          groupMap,
          managedGroupIds,
          state.groupIdToGroup,
          wid,
        );
      }

      const finalState = await this.captureBrowserState();
      this.lastStateHash = this.stateHash(
        finalState.allTabs,
        rulesByDomain,
        groupingConfig,
        activeWindowId,
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
