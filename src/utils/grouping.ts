import { Rule } from "./storage";

// ============================================================================
// TYPES
// ============================================================================

export type Domain = string & { readonly __brand: "Domain" };
export type TabId = number & { readonly __brand: "TabId" };
export type GroupId = number & { readonly __brand: "GroupId" };
export type WindowId = number & { readonly __brand: "WindowId" };

export interface RulesByDomain {
  [domain: string]: Rule;
}

export type Tab = chrome.tabs.Tab;

export interface GroupMapEntry {
  readonly tabs: Tab[];
  readonly displayName: string;
  readonly domains: ReadonlySet<Domain>;
  readonly isExternal?: boolean;
}

export type GroupMap = Map<string, GroupMapEntry>;

export interface GroupState {
  readonly title: string;
  readonly sourceDomain: string;
  readonly tabIds: readonly TabId[];
  readonly groupId: GroupId | null;
  readonly needsReposition: boolean;
  readonly isExternal?: boolean;
  readonly color?: chrome.tabGroups.Color;
  targetIndex?: number;
}

export interface GroupPlan {
  readonly states: ReadonlyArray<{
    tabIds: readonly TabId[];
    displayName: string;
    targetIndex: number;
    isExternal?: boolean;
    groupId?: GroupId | null;
    color?: chrome.tabGroups.Color;
  }>;
  readonly tabsToUngroup: readonly TabId[];
}

export interface ProtectedTabMeta {
  readonly title: string;
  readonly originalGroupId: number;
}

export type ProtectedTabMetaMap = Map<TabId, ProtectedTabMeta>;

// ============================================================================
// TYPE CASTING & GUARDS
// ============================================================================

export function isDefined<T>(v: T | undefined | null): v is T {
  return v !== undefined && v !== null;
}

export function asTabId(id: number | undefined): TabId | undefined {
  return id as TabId | undefined;
}
export function asGroupId(id: number): GroupId {
  return id as GroupId;
}
export function asWindowId(id: number): WindowId {
  return id as WindowId;
}
export function asDomain(s: string): Domain {
  return s as Domain;
}

export function extractTabIds(tabs: Tab[]): TabId[] {
  return tabs.map((t) => asTabId(t.id)).filter(isDefined);
}

export function isGrouped(tab: Tab): boolean {
  return tab.groupId != null && tab.groupId !== -1;
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
    retryFn: <T>(fn: () => Promise<T>) => Promise<{ success: boolean; value?: T; error?: any }> = async (fn) => {
      try {
        return { success: true, value: await fn() };
      } catch (err) {
        return { success: false, error: err };
      }
    }
  ): Promise<{ recovered: TabId[]; missing: TabId[] }> {
    const results = await Promise.allSettled(
      ids.map((id) => retryFn(() => chrome.tabs.get(id as number))),
    );
    const recovered: TabId[] = [];
    const missing: TabId[] = [];
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (r.status === "fulfilled" && r.value.success) {
        this.cache.set(ids[i], r.value.value!);
        recovered.push(ids[i]);
      } else {
        missing.push(ids[i]);
      }
    }
    return { recovered, missing };
  }

  invalidate(tabs: Tab[]): void {
    this.cache = this.build(tabs);
  }
}

// ============================================================================
// CORE LOGIC (Domain Layer)
// ============================================================================

export class TabGroupingService {
  getDomain(url: string | undefined): Domain {
    if (!url) return asDomain("other");
    try {
      const host = new URL(url).hostname.toLowerCase();
      return asDomain(host.startsWith("www.") ? host.slice(4) : host);
    } catch {
      return asDomain("other");
    }
  }

  private formatTitle(s: string): string {
    return s;
  }

  private CHROME_COLORS: chrome.tabGroups.Color[] = [
    "blue",
    "red",
    "yellow",
    "green",
    "pink",
    "purple",
    "cyan",
    "orange",
  ];

  private getDeterministicColor(input: string): chrome.tabGroups.Color {
    let hash = 0;
    for (let i = 0; i < input.length; i++) {
      hash = (hash << 5) - hash + input.charCodeAt(i);
      hash |= 0;
    }
    return this.CHROME_COLORS[Math.abs(hash) % this.CHROME_COLORS.length];
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
          return {
            key: `${base}::${seg}`,
            title: `${seg} - ${base}`,
          };
        }
      } catch {
        /* fallback */
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
    if (!title) return false;

    const rule = rulesByDomain[domain];
    const base = rule?.groupName || domain;
    const { title: expected } = this.getGroupKey(domain, url, rulesByDomain);

    if (title === expected || title === domain || title === base) return true;

    if (
      title.endsWith(` - ${expected}`) ||
      title.endsWith(` - ${domain}`) ||
      title.endsWith(` - ${base}`)
    ) {
      return true;
    }

    if (title.includes(" - ")) {
      if (title.endsWith(` - ${domain}`) || title.endsWith(` - ${base}`))
        return true;
      if (title.startsWith(`${domain} - `) || title.startsWith(`${base} - `))
        return true;
    }

    if (title.includes("/")) {
      if (title.startsWith(`${domain}/`) || title.startsWith(`${base}/`))
        return true;
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

    const tabsByGroup = new Map<number, Tab[]>();
    for (const tab of tabs) {
      if (isGrouped(tab)) {
        const gid = tab.groupId!;
        if (!tabsByGroup.has(gid)) tabsByGroup.set(gid, []);
        tabsByGroup.get(gid)!.push(tab);
      }
    }

    for (const [gid, gTabs] of tabsByGroup.entries()) {
      const g = groupIdToGroup.get(gid);
      if (!g) continue;

      const title = g.title || "";
      const isManaged = gTabs.some((t) => {
        const domain = this.getDomain(t.url);
        return this.isInternalTitle(title, domain, t.url, rulesByDomain);
      });

      if (!isManaged) {
        for (const t of gTabs) {
          protectedMeta.set(asTabId(t.id)!, {
            title: title,
            originalGroupId: g.id,
          });
        }
      } else {
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
      let groupKey: string = "";
      let displayName: string = "";

      const meta = tabId ? protectedTabMeta.get(tabId) : undefined;
      if (meta) {
        isExternal = true;
        groupKey = `external::${meta.originalGroupId}`;
        displayName = meta.title;
      } else if (tabId && isGrouped(tab) && groupIdToGroup) {
        const group = groupIdToGroup.get(tab.groupId!);
        const groupTitle = group?.title || "";
        if (this.isInternalTitle(groupTitle, domain, tab.url, rulesByDomain)) {
          const { key, title } = this.getGroupKey(domain, tab.url, rulesByDomain);
          groupKey = key;
          displayName = title;
        }
      }

      if (!groupKey) {
        const { key, title } = this.getGroupKey(domain, tab.url, rulesByDomain);
        groupKey = key;
        displayName = title;
      }

      const existing = map.get(groupKey);
      map.set(
        groupKey,
        existing
          ? {
              tabs: [...existing.tabs, tab],
              displayName,
              domains: new Set([...existing.domains, domain]),
              isExternal,
            }
          : {
              tabs: [tab],
              displayName,
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

  buildGroupStates(
    groupMap: GroupMap,
    tabCache: ReadonlyMap<TabId, Tab>,
    groupsByTitle?: Map<string, GroupId>,
    managedGroupIds: Map<number, string> = new Map(),
  ): GroupState[] {
    const initial: GroupState[] = [];

    for (const { tabs, displayName, domains, isExternal } of groupMap.values()) {
      const valid = extractTabIds(tabs)
        .map((id) => tabCache.get(id))
        .filter(isDefined)
        .filter((t) => {
          if (isExternal) return true;
          return domains.has(this.getDomain(t.url));
        });

      if (valid.length === 0) continue;

      if (!isExternal) {
        valid.sort((a, b) => {
          const urlComp = (a.url || "").localeCompare(b.url || "");
          if (urlComp !== 0) return urlComp;
          return (a.id ?? 0) - (b.id ?? 0); // Stability
        });
      }

      const sourceDomain = Array.from(domains)[0] || "other";
      initial.push({
        title: isExternal ? displayName : this.formatTitle(displayName),
        sourceDomain,
        tabIds: extractTabIds(valid),
        groupId: null,
        needsReposition: false,
        isExternal,
        color: isExternal ? undefined : this.getDeterministicColor(sourceDomain),
      });
    }

    const titleCounts = new Map<string, number>();
    for (const s of initial)
      titleCounts.set(s.title, (titleCounts.get(s.title) || 0) + 1);

    const resolved = initial.map((s) =>
      !s.isExternal && (titleCounts.get(s.title) || 0) > 1
        ? { ...s, title: `${this.formatTitle(s.sourceDomain)} - ${s.title}` }
        : s,
    );

    return resolved.map((s) => {
      const validTabs = s.tabIds.map((id) => tabCache.get(id)).filter(isDefined);

      const existing = validTabs.find((t) => {
        if (!isGrouped(t)) return false;
        const currentTitle = managedGroupIds.get(t.groupId!);
        return currentTitle === s.title;
      });

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
        (tabsInGroupCount.get(state.groupId as number) || 0) !== state.tabIds.length
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

    const sortByUrl = (a: GroupState, b: GroupState) => {
      const tA = tabCache.get(a.tabIds[0]);
      const tB = tabCache.get(b.tabIds[0]);
      const urlComp = (tA?.url || "").localeCompare(tB?.url || "");
      if (urlComp !== 0) return urlComp;
      return (tA?.id ?? 0) - (tB?.id ?? 0); // Stability
    };

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
      const needsReposition = !this.validateGroupState(
        s,
        tabCache,
        tabsInGroupCount,
        tabsInGroupIdMap,
        idx,
      );
      results.push({
        ...s,
        needsReposition,
        targetIndex: idx,
      });
      idx += s.tabIds.length;
    }

    // Correctly calculate start index for unpinned: IgnoredPinned + ManagedPinnedTabs + IgnoredUnpinned
    idx =
      ignoredPinned.length +
      managedPinned.reduce((sum, s) => sum + s.tabIds.length, 0) +
      ignoredUnpinned.length;

    for (const s of managedUnpinned) {
      const needsReposition = !this.validateGroupState(
        s,
        tabCache,
        tabsInGroupCount,
        tabsInGroupIdMap,
        idx,
      );
      results.push({
        ...s,
        needsReposition,
        targetIndex: idx,
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
          targetIndex: s.targetIndex ?? 0,
          isExternal: s.isExternal,
          groupId: s.groupId,
          color: s.color,
        });
      }
    }

    const tabsToUngroup: TabId[] = [];
    for (const tab of tabCache.values()) {
      const tid = asTabId(tab.id);
      const gid = tab.groupId;
      if (tid && gid !== -1 && isDefined(gid)) {
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
// WINDOW MANAGEMENT (Domain Layer)
// ============================================================================

export class WindowManagementService {
  calculateMergePlan(
    retainedWindows: Map<WindowId, Tab[]>,
    excessTabs: Tab[],
    service: TabGroupingService,
    protectedTabMeta: ProtectedTabMetaMap = new Map(),
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

    const groupToTabs = new Map<number, Tab[]>();
    const individualTabs: Tab[] = [];

    for (const tab of excessTabs) {
      const tid = asTabId(tab.id);
      const meta = tid ? protectedTabMeta.get(tid) : undefined;
      if (meta) {
        if (!groupToTabs.has(meta.originalGroupId))
          groupToTabs.set(meta.originalGroupId, []);
        groupToTabs.get(meta.originalGroupId)!.push(tab);
      } else {
        individualTabs.push(tab);
      }
    }

    for (const gTabs of groupToTabs.values()) {
      const groupDomains = new Map<Domain, number>();
      for (const t of gTabs) {
        const d = service.getDomain(t.url);
        groupDomains.set(d, (groupDomains.get(d) || 0) + 1);
      }

      let bestWid = defaultWid;
      let maxScore = -1;
      for (const [wid, counts] of domainCounts) {
        let score = 0;
        for (const [d, count] of groupDomains) {
          score += (counts.get(d) || 0) * count;
        }
        if (score > maxScore) {
          maxScore = score;
          bestWid = wid;
        }
      }

      if (bestWid) {
        if (!plan.has(bestWid)) plan.set(bestWid, []);
        for (const t of gTabs) if (t.id) plan.get(bestWid)!.push(asTabId(t.id)!);
      }
    }

    for (const tab of individualTabs) {
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
