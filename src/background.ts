import startSyncStore from "./utils/startSyncStore.js";

// ============================================================================
// TYPES
// ============================================================================

type Domain = string & { readonly __brand: "Domain" };
type TabId = number & { readonly __brand: "TabId" };
type GroupId = number & { readonly __brand: "GroupId" };
type WindowId = number & { readonly __brand: "WindowId" };

interface Rule {
  domain: string;
  autoDelete: boolean | null | undefined;
  skipProcess: boolean | null | undefined;
  groupName: string | null | undefined;
  splitByPath: number | null | undefined;
}

interface RulesByDomain {
  [domain: string]: Rule;
}

interface GroupingConfig {
  byWindow: boolean;
  numWindowsToKeep: number | null | undefined;
}

interface SyncStore {
  getState: () => Promise<{
    rules: Rule[];
    grouping: { byWindow: boolean; numWindowsToKeep?: number | null };
  }>;
}

type Tab = chrome.tabs.Tab;

interface GroupMapEntry {
  readonly tabs: Tab[];
  readonly displayName: string;
  readonly domains: ReadonlySet<Domain>;
}

type GroupMap = Map<string, GroupMapEntry>;

interface GroupState {
  readonly title: string;
  readonly sourceDomain: string;
  readonly tabIds: readonly TabId[];
  readonly groupId: GroupId | null;
  readonly needsReposition: boolean;
}

interface GroupPlan {
  readonly states: ReadonlyArray<{
    tabIds: readonly TabId[];
    displayName: string;
    targetIndex: number;
    currentlyGrouped: readonly TabId[];
  }>;
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

function validateRule(rule: any): rule is Rule {
  if (typeof rule !== "object" || rule === null) return false;
  if (typeof rule.domain !== "string" || rule.domain.length === 0) return false;
  if (rule.autoDelete != null && typeof rule.autoDelete !== "boolean")
    return false;
  if (rule.skipProcess != null && typeof rule.skipProcess !== "boolean")
    return false;
  if (rule.groupName != null && typeof rule.groupName !== "string")
    return false;
  if (
    rule.splitByPath != null &&
    (typeof rule.splitByPath !== "number" || rule.splitByPath < 1)
  )
    return false;
  if (rule.autoDelete === true && rule.skipProcess === true) {
    console.warn(
      `Rule for "${rule.domain}": autoDelete and skipProcess are mutually exclusive — rule rejected`,
    );
    return false;
  }
  return true;
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
          return {
            key: `${base}::${seg}`,
            title: seg === base ? `${domain}/${seg}` : seg,
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
    const { title: expected } = this.getGroupKey(domain, url, rulesByDomain);
    return title === expected || title === `${domain} - ${expected}`;
  }

  buildGroupMap(tabs: Tab[], rulesByDomain: RulesByDomain): GroupMap {
    const map = new Map<string, GroupMapEntry>();
    for (const tab of tabs) {
      const domain = this.getDomain(tab.url);
      const { key, title } = this.getGroupKey(domain, tab.url, rulesByDomain);
      const existing = map.get(key);
      map.set(
        key,
        existing
          ? {
              tabs: [...existing.tabs, tab],
              displayName: title,
              domains: new Set([...existing.domains, domain]),
            }
          : { tabs: [tab], displayName: title, domains: new Set([domain]) },
      );
    }
    return map;
  }

  countDuplicates(tabs: Tab[]): number {
    const seen = new Map<Domain, Set<string>>();
    let count = 0;
    for (const tab of tabs) {
      const domain = this.getDomain(tab.url);
      if (!seen.has(domain)) seen.set(domain, new Set());
      const urls = seen.get(domain)!;
      if (tab.url && urls.has(tab.url)) count++;
      else if (tab.url) urls.add(tab.url);
    }
    return count;
  }

  filterValidTabs(
    tabs: Tab[],
    allowedDomains: ReadonlySet<Domain>,
    tabCache: ReadonlyMap<TabId, Tab>,
  ): Tab[] {
    return extractTabIds(tabs)
      .map((id) => tabCache.get(id))
      .filter(isDefined)
      .filter((t) => allowedDomains.has(this.getDomain(t.url)));
  }

  buildGroupStates(
    groupMap: GroupMap,
    tabCache: ReadonlyMap<TabId, Tab>,
    groupsByTitle?: Map<string, GroupId>,
  ): GroupState[] {
    const initial: GroupState[] = [];

    for (const { tabs, displayName, domains } of groupMap.values()) {
      const valid = this.filterValidTabs(tabs, domains, tabCache);
      if (valid.length === 0) continue;

      valid.sort((a, b) => (a.url || "").localeCompare(b.url || ""));
      initial.push({
        title: displayName,
        sourceDomain: Array.from(domains)[0] || "other",
        tabIds: extractTabIds(valid),
        groupId: null,
        needsReposition: false,
      });
    }

    const titleCounts = new Map<string, number>();
    for (const s of initial)
      titleCounts.set(s.title, (titleCounts.get(s.title) || 0) + 1);
    if (groupsByTitle) {
      for (const t of groupsByTitle.keys())
        if (titleCounts.has(t)) titleCounts.set(t, titleCounts.get(t)! + 1);
    }

    const resolved = initial.map((s) =>
      (titleCounts.get(s.title) || 0) > 1
        ? { ...s, title: `${s.sourceDomain} - ${s.title}` }
        : s,
    );

    return resolved.map((s) => {
      const validTabs = s.tabIds
        .map((id) => tabCache.get(id))
        .filter(isDefined);
      const existing = validTabs.find(isGrouped);
      const groupId =
        existing?.groupId != null
          ? asGroupId(existing.groupId)
          : groupsByTitle?.get(s.title) || null;
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
        state.tabIds.length >= 2
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
    } else if (state.tabIds.length === 1) {
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
        const ga = a.tabIds.length >= 2,
          gb = b.tabIds.length >= 2;
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
  ): GroupPlan {
    const states: GroupPlan["states"][number][] = [];
    let targetIndex = 0;

    for (const s of groupStates) {
      if (s.tabIds.length === 0) continue;
      if (s.needsReposition) {
        states.push({
          tabIds: s.tabIds,
          displayName: s.title,
          targetIndex,
          currentlyGrouped: s.tabIds.filter((id) => {
            const tab = tabCache.get(id);
            return tab && isGrouped(tab);
          }),
        });
      }
      targetIndex += s.tabIds.length;
    }

    return { states };
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
      return tabs.filter(
        (t) =>
          validateTab(t) && t.url && !t.url.startsWith("chrome-extension://"),
      );
    });
    if (!result.success) {
      console.error("Failed to get tabs:", result.error);
      return [];
    }
    return result.value;
  }

  async getRelevantTabs(
    rulesByDomain: RulesByDomain,
    service: TabGroupingService,
  ): Promise<Tab[]> {
    const [tabs, groups] = await Promise.all([
      this.getNormalTabs(),
      chrome.tabGroups.query({}),
    ]);
    const groupMap = new Map(groups.map((g) => [g.id, g]));

    return tabs.filter((tab) => {
      const domain = service.getDomain(tab.url);
      if (rulesByDomain[domain]?.skipProcess === true) return false;
      if (isGrouped(tab)) {
        const g = groupMap.get(tab.groupId!);
        if (
          g?.title &&
          !service.isInternalTitle(g.title, domain, tab.url, rulesByDomain)
        )
          return false;
      }
      return true;
    });
  }

  async deduplicateAllTabs(tabs: Tab[]): Promise<Tab[]> {
    const seen = new Set<string>();
    const unique: Tab[] = [];
    const dupes: TabId[] = [];

    for (const tab of tabs) {
      if (tab.url && !seen.has(tab.url)) {
        seen.add(tab.url);
        unique.push(tab);
      } else if (tab.id) dupes.push(asTabId(tab.id)!);
    }

    for (const batch of this.batch(dupes)) {
      const r = await retry(() => chrome.tabs.remove(batch as number[]));
      if (!r.success) console.warn("Failed to remove duplicates:", r.error);
      await this.sleep(this.RATE_DELAY);
    }

    return unique;
  }

  async applyAutoDeleteRules(
    tabs: Tab[],
    rulesByDomain: RulesByDomain,
    service: TabGroupingService,
  ): Promise<Tab[]> {
    const toDelete: TabId[] = [];
    const remaining: Tab[] = [];

    for (const tab of tabs) {
      const rule = rulesByDomain[service.getDomain(tab.url)];
      if (rule?.autoDelete && tab.id) toDelete.push(asTabId(tab.id)!);
      else remaining.push(tab);
    }

    for (const batch of this.batch(toDelete)) {
      const r = await retry(() => chrome.tabs.remove(batch as number[]));
      if (!r.success) console.warn("Failed to auto-delete:", r.error);
      await this.sleep(this.RATE_DELAY);
    }

    return remaining;
  }

  async mergeToActiveWindow(tabs: Tab[]): Promise<void> {
    const windows = await chrome.windows.getAll({ windowTypes: ["normal"] });
    if (windows.length <= 1) return;

    const active = await chrome.windows.getCurrent();
    const targetId = active.type === "normal" ? active.id : windows[0].id;
    if (!targetId) return;

    const toMove = tabs.filter((t) => t.windowId !== targetId);
    if (toMove.length === 0) return;

    for (const batch of this.batch(extractTabIds(toMove))) {
      const r = await retry(() =>
        chrome.tabs.move(batch as number[], { windowId: targetId, index: -1 }),
      );
      if (!r.success) console.warn("Failed to merge tabs:", r.error);
      await this.sleep(this.RATE_DELAY);
    }
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

  async applyGroupState(
    state: GroupState,
    tabCache: ReadonlyMap<TabId, Tab>,
    groupMap?: Map<number, chrome.tabGroups.TabGroup>,
  ): Promise<GroupState> {
    if (state.tabIds.length < 2) {
      await this.handleSingleTab(state, tabCache);
      return state;
    }
    return this.handleMultiTabGroup(state, tabCache, groupMap);
  }

  async executeGroupPlan(plan: GroupPlan): Promise<Result<void, Error>> {
    const snapshot = await this.captureState();

    try {
      for (const state of plan.states) {
        if (state.currentlyGrouped.length > 0) {
          const r = await retry(() =>
            chrome.tabs.ungroup(state.currentlyGrouped as number[]),
          );
          if (!r.success) {
            await this.rollback(snapshot);
            return r;
          }
          await this.sleep(this.RATE_DELAY);
        }

        const r = await retry(() =>
          chrome.tabs.move(state.tabIds as number[], {
            index: state.targetIndex,
          }),
        );
        if (!r.success) {
          await this.rollback(snapshot);
          return r;
        }
        await this.sleep(this.RATE_DELAY);

        if (state.tabIds.length >= 2) {
          const r = await retry(async () => {
            const gid = await chrome.tabs.group({
              tabIds: state.tabIds as number[],
            });
            await chrome.tabGroups.update(gid, {
              collapsed: false,
              title: state.displayName,
            });
            return gid;
          });
          if (!r.success) {
            await this.rollback(snapshot);
            return { success: false, error: r.error };
          }
          await this.sleep(this.RATE_DELAY);
        }
      }

      return { success: true, value: undefined };
    } catch (err) {
      await this.rollback(snapshot);
      return {
        success: false,
        error: err instanceof Error ? err : new Error(String(err)),
      };
    }
  }

  async ungroupSingleTabs(
    activeTabs: Tab[],
    allGroupedTabIds: Set<TabId>,
    tabCache: ReadonlyMap<TabId, Tab>,
    service: TabGroupingService,
  ): Promise<void> {
    const domainCounts = new Map<Domain, number>();

    for (const tab of activeTabs) {
      const d = service.getDomain(tab.url);
      domainCounts.set(d, (domainCounts.get(d) || 0) + 1);
    }

    const singles: TabId[] = [];
    for (const tab of activeTabs) {
      const tabId = asTabId(tab.id);
      if (!tabId || allGroupedTabIds.has(tabId)) continue;
      const domain = service.getDomain(tab.url);
      if (domainCounts.get(domain) !== 1) continue;
      const fresh = tabCache.get(tabId);
      if (fresh && isGrouped(fresh)) singles.push(tabId);
    }

    for (const batch of this.batch(singles)) {
      const r = await retry(() => chrome.tabs.ungroup(batch as number[]));
      if (!r.success) console.warn("Failed to ungroup singles:", r.error);
      await this.sleep(this.RATE_DELAY);
    }
  }

  async getGroupsInWindow(
    windowId: number,
  ): Promise<chrome.tabGroups.TabGroup[]> {
    return (await chrome.tabGroups.query({ windowId })) || [];
  }

  async updateBadge(service: TabGroupingService): Promise<void> {
    const tabs = await this.getNormalTabs();
    const count = service.countDuplicates(tabs);
    if (count > 0) {
      chrome.action.setBadgeText({ text: count.toString() });
      chrome.action.setBadgeBackgroundColor({ color: "#9688F1" });
    } else {
      chrome.action.setBadgeText({ text: "" });
    }
  }

  async moveTabsToWindow(
    tabIds: TabId[],
    targetWindowId: number,
  ): Promise<void> {
    if (tabIds.length === 0) return;
    for (const batch of this.batch(tabIds)) {
      const r = await retry(() =>
        chrome.tabs.move(batch as number[], {
          windowId: targetWindowId,
          index: -1,
        }),
      );
      if (!r.success)
        console.warn(
          `Failed to move tabs to window ${targetWindowId}:`,
          r.error,
        );
      await this.sleep(this.RATE_DELAY);
    }
  }

  private batch<T>(arr: readonly T[]): T[][] {
    const out: T[][] = [];
    for (let i = 0; i < arr.length; i += this.MAX_BATCH)
      out.push(arr.slice(i, i + this.MAX_BATCH) as T[]);
    return out;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  private async captureState() {
    const [tabs, groups] = await Promise.all([
      chrome.tabs.query({}),
      chrome.tabGroups.query({}),
    ]);
    return { tabs, groups };
  }

  // Best-effort partial ungroup only. Does NOT restore tab positions or re-create groups.
  // A failed executeGroupPlan mid-flight may leave tabs ungrouped but not repositioned.
  // Full fidelity rollback would require restoring chrome.tabs.move indices from snapshot,
  // which is deferred given Chrome's lack of atomic tab operations.
  private async rollback(snapshot: {
    tabs: Tab[];
    groups: chrome.tabGroups.TabGroup[];
  }): Promise<void> {
    console.warn("Rolling back (best-effort ungroup only)...");
    try {
      const current = new Map(
        (await chrome.tabs.query({})).map((t) => [t.id, t]),
      );
      for (const snap of snapshot.tabs) {
        if (!snap.id) continue;
        const cur = current.get(snap.id);
        if (cur && snap.groupId !== cur.groupId && snap.groupId === -1)
          await chrome.tabs.ungroup([snap.id]).catch(() => {});
      }
    } catch (err) {
      console.error("Rollback failed:", err);
    }
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

  async processGrouping(
    groupMap: GroupMap,
    windowId?: WindowId,
  ): Promise<Result<void, Error>> {
    try {
      const allTabs = await this.adapter.getNormalTabs();
      const scoped = windowId
        ? allTabs.filter((t) => t.windowId === windowId)
        : allTabs;
      const cache = new CacheManager(scoped);

      const groupsByTitle = new Map<string, GroupId>();
      const groupIdToGroup = new Map<number, chrome.tabGroups.TabGroup>();
      const groups = await this.adapter.getGroupsInWindow(
        windowId || (await chrome.windows.getCurrent()).id!,
      );
      for (const g of groups) {
        groupIdToGroup.set(g.id, g);
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
      );

      const applyResults = await Promise.allSettled(
        groupStates.map((s) =>
          this.adapter.applyGroupState(s, cache.snapshot(), groupIdToGroup),
        ),
      );

      const updatedGroupStates: GroupState[] = [];
      const failures: { title: string; error: unknown }[] = [];
      for (let i = 0; i < applyResults.length; i++) {
        const r = applyResults[i];
        if (r.status === "fulfilled") {
          updatedGroupStates.push(r.value);
        } else {
          updatedGroupStates.push(groupStates[i]);
          failures.push({ title: groupStates[i].title, error: r.reason });
        }
      }
      if (failures.length > 0) console.warn("Grouping errors:", failures);

      const freshTabs = await this.adapter.getNormalTabs();
      const freshScoped = windowId
        ? freshTabs.filter((t) => t.windowId === windowId)
        : freshTabs;
      await cache.invalidate(freshScoped);

      const grouped = new Set(updatedGroupStates.flatMap((s) => s.tabIds));
      await this.adapter.ungroupSingleTabs(
        freshScoped,
        grouped,
        cache.snapshot(),
        this.service,
      );

      const withReposition = this.service.calculateRepositionNeeds(
        updatedGroupStates,
        cache.snapshot(),
      );
      if (!withReposition.some((s) => s.needsReposition))
        return { success: true, value: undefined };

      const plan = this.service.createGroupPlan(
        withReposition,
        cache.snapshot(),
      );
      return this.adapter.executeGroupPlan(plan);
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

  private async prepareTabs(rulesByDomain: RulesByDomain): Promise<Tab[]> {
    const tabs = await this.adapter.getRelevantTabs(
      rulesByDomain,
      this.service,
    );
    const unique = await this.adapter.deduplicateAllTabs(tabs);
    return this.adapter.applyAutoDeleteRules(
      unique,
      rulesByDomain,
      this.service,
    );
  }

  private async consolidateWindows(
    tabs: Tab[],
    numWindowsToKeep: number,
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
      await this.adapter.moveTabsToWindow(tabIds, wid as number);
    }

    const freshTabs = await this.adapter.getNormalTabs();
    const retainedIds = new Set(retained.keys());
    const rebuilt = new Map<WindowId, Tab[]>();
    for (const tab of freshTabs) {
      if (!tab.windowId) continue;
      const wid = asWindowId(tab.windowId);
      if (!retainedIds.has(wid)) continue;
      if (!rebuilt.has(wid)) rebuilt.set(wid, []);
      rebuilt.get(wid)!.push(tab);
    }
    return rebuilt;
  }

  async execute(): Promise<void> {
    if (this.isProcessing) {
      console.log("Already processing, skipping...");
      return;
    }
    this.isProcessing = true;

    try {
      const config = await this.loadConfiguration();
      if (!config) return;
      const { rulesByDomain, config: groupingConfig } = config;

      const allTabs = await this.adapter.getNormalTabs();
      const hash = this.stateHash(allTabs, rulesByDomain, groupingConfig);
      if (this.lastStateHash === hash) {
        console.log("No state changes, skipping...");
        return;
      }

      if (!groupingConfig.byWindow) {
        const tabs = await this.adapter.getRelevantTabs(
          rulesByDomain,
          this.service,
        );
        await this.adapter.mergeToActiveWindow(tabs);
      }

      const processed = await this.prepareTabs(rulesByDomain);

      if (groupingConfig.byWindow) {
        const windowMap = isDefined(groupingConfig.numWindowsToKeep)
          ? await this.consolidateWindows(
              processed,
              groupingConfig.numWindowsToKeep,
            )
          : await this.groupByWindow(processed);
        for (const [wid, tabs] of windowMap) {
          const groupMap = this.service.buildGroupMap(tabs, rulesByDomain);
          const r = await this.processGrouping(groupMap, wid);
          if (!r.success)
            console.warn(`Grouping failed for window ${wid}:`, r.error);
        }
      } else {
        const groupMap = this.service.buildGroupMap(processed, rulesByDomain);
        const r = await this.processGrouping(groupMap);
        if (!r.success) console.error("Grouping failed:", r.error);
      }

      const final = await this.adapter.getNormalTabs();
      this.lastStateHash = this.stateHash(final, rulesByDomain, groupingConfig);
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
