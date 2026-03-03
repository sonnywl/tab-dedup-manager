import {
  GroupingConfig,
  Rule,
  SyncStoreState,
  validateRule,
} from "./utils/storage.js";

import startSyncStore from "./utils/startSyncStore.js";

// ============================================================================
// TYPES
// ============================================================================

type Domain = string & { readonly __brand: "Domain" };
type TabId = number & { readonly __brand: "TabId" };
type GroupId = number & { readonly __brand: "GroupId" };
type WindowId = number & { readonly __brand: "WindowId" };

interface RulesByDomain {
  [domain: string]: Rule;
}

interface SyncStore {
  getState: () => Promise<SyncStoreState>;
}

type Tab = chrome.tabs.Tab;

interface GroupMapEntry {
  readonly tabs: Tab[];
  readonly displayName: string;
  readonly domains: ReadonlySet<Domain>;
  readonly isExternal?: boolean;
}

type GroupMap = Map<string, GroupMapEntry>;

interface GroupState {
  readonly title: string;
  readonly sourceDomain: string;
  readonly tabIds: readonly TabId[];
  readonly groupId: GroupId | null;
  readonly needsReposition: boolean;
  readonly isExternal?: boolean;
}

interface GroupPlan {
  readonly states: ReadonlyArray<{
    tabIds: readonly TabId[];
    displayName: string;
    targetIndex: number;
    currentlyGrouped: readonly TabId[];
    isExternal?: boolean;
    groupId?: GroupId | null;
  }>;
  readonly tabsToUngroup: readonly TabId[];
}

interface ProtectedTabMeta {
  readonly title: string;
  readonly originalGroupId: number;
}

type ProtectedTabMetaMap = Map<TabId, ProtectedTabMeta>;

interface BrowserState {
  allTabs: Tab[];
  groupIdToGroup: Map<number, chrome.tabGroups.TabGroup>;
}

type Result<T, E> = { success: true; value: T } | { success: false; error: E };

// ============================================================================
// UTILITIES
// ============================================================================

function isDefined<T>(v: T | undefined | null): v is T {
  return v !== undefined && v !== null;
}

function asTabId(id: number | undefined): TabId | undefined {
  return id as TabId | undefined;
}
function asGroupId(id: number): GroupId {
  return id as GroupId;
}
function asWindowId(id: number): WindowId {
  return id as WindowId;
}
function asDomain(s: string): Domain {
  return s as Domain;
}

function extractTabIds(tabs: Tab[]): TabId[] {
  return tabs.map((t) => asTabId(t.id)).filter(isDefined);
}

function isGrouped(tab: Tab): boolean {
  return tab.groupId != null && tab.groupId !== -1;
}

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
// CACHE MANAGER
// ============================================================================

export class CacheManager {
  private cache: Map<TabId, Tab>;

  constructor(tabs: Tab[]) {
    this.cache = this.build(tabs);
  }

  private build(tabs: Tab[]): Map<TabId, Tab> {
    return new Map(
      tabs.map((t) => [asTabId(t.id)!, t]).filter(([id]) => isDefined(id)),
    );
  }

  snapshot(): ReadonlyMap<TabId, Tab> {
    return this.cache;
  }
  get(id: TabId): Tab | undefined {
    return this.cache.get(id);
  }
  has(id: TabId): boolean {
    return this.cache.has(id);
  }

  async refresh(
    ids: TabId[],
  ): Promise<{ recovered: TabId[]; missing: TabId[] }> {
    const results = await Promise.allSettled(
      ids.map((id) => retry(() => chrome.tabs.get(id as number), 2, 50)),
    );
    const recovered: TabId[] = [];
    const missing: TabId[] = [];
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (r.status === "fulfilled" && r.value.success) {
        this.cache.set(ids[i], r.value.value);
        recovered.push(ids[i]);
      } else {
        missing.push(ids[i]);
      }
    }
    return { recovered, missing };
  }

  async invalidate(tabs: Tab[]): Promise<void> {
    this.cache = this.build(tabs);
  }
}

// ============================================================================
// DOMAIN LAYER
// ============================================================================

export class TabGroupingService {
  getDomain(url: string | undefined): Domain {
    if (!url) return asDomain("other");
    try {
      return asDomain(new URL(url).hostname);
    } catch {
      return asDomain("other");
    }
  }

  getGroupKey(
    domain: Domain,
    url: string | undefined,
    rulesByDomain: RulesByDomain,
  ): { key: string; title: string } {
    const rule = rulesByDomain[domain];
    const base = rule?.groupName || domain;

    if (typeof rule?.splitByPath === "number" && rule.splitByPath >= 1 && url) {
      try {
        const parts = new URL(url).pathname
          .replace(/\/$/, "")
          .replace(/^\//, "")
          .split("/")
          .filter(Boolean);

        if (parts.length >= rule.splitByPath) {
          const seg = parts[rule.splitByPath - 1];
          // Always include base in title for split path: "segment - domain" or "segment - groupName"
          return {
            key: `${base}::${seg}`,
            title: `${seg} - ${base}`,
          };
        }
      } catch {
        /* fallback to base */
      }
    }

    return { key: base, title: base };
  }

  isInternalTitle(
    title: string,
    domain: Domain,
    url: string | undefined,
    rulesByDomain: RulesByDomain,
  ): boolean {
    if (!title) return false; // Unnamed groups are always manual/external

    const rule = rulesByDomain[domain];
    const base = rule?.groupName || domain;
    const { title: expected } = this.getGroupKey(domain, url, rulesByDomain);

    // 1. Exact match with current rule or default domain
    if (title === expected || title === domain || title === base) return true;

    // 2. Collision-resolved variants (e.g. "google.com - Search")
    if (
      title.endsWith(` - ${expected}`) ||
      title.endsWith(` - ${domain}`) ||
      title.endsWith(` - ${base}`)
    ) {
      return true;
    }

    // 3. Split-path variants (including legacy format)
    if (title.includes(" - ")) {
      // New format: "segment - base"
      if (title.endsWith(` - ${domain}`) || title.endsWith(` - ${base}`)) {
        return true;
      }
      // Legacy format: "base - segment"
      if (title.startsWith(`${domain} - `) || title.startsWith(`${base} - `)) {
        return true;
      }
    }

    // 4. Legacy split-path variants (e.g. "google.com/search")
    if (title.includes("/")) {
      if (title.startsWith(`${domain}/`) || title.startsWith(`${base}/`)) {
        return true;
      }
    }

    return false;
  }

  identifyProtectedTabs(
    tabs: Tab[],
    groupIdToGroup: Map<number, chrome.tabGroups.TabGroup>,
    rulesByDomain: RulesByDomain,
  ): { protectedMeta: ProtectedTabMetaMap; managedGroupIds: Map<number, string> } {
    const protectedMeta = new Map<TabId, ProtectedTabMeta>();
    const managedGroupIds = new Map<number, string>();

    // 1. Group tabs by their current groupId
    const tabsByGroup = new Map<number, Tab[]>();
    for (const tab of tabs) {
      if (isGrouped(tab)) {
        const gid = tab.groupId!;
        if (!tabsByGroup.has(gid)) tabsByGroup.set(gid, []);
        tabsByGroup.get(gid)!.push(tab);
      }
    }

    // 2. Evaluate protection for each group atomically
    for (const [gid, gTabs] of tabsByGroup.entries()) {
      const g = groupIdToGroup.get(gid);
      if (!g) continue;

      const title = g.title || "";

      // A group is managed if its title is a valid generated title for AT LEAST ONE tab within it.
      const isManaged = gTabs.some((t) => {
        const domain = this.getDomain(t.url);
        return this.isInternalTitle(title, domain, t.url, rulesByDomain);
      });

      if (!isManaged) {
        // Manual group: protect EVERYTHING in it.
        for (const t of gTabs) {
          protectedMeta.set(asTabId(t.id)!, {
            title: title,
            originalGroupId: g.id,
          });
        }
      } else {
        // Managed group: we track the ID and title to prune intruders later.
        managedGroupIds.set(gid, title);
      }
    }
    return { protectedMeta, managedGroupIds };
  }

  buildGroupMap(
    tabs: Tab[],
    rulesByDomain: RulesByDomain,
    groupIdToGroup?: Map<number, chrome.tabGroups.TabGroup>,
    protectedTabMeta: ProtectedTabMetaMap = new Map(),
  ): GroupMap {
    const map = new Map<string, GroupMapEntry>();
    for (const tab of tabs) {
      const tabId = asTabId(tab.id);
      const domain = this.getDomain(tab.url);

      let isExternal = false;
      let groupKey: string;
      let displayName: string;

      // 1. Check if tab belongs to a manual group (registry)
      const meta = tabId ? protectedTabMeta.get(tabId) : undefined;
      if (meta) {
        isExternal = true;
        groupKey = `external::${meta.originalGroupId}`;
        displayName = meta.title;
      }
      // 2. Check if tab belongs to its CURRENT group (Managed case)
      else if (tabId && isGrouped(tab) && groupIdToGroup) {
        const group = groupIdToGroup.get(tab.groupId!);
        const groupTitle = group?.title || "";
        if (this.isInternalTitle(groupTitle, domain, tab.url, rulesByDomain)) {
          // This tab belongs to its current group.
          // Use the target key/title generation so it's bundled with its partners.
          const { key, title } = this.getGroupKey(domain, tab.url, rulesByDomain);
          groupKey = key;
          displayName = title;
        }
        // If it DOESN'T belong, we let it fall through to Case 3.
      }

      // 3. Default: Generate key/title based on current domain and rules
      if (!groupKey!) {
        const { key, title } = this.getGroupKey(domain, tab.url, rulesByDomain);
        groupKey = key;
        displayName = title;
      }

      const existing = map.get(groupKey!);
      map.set(
        groupKey!,
        existing
          ? {
              tabs: [...existing.tabs, tab],
              displayName: displayName!,
              domains: new Set([...existing.domains, domain]),
              isExternal,
            }
          : {
              tabs: [tab],
              displayName: displayName!,
              domains: new Set([domain]),
              isExternal,
            },
      );
    }
    return map;
  }

  countDuplicates(tabs: Tab[]): number {
    const seen = new Set<string>();
    let count = 0;
    for (const tab of tabs) {
      if (tab.url) {
        if (seen.has(tab.url)) count++;
        else seen.add(tab.url);
      }
    }
    return count;
  }

  filterValidTabs(
    tabs: Tab[],
    allowedDomains: ReadonlySet<Domain>,
    tabCache: ReadonlyMap<TabId, Tab>,
    isExternal: boolean = false,
  ): Tab[] {
    return extractTabIds(tabs)
      .map((id) => tabCache.get(id))
      .filter(isDefined)
      .filter((t) => {
        if (isExternal) return true;
        return allowedDomains.has(this.getDomain(t.url));
      });
  }

  buildGroupStates(
    groupMap: GroupMap,
    tabCache: ReadonlyMap<TabId, Tab>,
    groupsByTitle?: Map<string, GroupId>,
    managedGroupIds: Map<number, string> = new Map(),
  ): GroupState[] {
    const initial: GroupState[] = [];

    for (const {
      tabs,
      displayName,
      domains,
      isExternal,
    } of groupMap.values()) {
      const valid = this.filterValidTabs(
        tabs,
        domains,
        tabCache,
        isExternal || false,
      );
      if (valid.length === 0) continue;

      if (!isExternal) {
        valid.sort((a, b) => (a.url || "").localeCompare(b.url || ""));
      }

      initial.push({
        title: displayName,
        sourceDomain: Array.from(domains)[0] || "other",
        tabIds: extractTabIds(valid),
        groupId: null,
        needsReposition: false,
        isExternal,
      });
    }

    const titleCounts = new Map<string, number>();
    for (const s of initial)
      titleCounts.set(s.title, (titleCounts.get(s.title) || 0) + 1);

    // Mandate: Manual titles (including "") are never renamed due to collisions
    const resolved = initial.map((s) =>
      !s.isExternal && (titleCounts.get(s.title) || 0) > 1
        ? { ...s, title: `${s.sourceDomain} - ${s.title}` }
        : s,
    );

    return resolved.map((s) => {
      const validTabs = s.tabIds
        .map((id) => tabCache.get(id))
        .filter(isDefined);

      // 1. Precise association: Find a tab already in a group whose title matches our target
      const existing = validTabs.find((t) => {
        if (!isGrouped(t)) return false;
        const currentTitle = managedGroupIds.get(t.groupId!);
        return currentTitle === s.title;
      });

      // 2. Fallback: Lookup by title in existing groups (for newly matched tabs)
      const groupId =
        existing?.groupId != null
          ? asGroupId(existing.groupId)
          : (s.title && groupsByTitle?.get(s.title)) || null;

      return { ...s, groupId };
    });
  }

  private validateGroupState(
    state: GroupState,
    tabCache: ReadonlyMap<TabId, Tab>,
    tabsInGroupCount: Map<number, number>,
    tabsInGroupIdMap: Map<number, Set<TabId>>,
    expectedIndex: number,
  ): boolean {
    const consistent = state.tabIds.every((id, i) => {
      const tab = tabCache.get(id);
      if (!tab) return false;
      const rightIndex = tab.index === expectedIndex + i;
      const rightGroup =
        state.tabIds.length >= 2 || state.isExternal
          ? tab.groupId === state.groupId
          : tab.groupId === -1;
      return rightIndex && rightGroup;
    });
    if (!consistent) return false;

    if (state.groupId !== null) {
      if (
        (tabsInGroupCount.get(state.groupId as number) || 0) !==
        state.tabIds.length
      )
        return false;
      const ids = tabsInGroupIdMap.get(state.groupId as number);
      if (!ids || !state.tabIds.every((id) => ids.has(id))) return false;
    } else if (state.tabIds.length === 1 && !state.isExternal) {
      const tab = tabCache.get(state.tabIds[0]);
      if (tab && isGrouped(tab)) return false;
    }

    return true;
  }

  calculateRepositionNeeds(
    groupStates: GroupState[],
    tabCache: ReadonlyMap<TabId, Tab>,
  ): GroupState[] {
    const allTabs = Array.from(tabCache.values()).sort(
      (a, b) => a.index - b.index,
    );
    const managed = new Set(groupStates.flatMap((s) => s.tabIds));

    const ignoredPinned = allTabs.filter(
      (t) => t.pinned && !managed.has(asTabId(t.id)!),
    );
    const ignoredUnpinned = allTabs.filter(
      (t) => !t.pinned && !managed.has(asTabId(t.id)!),
    );

    const sortByUrl = (a: GroupState, b: GroupState) =>
      (tabCache.get(a.tabIds[0])?.url || "").localeCompare(
        tabCache.get(b.tabIds[0])?.url || "",
      );

    const managedPinned = groupStates
      .filter((s) => tabCache.get(s.tabIds[0])?.pinned)
      .sort(sortByUrl);

    const managedUnpinned = groupStates
      .filter((s) => !tabCache.get(s.tabIds[0])?.pinned)
      .sort((a, b) => {
        const ga = a.tabIds.length >= 2 || a.isExternal,
          gb = b.tabIds.length >= 2 || b.isExternal;
        if (ga !== gb) return ga ? -1 : 1;
        return sortByUrl(a, b);
      });

    const tabsInGroupCount = new Map<number, number>();
    const tabsInGroupIdMap = new Map<number, Set<TabId>>();
    for (const tab of tabCache.values()) {
      if (isGrouped(tab)) {
        const gid = tab.groupId!;
        tabsInGroupCount.set(gid, (tabsInGroupCount.get(gid) || 0) + 1);
        if (!tabsInGroupIdMap.has(gid)) tabsInGroupIdMap.set(gid, new Set());
        tabsInGroupIdMap.get(gid)!.add(asTabId(tab.id)!);
      }
    }

    const results: GroupState[] = [];

    let idx = ignoredPinned.length;
    for (const s of managedPinned) {
      results.push({
        ...s,
        needsReposition: !this.validateGroupState(
          s,
          tabCache,
          tabsInGroupCount,
          tabsInGroupIdMap,
          idx,
        ),
      });
      idx += s.tabIds.length;
    }

    idx = ignoredPinned.length + managedPinned.length + ignoredUnpinned.length;
    for (const s of managedUnpinned) {
      results.push({
        ...s,
        needsReposition: !this.validateGroupState(
          s,
          tabCache,
          tabsInGroupCount,
          tabsInGroupIdMap,
          idx,
        ),
      });
      idx += s.tabIds.length;
    }

    return results;
  }

  createGroupPlan(
    groupStates: GroupState[],
    tabCache: ReadonlyMap<TabId, Tab>,
    managedGroupIds: Map<number, string> = new Map(),
  ): GroupPlan {
    const states: GroupPlan["states"][number][] = [];
    let targetIndex = 0;

    const groupToExpectedTabs = new Map<number, Set<TabId>>();
    for (const s of groupStates) {
      if (s.groupId !== null) {
        if (!groupToExpectedTabs.has(s.groupId))
          groupToExpectedTabs.set(s.groupId, new Set());
        for (const id of s.tabIds) groupToExpectedTabs.get(s.groupId)!.add(id);
      }

      if (s.tabIds.length === 0) continue;
      if (s.needsReposition) {
        states.push({
          tabIds: s.tabIds,
          displayName: s.title,
          targetIndex,
          currentlyGrouped: s.isExternal
            ? [] // External tabs stay bundled during moves
            : s.tabIds.filter((id) => {
                const tab = tabCache.get(id);
                return tab && isGrouped(tab);
              }),
          isExternal: s.isExternal,
          groupId: s.groupId,
        });
      }
      targetIndex += s.tabIds.length;
    }

    const tabsToUngroup: TabId[] = [];
    for (const tab of tabCache.values()) {
      const tid = asTabId(tab.id);
      const gid = tab.groupId;
      if (tid && gid !== -1 && isDefined(gid)) {
        // Only consider ungrouping if the group is managed.
        // Manual groups are never stripped of tabs.
        if (managedGroupIds.has(gid)) {
          const expected = groupToExpectedTabs.get(gid);
          if (!expected || !expected.has(tid)) {
            tabsToUngroup.push(tid);
          }
        }
      }
    }

    return { states, tabsToUngroup };
  }
}

// ============================================================================
// WINDOW MANAGEMENT
// ============================================================================

export class WindowManagementService {
  calculateMergePlan(
    retainedWindows: Map<WindowId, Tab[]>,
    excessTabs: Tab[],
    service: TabGroupingService,
  ): Map<WindowId, TabId[]> {
    const plan = new Map<WindowId, TabId[]>();
    const domainCounts = new Map<WindowId, Map<Domain, number>>();

    for (const [wid, tabs] of retainedWindows) {
      const counts = new Map<Domain, number>();
      for (const t of tabs) {
        const d = service.getDomain(t.url);
        counts.set(d, (counts.get(d) || 0) + 1);
      }
      domainCounts.set(wid, counts);
    }

    let defaultWid: WindowId | undefined;
    let maxTabs = -1;
    for (const [wid, tabs] of retainedWindows) {
      if (tabs.length > maxTabs) {
        maxTabs = tabs.length;
        defaultWid = wid;
      }
    }

    for (const tab of excessTabs) {
      const domain = service.getDomain(tab.url);
      let bestWid = defaultWid;
      let bestCount = 0;
      for (const [wid, counts] of domainCounts) {
        const c = counts.get(domain) || 0;
        if (c > bestCount) {
          bestCount = c;
          bestWid = wid;
        }
      }
      if (bestWid && tab.id) {
        if (!plan.has(bestWid)) plan.set(bestWid, []);
        plan.get(bestWid)!.push(asTabId(tab.id)!);
      }
    }

    return plan;
  }
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
    tabCache: ReadonlyMap<TabId, Tab>,
    existingGroups: Map<number, chrome.tabGroups.TabGroup>,
  ): Promise<Result<void, Error>> {
    const snapshot = await this.captureState();

    try {
      // 0. Ungroup tabs that shouldn't be in any group
      if (plan.tabsToUngroup.length > 0) {
        await runAtomicOperation(
          () => chrome.tabs.ungroup(plan.tabsToUngroup as number[]),
          snapshot.tabs,
          this.RATE_DELAY,
        );
      }

      for (const state of plan.states) {
        // 1. Identify if it's a full group move to avoid ungroup/regroup
        if (state.groupId && (state.isExternal || state.tabIds.length >= 2)) {
          const groupTabs = await chrome.tabs.query({ groupId: state.groupId });
          const isMatch =
            groupTabs.length === state.tabIds.length &&
            groupTabs.every((t) => state.tabIds.includes(asTabId(t.id)!));

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

        // 2. Ungroup ONLY if managed (manual groups stay bundled)
        if (!state.isExternal && state.currentlyGrouped.length > 0) {
          await runAtomicOperation(
            () => chrome.tabs.ungroup(state.currentlyGrouped as number[]),
            snapshot.tabs,
            this.RATE_DELAY,
          );
        }

        // 3. Move tabs (Atomic block)
        await runAtomicOperation(
          () =>
            chrome.tabs.move(state.tabIds as number[], {
              index: state.targetIndex,
            }),
          snapshot.tabs,
          this.RATE_DELAY,
        );

        // 4. Regroup ONLY if necessary (Bundle Integrity Check)
        const shouldRegroup = state.isExternal || state.tabIds.length >= 2;
        const currentGroupIds = new Set(
          state.tabIds
            .map((id) => tabCache.get(id)?.groupId)
            .filter((g) => g !== -1 && g !== undefined),
        );
        const allInCorrectBundle =
          currentGroupIds.size === 1 &&
          state.tabIds.every((id) => isGrouped(tabCache.get(id)!));
        const activeGid = allInCorrectBundle
          ? (Array.from(currentGroupIds)[0] as number)
          : null;
        const activeTitle = activeGid
          ? existingGroups.get(activeGid)?.title
          : null;

        if (
          shouldRegroup &&
          (!allInCorrectBundle || activeTitle !== state.displayName)
        ) {
          await runAtomicOperation(
            async () => {
              const gid = await chrome.tabs.group({
                tabIds: state.tabIds as number[],
              });
              await chrome.tabGroups.update(gid, {
                collapsed: false,
                title: state.displayName,
              });
              return gid;
            },
            snapshot.tabs,
            this.RATE_DELAY,
          );
        }
      }

      return { success: true, value: undefined };
    } catch (err) {
      // rollback already handled inside runAtomicOperation
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
        const { missing } = await cache.refresh(missingIds);
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
