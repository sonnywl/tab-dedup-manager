import {
  CacheManager,
  GroupId,
  GroupMap,
  GroupPlan,
  GroupState,
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
  extractTabIds,
  isDefined,
  isGrouped,
} from "./utils/grouping.js";
import {
  GroupingConfig,
  SyncStoreState,
  validateRule,
} from "./utils/storage.js";

import startSyncStore from "./utils/startSyncStore.js";

export { CacheManager, TabGroupingService, WindowManagementService };

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
      return tabs.filter((t) => validateTab(t) && t.url);
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
    protectedTabMeta: ProtectedTabMetaMap = new Map(),
  ): Promise<Tab[]> {
    const toDelete: TabId[] = [];
    const remaining: Tab[] = [];

    for (const tab of tabs) {
      const tabId = asTabId(tab.id);
      const domain = service.getDomain(tab.url);
      const rule = rulesByDomain[domain];

      if (tabId && protectedTabMeta.has(tabId)) {
        remaining.push(tab);
        continue;
      }

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

  /**
   * Senior Mandate: Move tabs and immediately reconstruct manual groups.
   */
  async moveTabsAtomic(
    tabIds: TabId[],
    targetWindowId: number,
    protectedTabMeta: ProtectedTabMetaMap,
  ): Promise<void> {
    if (tabIds.length === 0) return;

    // 1. Fetch current tab states to identify groups
    const tabs = await Promise.all(
      tabIds.map((id) =>
        retry(() => chrome.tabs.get(id as number), 2, 50).then((r) =>
          r.success ? r.value : null,
        ),
      ),
    ).then((results) => results.filter(isDefined));

    const tabsByGroup = new Map<number, Tab[]>();
    const ungroupedIds: number[] = [];

    for (const tab of tabs) {
      if (isGrouped(tab)) {
        if (!tabsByGroup.has(tab.groupId!)) tabsByGroup.set(tab.groupId!, []);
        tabsByGroup.get(tab.groupId!)!.push(tab);
      } else {
        if (tab.id) ungroupedIds.push(tab.id);
      }
    }

    // 2. Identify groups that can be moved as a whole
    const groupsToMove: number[] = [];
    const individualTabIds: number[] = [...ungroupedIds];

    for (const [gid, groupTabsInList] of tabsByGroup.entries()) {
      const allTabsInGroup = await chrome.tabs.query({ groupId: gid });
      const isFullGroupMove = allTabsInGroup.every((gt) =>
        tabIds.includes(asTabId(gt.id)!),
      );

      if (isFullGroupMove) {
        groupsToMove.push(gid);
      } else {
        for (const t of groupTabsInList) if (t.id) individualTabIds.push(t.id);
      }
    }

    // 3. Execute Moves
    // Move whole groups first to preserve their structure
    for (const gid of groupsToMove) {
      const r = await retry(() =>
        chrome.tabGroups.move(gid, { windowId: targetWindowId, index: -1 }),
      );
      if (!r.success) console.warn(`Failed to move group ${gid}:`, r.error);
      await sleep(this.RATE_DELAY);
    }

    // Move individual tabs (will be ungrouped if they were part of a split group)
    if (individualTabIds.length > 0) {
      for (const batch of this.batch(individualTabIds)) {
        const r = await retry(() =>
          chrome.tabs.move(batch, {
            windowId: targetWindowId,
            index: -1,
          }),
        );
        if (!r.success)
          console.warn(`Failed to move tabs to ${targetWindowId}:`, r.error);
        await sleep(this.RATE_DELAY);
      }
    }

    // 4. Re-bundle manual groups (only those not moved as whole groups)
    const groupsToRebuild = new Map<number, { title: string; ids: TabId[] }>();
    const movedGroupIds = new Set(groupsToMove);

    for (const id of tabIds) {
      const meta = protectedTabMeta.get(id);
      if (meta && !movedGroupIds.has(meta.originalGroupId)) {
        if (!groupsToRebuild.has(meta.originalGroupId)) {
          groupsToRebuild.set(meta.originalGroupId, {
            title: meta.title,
            ids: [],
          });
        }
        groupsToRebuild.get(meta.originalGroupId)!.ids.push(id);
      }
    }

    for (const [_, { title, ids }] of groupsToRebuild) {
      await retry(async () => {
        const gid = await chrome.tabs.group({ tabIds: ids as number[] });
        await chrome.tabGroups.update(gid, { collapsed: false, title });
        return gid;
      });
      await sleep(this.RATE_DELAY);
    }
  }

  async applyGroupState(
    state: GroupState,
    tabCache: ReadonlyMap<TabId, Tab>,
    groupMap?: Map<number, chrome.tabGroups.TabGroup>,
  ): Promise<GroupState> {
    if (state.tabIds.length === 0) return state;

    // Mandate: Manual groups are always preserved (even 1 tab). Managed groups need 2.
    if (!state.isExternal && state.tabIds.length < 2) {
      if (state.groupId !== null) await this.handleSingleTab(state, tabCache);
      return state;
    }

    return this.handleMultiTabGroup(state, tabCache, groupMap);
  }

  private async handleSingleTab(
    state: GroupState,
    tabCache: ReadonlyMap<TabId, Tab>,
  ): Promise<void> {
    if (state.groupId === null || state.tabIds.length === 0) return;
    const tabs = state.tabIds.map((id) => tabCache.get(id)).filter(isDefined);
    if (tabs.every((t) => !isGrouped(t))) return;
    const r = await retry(() => chrome.tabs.ungroup(state.tabIds as number[]));
    if (!r.success)
      console.warn(`Failed to ungroup single tab ${state.title}:`, r.error);
  }

  private async handleMultiTabGroup(
    state: GroupState,
    tabCache: ReadonlyMap<TabId, Tab>,
    groupMap?: Map<number, chrome.tabGroups.TabGroup>,
  ): Promise<GroupState> {
    const tabs = state.tabIds.map((id) => tabCache.get(id)).filter(isDefined);

    if (state.groupId === null) {
      const r = await retry(() =>
        chrome.tabs.group({ tabIds: state.tabIds as number[] }),
      );
      if (!r.success) {
        console.error(`[G4] Failed to create group "${state.title}":`, r.error);
        return state;
      }
      await retry(() =>
        chrome.tabGroups.update(r.value, {
          collapsed: false,
          title: state.title,
        }),
      );
      return { ...state, groupId: asGroupId(r.value) };
    }

    const group = groupMap?.get(state.groupId as number);
    if (
      tabs.every((t) => t.groupId === state.groupId) &&
      group?.title === state.title
    )
      return state;

    const wrongGroup = state.tabIds.filter((id) => {
      const t = tabCache.get(id);
      return t && t.groupId !== state.groupId && isGrouped(t);
    });
    if (wrongGroup.length > 0)
      await retry(() => chrome.tabs.ungroup(wrongGroup as number[]));

    const r = await retry(() =>
      chrome.tabs.group({
        groupId: state.groupId as number,
        tabIds: state.tabIds as number[],
      }),
    );
    if (!r.success) {
      console.warn(
        `[G4] Stale groupId ${state.groupId} for "${state.title}" — aborting, will regroup next cycle`,
      );
      return state;
    }

    if (!group || group.title !== state.title)
      await retry(() =>
        chrome.tabGroups.update(state.groupId as number, {
          collapsed: false,
          title: state.title,
        }),
      );

    return state;
  }

  async executeGroupPlan(
    plan: GroupPlan,
    _initialCache: ReadonlyMap<TabId, Tab>,
    existingGroups: Map<number, chrome.tabGroups.TabGroup>,
  ): Promise<Result<void, Error>> {
    const snapshot = await this.captureState();

    try {
      // 0. Ungroup tabs explicitly requested
      if (plan.tabsToUngroup.length > 0) {
        await runAtomicOperation(
          () => chrome.tabs.ungroup(plan.tabsToUngroup as number[]),
          snapshot.tabs,
          this.RATE_DELAY,
        );
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
            const isMatch =
              groupTabs.length === state.tabIds.length &&
              groupTabs.every((t, i) => asTabId(t.id) === state.tabIds[i]);

            if (isMatch) {
              await runAtomicOperation(
                () =>
                  chrome.tabGroups.move(state.groupId as number, {
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
        if (state.groupId === null) {
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
          await runAtomicOperation(
            () =>
              chrome.tabs.move(state.tabIds as number[], {
                index: state.targetIndex,
              }),
            snapshot.tabs,
            this.RATE_DELAY,
          );
        }

        // 4. Ensure Grouping & Title
        // If state.groupId is null, we might still need to create a group
        // (e.g. for external groups re-created, or new managed groups).
        const shouldGroup =
          state.groupId !== null ||
          state.isExternal ||
          state.tabIds.length >= 2;

        if (shouldGroup) {
          await runAtomicOperation(
            async () => {
              // This handles adding ungrouped tabs, stealing from other groups, and merging
              const options: chrome.tabs.GroupOptions = {
                tabIds: state.tabIds as number[],
              };
              if (state.groupId !== null) {
                options.groupId = state.groupId as number;
              }

              const gid = await chrome.tabs.group(options);

              const currentGroup =
                freshGroups.get(gid) || existingGroups.get(gid);

              // Update title/color if:
              // 1. It's a new group (currentGroup might be undefined or just created)
              // 2. The title mismatch (and it's not external/manual where we preserve titles?
              //    Actually, if isExternal is true, we WANT to restore the title "state.displayName")
              // 3. Managed group title update.

              // Note: For external groups, state.displayName is the restored title.
              // For managed groups, state.displayName is the generated title.

              const titleMismatch =
                !currentGroup || currentGroup.title !== state.displayName;

              if (titleMismatch) {
                await chrome.tabGroups.update(gid, {
                  collapsed: false,
                  title: state.displayName,
                  color: state.color,
                });
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

  async getGroupsInWindow(
    windowId: number,
  ): Promise<chrome.tabGroups.TabGroup[]> {
    return (await chrome.tabGroups.query({ windowId })) || [];
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
    protectedTabMeta: ProtectedTabMetaMap,
    managedGroupIds: Map<number, string>,
    windowId?: WindowId,
  ): Promise<Result<void, Error>> {
    try {
      const scoped = windowId
        ? allTabs.filter((t) => t.windowId === windowId)
        : allTabs;
      const cache = new CacheManager(scoped);

      const groupsByTitle = new Map<string, GroupId>();
      const currentGroups = await this.adapter.getGroupsInWindow(
        windowId || (await chrome.windows.getCurrent()).id!,
      );
      const groupIdToGroup = new Map(currentGroups.map((g) => [g.id, g]));
      for (const g of currentGroups) {
        if (g.title) groupsByTitle.set(g.title, asGroupId(g.id));
      }

      const missingIds = Array.from(groupMap.values())
        .flatMap((e) => extractTabIds(e.tabs))
        .filter((id) => !cache.has(id));
      if (missingIds.length > 0) {
        const { missing } = await cache.refresh(missingIds, (fn) => retry(fn));
        if (missing.length > 0)
          console.warn(`[G8] ${missing.length} tab(s) unrecoverable — skipped`);
      }

      const groupStates = this.service.buildGroupStates(
        groupMap,
        cache.snapshot(),
        groupsByTitle,
        managedGroupIds,
      );

      const applyResults = await Promise.allSettled(
        groupStates.map((s) =>
          this.adapter.applyGroupState(s, cache.snapshot(), groupIdToGroup),
        ),
      );

      const updatedGroupStates: GroupState[] = [];
      for (let i = 0; i < applyResults.length; i++) {
        const r = applyResults[i];
        updatedGroupStates.push(
          r.status === "fulfilled" ? r.value : groupStates[i],
        );
      }

      const withReposition = this.service.calculateRepositionNeeds(
        updatedGroupStates,
        cache.snapshot(),
      );

      const plan = this.service.createGroupPlan(
        withReposition,
        cache.snapshot(),
        managedGroupIds,
      );

      if (plan.states.length === 0 && plan.tabsToUngroup.length === 0) {
        return { success: true, value: undefined };
      }

      return this.adapter.executeGroupPlan(
        plan,
        cache.snapshot(),
        groupIdToGroup,
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
      grouping: { byWindow: false },
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
    for (const r of valid) if (r.domain.length > 0) rulesByDomain[r.domain] = r;

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
    protectedTabMeta: ProtectedTabMetaMap,
  ): Promise<Tab[]> {
    // 1. Unique (on ALL tabs)
    const unique = await this.adapter.deduplicateAllTabs(tabs);

    // 2. Cleanup (respects protectedTabMeta internally)
    const cleaned = await this.adapter.cleanupTabsByRules(
      unique,
      rulesByDomain,
      this.service,
      protectedTabMeta,
    );

    // 3. Sorting (the result)
    return [...cleaned].sort((a, b) => {
      const aId = asTabId(a.id);
      const bId = asTabId(b.id);
      const aProt = aId && protectedTabMeta.has(aId) ? 1 : 0;
      const bProt = bId && protectedTabMeta.has(bId) ? 1 : 0;

      if (aProt !== bProt) return bProt - aProt; // Protected first
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1; // Pinned first
      return (a.id ?? 0) - (b.id ?? 0); // Stability
    });
  }

  private async consolidateWindows(
    tabs: Tab[],
    numWindowsToKeep: number,
    protectedTabMeta: ProtectedTabMetaMap,
  ): Promise<Map<WindowId, Tab[]>> {
    const windowGroups = await this.groupByWindow(tabs);
    const entries = Array.from(windowGroups.entries()).sort(
      (a, b) => b[1].length - a[1].length,
    );
    if (entries.length <= numWindowsToKeep) return windowGroups;

    const retained = new Map(entries.slice(0, numWindowsToKeep));
    const excess = entries.slice(numWindowsToKeep).flatMap((e) => e[1]);
    const plan = this.windowService.calculateMergePlan(
      retained,
      excess,
      this.service,
      protectedTabMeta,
    );

    for (const [wid, tabIds] of plan) {
      await this.adapter.moveTabsAtomic(
        tabIds,
        wid as number,
        protectedTabMeta,
      );
    }

    const fresh = await this.captureBrowserState();
    const retainedIds = new Set(retained.keys());
    const rebuilt = new Map<WindowId, Tab[]>();
    for (const tab of fresh.allTabs) {
      if (!tab.windowId) continue;
      const wid = asWindowId(tab.windowId);
      if (!retainedIds.has(wid)) continue;
      if (!rebuilt.has(wid)) rebuilt.set(wid, []);
      rebuilt.get(wid)!.push(tab);
    }
    return rebuilt;
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
      const activeWindowId =
        activeWindow.type === "normal" ? activeWindow.id : undefined;
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

      // 1. Global Merging
      if (!groupingConfig.byWindow) {
        await this.adapter.moveTabsAtomic(
          extractTabIds(state.allTabs),
          activeWindowId || 1,
          protectedMeta,
        );
        state = await this.captureBrowserState();
      }

      const processed = await this.prepareTabs(
        state.allTabs,
        rulesByDomain,
        protectedMeta,
      );

      // 2. Window Consolidation & Grouping
      if (groupingConfig.byWindow) {
        const windowMap = isDefined(groupingConfig.numWindowsToKeep)
          ? await this.consolidateWindows(
              processed,
              groupingConfig.numWindowsToKeep,
              protectedMeta,
            )
          : await this.groupByWindow(processed);

        state = await this.captureBrowserState();
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
            protectedMeta,
            managedGroupIds,
            wid,
          );
        }
      } else {
        const groupMap = this.service.buildGroupMap(
          processed,
          rulesByDomain,
          state.groupIdToGroup,
          protectedMeta,
        );
        state = await this.captureBrowserState();
        await this.processGrouping(
          state.allTabs,
          groupMap,
          protectedMeta,
          managedGroupIds,
        );
      }

      const finalState = await this.captureBrowserState();
      const finalActiveWindow = await chrome.windows.getCurrent();
      this.lastStateHash = this.stateHash(
        finalState.allTabs,
        rulesByDomain,
        groupingConfig,
        finalActiveWindow.id,
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
