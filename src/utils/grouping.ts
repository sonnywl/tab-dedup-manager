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
  readonly groupId?: GroupId | null;
}

export type GroupMap = Map<string, GroupMapEntry>;

export interface GroupState {
  readonly displayName: string;
  readonly sourceDomain: string;
  readonly tabIds: readonly TabId[];
  readonly groupId: GroupId | null;
  readonly needsReposition: boolean;
  readonly needsTitleUpdate?: boolean;
  readonly isExternal?: boolean;
  targetIndex?: number;
}

export interface GroupPlan {
  readonly states: ReadonlyArray<{
    tabIds: readonly TabId[];
    displayName: string;
    sourceDomain: string;
    targetIndex: number;
    isExternal?: boolean;
    groupId?: GroupId | null;
    needsTitleUpdate?: boolean;
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
// CORE LOGIC (Domain Layer)
// ============================================================================

export class TabGroupingService {
  normalizeDomain(domain: string): Domain {
    const d = domain.toLowerCase();
    return asDomain(d.startsWith("www.") ? d.slice(4) : d);
  }

  getDomain(url: string | undefined): Domain {
    if (!url) return asDomain("other");
    try {
      const u = new URL(url);
      // Mandate: Use .host instead of .hostname to include significant ports (e.g. localhost:8000)
      return this.normalizeDomain(u.host);
    } catch {
      return asDomain("other");
    }
  }

  private formatTitle(s: string): string {
    return s;
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
    if (!title) return true; // Scavenge unnamed groups

    const rule = rulesByDomain[domain];
    const base = rule?.groupName || domain;
    const { title: expected } = this.getGroupKey(domain, url, rulesByDomain);

    const t = title.toLowerCase();
    const e = expected.toLowerCase();
    const d = domain.toLowerCase();
    const b = base.toLowerCase();

    // 1. Exact match with current rule, default domain, or base name (case-insensitive)
    if (t === e || t === d || t === b) return true;

    // 2. Exact match with domain including www. prefix
    if (t === `www.${d}`) return true;

    // 3. Collision-resolved variants (e.g. "google.com - Search")
    if (
      t.endsWith(` - ${e}`) ||
      t.endsWith(` - ${d}`) ||
      t.endsWith(` - ${b}`)
    ) {
      return true;
    }

    // 4. Split-path variants
    if (t.includes(" - ")) {
      if (
        t.endsWith(` - ${d}`) ||
        t.endsWith(` - ${b}`) ||
        t.endsWith(` - www.${d}`) ||
        t.endsWith(` - www.${b}`)
      )
        return true;
      if (
        t.startsWith(`${d} - `) ||
        t.startsWith(`${b} - `) ||
        t.startsWith(`www.${d} - `) ||
        t.startsWith(`www.${b} - `)
      )
        return true;
    }

    if (t.includes("/")) {
      if (
        t.startsWith(`${d}/`) ||
        t.startsWith(`${b}/`) ||
        t.startsWith(`www.${d}/`) ||
        t.startsWith(`www.${b}/`)
      )
        return true;
    }

    return false;
  }

  identifyProtectedTabs(
    tabs: Tab[],
    groupIdToGroup: Map<number, chrome.tabGroups.TabGroup>,
    rulesByDomain: RulesByDomain,
  ): {
    protectedMeta: ProtectedTabMetaMap;
    managedGroupIds: Map<number, string>;
  } {
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
        const normalizedDomain = this.normalizeDomain(domain);
        return this.isInternalTitle(
          title,
          normalizedDomain,
          t.url,
          rulesByDomain,
        );
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
      let groupId: GroupId | null = null;

      const meta = tabId ? protectedTabMeta.get(tabId) : undefined;
      if (meta) {
        isExternal = true;
        groupKey = `external::${meta.originalGroupId}`;
        displayName = meta.title;
        groupId = asGroupId(meta.originalGroupId);
      } else if (tabId && isGrouped(tab) && groupIdToGroup) {
        const group = groupIdToGroup.get(tab.groupId!);
        const groupTitle = group?.title || "";
        if (this.isInternalTitle(groupTitle, domain, tab.url, rulesByDomain)) {
          const { key, title } = this.getGroupKey(
            domain,
            tab.url,
            rulesByDomain,
          );
          groupKey = `${tab.pinned ? "pinned" : "unpinned"}::${key}`;
          displayName = title;

          // Mandate: Only inherit groupId if the title specifically matches what we expect for this tab
          // This ensures that path-segment intruders are seen as needing to move to their OWN group
          if (groupTitle.toLowerCase() === title.toLowerCase()) {
            groupId = asGroupId(tab.groupId!);
          }
        }
      }

      if (!groupKey) {
        const { key, title } = this.getGroupKey(domain, tab.url, rulesByDomain);
        groupKey = `${tab.pinned ? "pinned" : "unpinned"}::${key}`;
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
              groupId: groupId || existing.groupId,
            }
          : {
              tabs: [tab],
              displayName,
              domains: new Set([domain]),
              isExternal,
              groupId,
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

    for (const {
      tabs,
      displayName,
      domains,
      isExternal,
      groupId: entryGroupId,
    } of groupMap.values()) {
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
        displayName: isExternal
          ? displayName
          : this.formatTitle(displayName) || sourceDomain,
        sourceDomain,
        tabIds: extractTabIds(valid),
        groupId: entryGroupId || null,
        needsReposition: false,
        isExternal,
      });
    }

    const titleCounts = new Map<string, number>();
    for (const s of initial)
      titleCounts.set(s.displayName, (titleCounts.get(s.displayName) || 0) + 1);

    const resolved = initial.map((s) => {
      if (s.isExternal || (titleCounts.get(s.displayName) || 0) <= 1) return s;

      const prefix = this.formatTitle(s.sourceDomain);
      if (s.displayName.toLowerCase().includes(prefix.toLowerCase())) return s;

      return {
        ...s,
        displayName: `${prefix} - ${s.displayName}`,
      };
    });

    return resolved.map((s) => {
      const validTabs = s.tabIds
        .map((id) => tabCache.get(id))
        .filter(isDefined);

      const existing = validTabs.find((t) => {
        if (!isGrouped(t)) return false;
        const currentTitle = managedGroupIds.get(t.groupId!);
        return currentTitle === s.displayName;
      });

      let groupId =
        s.groupId != null
          ? s.groupId
          : existing?.groupId != null
            ? asGroupId(existing.groupId)
            : (s.displayName && groupsByTitle?.get(s.displayName)) || null;

      // Mandate: If it's a managed item (not external) and only has 1 tab,
      // it MUST NOT have a groupId (enforces ungrouping).
      if (!s.isExternal && s.tabIds.length < 2) {
        groupId = null;
      }

      return { ...s, groupId };
    });
  }

  private validateGroupState(
    state: GroupState,
    tabCache: ReadonlyMap<TabId, Tab>,
    tabsInGroupCount: Map<number, number>,
    tabsInGroupIdMap: Map<number, Set<TabId>>,
    expectedIndex: number,
    windowId?: WindowId,
  ): boolean {
    const consistent = state.tabIds.every((id, i) => {
      const tab = tabCache.get(id);
      if (!tab) return false;

      // Mandate: Must be in the correct window if specified
      const rightWindow = windowId === undefined || tab.windowId === windowId;

      const rightIndex = tab.index === expectedIndex + i;
      const rightGroup =
        state.groupId !== null || state.isExternal || state.tabIds.length >= 2
          ? tab.groupId === state.groupId
          : tab.groupId === -1;
      return rightWindow && rightIndex && rightGroup;
    });
    if (!consistent) return false;

    if (
      state.groupId !== null &&
      (state.isExternal || state.tabIds.length >= 2)
    ) {
      if (
        (tabsInGroupCount.get(state.groupId as number) || 0) !==
        state.tabIds.length
      )
        return false;
      const ids = tabsInGroupIdMap.get(state.groupId as number);
      if (!ids || !state.tabIds.every((id) => ids.has(id))) return false;
    } else if (state.tabIds.length === 1 && !state.isExternal) {
      // Mandate: If it's a single tab, it MUST be ungrouped (groupId -1)
      const tab = tabCache.get(state.tabIds[0]);
      if (tab && isGrouped(tab)) return false;
    }

    return true;
  }

  calculateRepositionNeeds(
    groupStates: GroupState[],
    tabCache: ReadonlyMap<TabId, Tab>,
    windowId?: WindowId,
    managedGroupIds: Map<number, string> = new Map(),
  ): GroupState[] {
    let allTabs = Array.from(tabCache.values());
    if (windowId !== undefined) {
      allTabs = allTabs.filter((t) => t.windowId === windowId);
    }
    allTabs.sort((a, b) => a.index - b.index);

    const managed = new Set(groupStates.flatMap((s) => s.tabIds));

    const ignoredPinned = allTabs.filter(
      (t) => t.pinned && !managed.has(asTabId(t.id)!),
    );

    const sortByUrl = (a: GroupState, b: GroupState) => {
      // Mandate: For managed items, if they have a displayName (like splitByPath segments),
      // we sort by that first to ensure "a - domain" < "b - domain".
      const nameComp = (a.displayName || "").localeCompare(b.displayName || "");
      if (nameComp !== 0) return nameComp;

      const tA = tabCache.get(a.tabIds[0]);
      const tB = tabCache.get(b.tabIds[0]);
      const urlComp = (tA?.url || "").localeCompare(tB?.url || "");
      if (urlComp !== 0) return urlComp;
      return (tA?.id ?? 0) - (tB?.id ?? 0); // Stability
    };

    const sortById = (a: GroupState, b: GroupState) => {
      // Mandate: Even for manual groups, sort by displayName if it exists
      const nameComp = (a.displayName || "").localeCompare(b.displayName || "");
      if (nameComp !== 0) return nameComp;

      const tA = tabCache.get(a.tabIds[0]);
      const tB = tabCache.get(b.tabIds[0]);
      return (tA?.id ?? 0) - (tB?.id ?? 0); // Stable ID
    };

    const managedPinned = groupStates
      .filter((s) => tabCache.get(s.tabIds[0])?.pinned)
      .sort((a, b) => {
        // Rule: Group (Visual) -> Tab (Visual)
        const isGroupA = a.isExternal || a.tabIds.length >= 2;
        const isGroupB = b.isExternal || b.tabIds.length >= 2;
        if (isGroupA !== isGroupB) return isGroupA ? -1 : 1;

        // Then Protected -> Managed
        if (a.isExternal !== b.isExternal) return a.isExternal ? -1 : 1;

        return sortById(a, b); // Stable ID for Pinned
      });

    const managedUnpinned = groupStates
      .filter((s) => !tabCache.get(s.tabIds[0])?.pinned)
      .sort((a, b) => {
        // Rule: Group (Visual) -> Tab (Visual)
        // Manual groups and Managed groups (2+ tabs) are interleaved by unified key.
        const isGroupA = a.isExternal || a.tabIds.length >= 2 ? 1 : 0;
        const isGroupB = b.isExternal || b.tabIds.length >= 2 ? 1 : 0;
        if (isGroupA !== isGroupB) return isGroupB - isGroupA;

        // Rule: All items in their respective clusters are sorted by Title/URL.
        return sortByUrl(a, b);
      });

    const tabsInGroupCount = new Map<number, number>();
    const tabsInGroupIdMap = new Map<number, Set<TabId>>();
    for (const tab of allTabs) {
      if (isGrouped(tab)) {
        const gid = tab.groupId!;
        tabsInGroupCount.set(gid, (tabsInGroupCount.get(gid) || 0) + 1);
        if (!tabsInGroupIdMap.has(gid)) tabsInGroupIdMap.set(gid, new Set());
        tabsInGroupIdMap.get(gid)!.add(asTabId(tab.id)!);
      }
    }

    const results: GroupState[] = [];

    // Managed Pinned follow Ignored Pinned
    let idx = ignoredPinned.length;
    for (const s of managedPinned) {
      const needsReposition = !this.validateGroupState(
        s,
        tabCache,
        tabsInGroupCount,
        tabsInGroupIdMap,
        idx,
        windowId,
      );
      // Mandate: Check if title also needs update
      const currentTitle =
        s.groupId !== null ? managedGroupIds.get(s.groupId as number) : null;
      const needsTitleUpdate =
        s.groupId !== null &&
        currentTitle !== null &&
        currentTitle !== s.displayName;

      results.push({
        ...s,
        needsReposition,
        needsTitleUpdate,
        targetIndex: idx,
      });
      idx += s.tabIds.length;
    }

    // Managed Unpinned follow Managed Pinned (Ignored Unpinned are displaced to end)
    for (const s of managedUnpinned) {
      const needsReposition = !this.validateGroupState(
        s,
        tabCache,
        tabsInGroupCount,
        tabsInGroupIdMap,
        idx,
        windowId,
      );
      const currentTitle =
        s.groupId !== null ? managedGroupIds.get(s.groupId as number) : null;
      const needsTitleUpdate =
        s.groupId !== null &&
        currentTitle !== null &&
        currentTitle !== s.displayName;

      results.push({
        ...s,
        needsReposition,
        needsTitleUpdate,
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
    windowId?: WindowId,
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
      if (s.needsReposition || s.needsTitleUpdate) {
        states.push({
          tabIds: s.tabIds,
          displayName: s.displayName,
          sourceDomain: s.sourceDomain,
          targetIndex: s.targetIndex ?? 0,
          isExternal: s.isExternal,
          groupId: s.groupId,
          needsTitleUpdate: s.needsTitleUpdate,
        });
      }
    }

    const tabsToUngroup: TabId[] = [];
    for (const tab of tabCache.values()) {
      // Mandate: If windowId is specified, only ungroup tabs that are CURRENTLY in this window.
      // This prevents "byWindow" grouping from ungrouping everything in other windows.
      if (windowId !== undefined && tab.windowId !== windowId) continue;

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

export interface ConsolidationPlan {
  readonly groupMoves: ReadonlyArray<{ groupId: number; windowId: WindowId }>;
  readonly tabMoves: ReadonlyArray<{ tabIds: number[]; windowId: WindowId }>;
}

// ============================================================================
// WINDOW MANAGEMENT (Domain Layer)
// ============================================================================

export class WindowManagementService {
  groupByWindow(tabs: Tab[]): Map<WindowId, Tab[]> {
    const map = new Map<WindowId, Tab[]>();
    for (const tab of tabs) {
      if (!tab.windowId) continue;
      const wid = asWindowId(tab.windowId);
      if (!map.has(wid)) map.set(wid, []);
      map.get(wid)!.push(tab);
    }
    return map;
  }

  createConsolidationPlan(
    tabs: Tab[],
    numWindowsToKeep: number,
    service: TabGroupingService,
    protectedTabMeta: ProtectedTabMetaMap,
    managedGroupIds: Map<number, string>,
  ): ConsolidationPlan | null {
    const windowGroups = this.groupByWindow(tabs);
    const entries = Array.from(windowGroups.entries()).sort(
      (a, b) => b[1].length - a[1].length,
    );
    if (entries.length <= numWindowsToKeep) return null;

    const retained = new Map(entries.slice(0, numWindowsToKeep));
    const excess = entries.slice(numWindowsToKeep).flatMap((e) => e[1]);

    const mergePlan = this.calculateMergePlan(
      retained,
      excess,
      service,
      protectedTabMeta,
      managedGroupIds,
    );

    const groupMoves: { groupId: number; windowId: WindowId }[] = [];
    const tabMoves: { tabIds: number[]; windowId: WindowId }[] = [];

    // Group the moving tabs by their CURRENT group to identify block moves
    for (const [wid, tabIds] of mergePlan) {
      const targetWindowId = asWindowId(wid as number);
      const movingTabs = tabs.filter(
        (t) => t.id && tabIds.includes(asTabId(t.id)!),
      );

      const groupToMovingTabs = new Map<number, number[]>();
      const ungroupedMovingTabs: number[] = [];

      for (const t of movingTabs) {
        if (isGrouped(t)) {
          if (!groupToMovingTabs.has(t.groupId!))
            groupToMovingTabs.set(t.groupId!, []);
          groupToMovingTabs.get(t.groupId!)!.push(t.id!);
        } else {
          ungroupedMovingTabs.push(t.id!);
        }
      }

      for (const [gid, tIds] of groupToMovingTabs.entries()) {
        const allInGroup = tabs.filter((t) => t.groupId === gid);
        if (allInGroup.length === tIds.length) {
          groupMoves.push({ groupId: gid, windowId: targetWindowId });
        } else {
          tabMoves.push({ tabIds: tIds, windowId: targetWindowId });
        }
      }

      if (ungroupedMovingTabs.length > 0) {
        tabMoves.push({
          tabIds: ungroupedMovingTabs,
          windowId: targetWindowId,
        });
      }
    }

    return { groupMoves, tabMoves };
  }

  calculateMergePlan(
    retainedWindows: Map<WindowId, Tab[]>,
    excessTabs: Tab[],
    service: TabGroupingService,
    protectedTabMeta: ProtectedTabMetaMap = new Map(),
    managedGroupIds: Map<number, string> = new Map(),
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
      const gid = tab.groupId;
      const isProtected = tid ? protectedTabMeta.has(tid) : false;
      const isManaged =
        gid !== undefined && gid !== -1 && managedGroupIds.has(gid);

      if (isProtected || isManaged) {
        const effectiveGid = isProtected
          ? protectedTabMeta.get(tid!)!.originalGroupId
          : gid!;

        if (!groupToTabs.has(effectiveGid)) groupToTabs.set(effectiveGid, []);
        groupToTabs.get(effectiveGid)!.push(tab);
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
        for (const t of gTabs)
          if (t.id) plan.get(bestWid)!.push(asTabId(t.id)!);
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
