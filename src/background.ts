import startSyncStore from "./utils/startSyncStore.js";

// ============================================================================
// DOMAIN TYPES (Type Safety)
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
    grouping: {
      byWindow: boolean;
      numWindowsToKeep?: number | null;
    };
  }>;
}

type Tab = chrome.tabs.Tab;

interface DomainMapEntry {
  readonly tabs: Tab[];
  readonly displayName: string;
  readonly domains: ReadonlySet<Domain>;
}

type DomainMap = Map<string, DomainMapEntry>;

interface GroupState {
  readonly domain: string;
  readonly tabIds: readonly TabId[];
  groupId: GroupId | null;
  needsReposition: boolean;
}

interface GroupPlan {
  readonly toUngroup: readonly TabId[];
  readonly toGroup: ReadonlyArray<{
    tabIds: readonly TabId[];
    displayName: string;
  }>;
  readonly toMove: ReadonlyArray<{
    tabIds: readonly TabId[];
    index: number;
  }>;
}

type Result<T, E> = { success: true; value: T } | { success: false; error: E };

// ============================================================================
// UTILITIES
// ============================================================================

function isDefined<T>(value: T | undefined | null): value is T {
  return value !== undefined && value !== null;
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

function asDomain(str: string): Domain {
  return str as Domain;
}

function extractTabIds(tabs: Tab[]): TabId[] {
  return tabs.map((t) => asTabId(t.id)).filter(isDefined);
}

function isGrouped(tab: Tab): boolean {
  return tab.groupId != null && tab.groupId !== -1;
}

function debounce<T extends (...args: any[]) => any>(
  fn: T,
  delay: number,
): (...args: Parameters<T>) => void {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  return (...args: Parameters<T>) => {
    if (timeoutId) clearTimeout(timeoutId);
    timeoutId = setTimeout(() => fn(...args), delay);
  };
}

async function retry<T>(
  fn: () => Promise<T>,
  maxAttempts: number = 3,
  delayMs: number = 100,
): Promise<Result<T, Error>> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const value = await fn();
      return { success: true, value };
    } catch (error) {
      if (attempt === maxAttempts) {
        return {
          success: false,
          error: error instanceof Error ? error : new Error(String(error)),
        };
      }
      await new Promise((resolve) => setTimeout(resolve, delayMs * attempt));
    }
  }
  return {
    success: false,
    error: new Error("Retry failed: max attempts reached"),
  };
}

function validateRule(rule: any): rule is Rule {
  return (
    (typeof rule === "object" &&
      rule != null &&
      typeof rule.domain === "string" &&
      rule.autoDelete == null) ||
    (typeof rule.autoDelete === "boolean" && rule.skipProcess == null) ||
    (typeof rule.skipProcess === "boolean" &&
      (rule.groupName == null || typeof rule.groupName === "string"))
  );
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
// DOMAIN LAYER (Pure Functions)
// ============================================================================

export class TabGroupingService {
  getDomain(url: string | undefined): Domain {
    if (!url) {
      return asDomain("other");
    }
    try {
      const urlObj = new URL(url);
      return asDomain(urlObj.hostname);
    } catch {
      return asDomain("other");
    }
  }

  getGroupKey(domain: Domain, rulesByDomain: RulesByDomain): string {
    const rule = rulesByDomain[domain];
    return rule?.groupName || domain;
  }

  buildDomainMap(tabs: Tab[], rulesByDomain: RulesByDomain): DomainMap {
    const domainMap = new Map<string, DomainMapEntry>();

    for (const tab of tabs) {
      const domain = this.getDomain(tab.url);
      const groupKey = this.getGroupKey(domain, rulesByDomain);

      const existing = domainMap.get(groupKey);
      if (existing) {
        domainMap.set(groupKey, {
          tabs: [...existing.tabs, tab],
          displayName: existing.displayName,
          domains: new Set([...existing.domains, domain]),
        });
      } else {
        domainMap.set(groupKey, {
          tabs: [tab],
          displayName: groupKey,
          domains: new Set([domain]),
        });
      }
    }

    return domainMap;
  }

  countDuplicates(tabs: Tab[]): number {
    const urlsByDomain = new Map<Domain, Set<string>>();
    let duplicateCount = 0;

    for (const tab of tabs) {
      const domain = this.getDomain(tab.url);

      if (!urlsByDomain.has(domain)) {
        urlsByDomain.set(domain, new Set());
      }

      const urls = urlsByDomain.get(domain)!;
      if (tab.url && urls.has(tab.url)) {
        duplicateCount++;
      } else if (tab.url) {
        urls.add(tab.url);
      }
    }

    return duplicateCount;
  }

  filterValidTabs(
    tabs: Tab[],
    allowedDomains: ReadonlySet<Domain>,
    tabCache: Map<TabId, Tab>,
  ): Tab[] {
    const tabIds = extractTabIds(tabs);
    const freshTabs = tabIds.map((id) => tabCache.get(id)).filter(isDefined);

    return freshTabs.filter((t) => {
      const domain = this.getDomain(t.url);
      return allowedDomains.has(domain);
    });
  }

  buildGroupStates(
    domainMap: DomainMap,
    tabCache: Map<TabId, Tab>,
    groupsByTitle?: Map<string, GroupId>,
  ): GroupState[] {
    const groupStates: GroupState[] = [];

    for (const data of domainMap.values()) {
      const { tabs, displayName, domains } = data;

      const validTabs = this.filterValidTabs(tabs, domains, tabCache);

      if (validTabs.length === 0) {
        continue;
      }

      // Sort tabs within the group alphabetically by URL
      validTabs.sort((a, b) => (a.url || "").localeCompare(b.url || ""));

      // Try to find an existing group:
      // 1. By searching for already grouped tabs in the list
      // 2. By searching for a group with the same title in the window
      const existingInTabs = validTabs.find(isGrouped);
      const groupId =
        existingInTabs?.groupId != null
          ? asGroupId(existingInTabs.groupId)
          : groupsByTitle?.get(displayName) || null;

      const sortedTabIds = extractTabIds(validTabs);

      groupStates.push({
        domain: displayName,
        tabIds: sortedTabIds,
        groupId,
        needsReposition: false,
      });
    }

    return groupStates;
  }

  private validateGroupState(
    state: GroupState,
    tabCache: Map<TabId, Tab>,
    tabsInGroupCount: Map<number, number>,
    tabsInGroupIdMap: Map<number, Set<TabId>>,
    expectedIndex: number,
  ): boolean {
    const isConsistent = state.tabIds.every((id, i) => {
      const tab = tabCache.get(id);
      if (!tab) return false;

      const isAtRightIndex = tab.index === expectedIndex + i;
      const isInRightGroup =
        state.tabIds.length >= 2
          ? tab.groupId === state.groupId
          : tab.groupId === -1;

      return isAtRightIndex && isInRightGroup;
    });

    if (!isConsistent) return false;

    // Check if the group contains exactly and only the tabs it should have
    if (state.groupId !== null) {
      const actualCount = tabsInGroupCount.get(state.groupId as number) || 0;
      if (actualCount !== state.tabIds.length) return false;

      const currentTabIds = tabsInGroupIdMap.get(state.groupId as number);
      if (
        !currentTabIds ||
        !state.tabIds.every((id) => currentTabIds.has(id))
      ) {
        return false;
      }
    } else if (state.tabIds.length === 1) {
      // Single tab should not be in any group
      const tab = tabCache.get(state.tabIds[0]);
      if (tab && isGrouped(tab)) return false;
    }

    return true;
  }

  calculateRepositionNeeds(
    groupStates: GroupState[],
    tabCache: Map<TabId, Tab>,
  ): GroupState[] {
    const tabsInGroupCount = new Map<number, number>();
    const tabsInGroupIdMap = new Map<number, Set<TabId>>();

    for (const tab of tabCache.values()) {
      if (isGrouped(tab)) {
        const gid = tab.groupId!;
        tabsInGroupCount.set(gid, (tabsInGroupCount.get(gid) || 0) + 1);
        if (!tabsInGroupIdMap.has(gid)) {
          tabsInGroupIdMap.set(gid, new Set());
        }
        tabsInGroupIdMap.get(gid)!.add(asTabId(tab.id)!);
      }
    }

    // Sort groups alphabetically based on the URL of their constituent tabs
    const sorted = [...groupStates].sort((a, b) => {
      const isGroupA = a.tabIds.length >= 2;
      const isGroupB = b.tabIds.length >= 2;

      if (isGroupA !== isGroupB) {
        return isGroupA ? -1 : 1;
      }

      const urlA = tabCache.get(a.tabIds[0])?.url || "";
      const urlB = tabCache.get(b.tabIds[0])?.url || "";
      return urlA.localeCompare(urlB);
    });

    let expectedIndex = 0;
    const results: GroupState[] = [];

    for (const state of sorted) {
      const isValid = this.validateGroupState(
        state,
        tabCache,
        tabsInGroupCount,
        tabsInGroupIdMap,
        expectedIndex,
      );

      results.push({ ...state, needsReposition: !isValid });
      expectedIndex += state.tabIds.length;
    }

    return results;
  }

  createGroupPlan(groupStates: GroupState[]): GroupPlan {
    const toUngroup: TabId[] = [];
    const toGroup: Array<{ tabIds: readonly TabId[]; displayName: string }> =
      [];
    const toMove: Array<{ tabIds: readonly TabId[]; index: number }> = [];

    let targetIndex = 0;
    for (const state of groupStates) {
      if (state.tabIds.length === 0) continue;

      if (state.needsReposition) {
        toUngroup.push(...state.tabIds);
        toMove.push({ tabIds: state.tabIds, index: targetIndex });
        if (state.tabIds.length >= 2) {
          toGroup.push({ tabIds: state.tabIds, displayName: state.domain });
        }
      }

      targetIndex += state.tabIds.length;
    }

    return { toUngroup, toGroup, toMove };
  }
}

export class WindowManagementService {
  calculateMergePlan(
    retainedWindows: Map<WindowId, Tab[]>,
    excessTabs: Tab[],
    service: TabGroupingService,
  ): Map<WindowId, TabId[]> {
    const plan = new Map<WindowId, TabId[]>();

    // Pre-calculate domain counts for each retained window
    const windowDomainCounts = new Map<WindowId, Map<Domain, number>>();

    for (const [windowId, tabs] of retainedWindows) {
      const counts = new Map<Domain, number>();
      for (const tab of tabs) {
        const domain = service.getDomain(tab.url);
        counts.set(domain, (counts.get(domain) || 0) + 1);
      }
      windowDomainCounts.set(windowId, counts);
    }

    // Find the default window (the one with the most tabs)
    let defaultWindowId: WindowId | undefined;
    let maxTabs = -1;
    for (const [windowId, tabs] of retainedWindows) {
      if (tabs.length > maxTabs) {
        maxTabs = tabs.length;
        defaultWindowId = windowId;
      }
    }

    for (const tab of excessTabs) {
      const domain = service.getDomain(tab.url);
      let bestWindowId = defaultWindowId;
      let maxDomainCount = 0;

      for (const [windowId, counts] of windowDomainCounts) {
        const count = counts.get(domain) || 0;
        if (count > maxDomainCount) {
          maxDomainCount = count;
          bestWindowId = windowId;
        }
      }

      if (bestWindowId && tab.id) {
        if (!plan.has(bestWindowId)) {
          plan.set(bestWindowId, []);
        }
        plan.get(bestWindowId)!.push(asTabId(tab.id)!);
      }
    }

    return plan;
  }
}

// ============================================================================
// INFRASTRUCTURE LAYER (Chrome API)
// ============================================================================

export class ChromeTabAdapter {
  private readonly MAX_BATCH_SIZE = 100;
  private readonly RATE_LIMIT_DELAY = 50;

  async getNormalTabs(): Promise<Tab[]> {
    const result = await retry(async () => {
      // Query only for tabs in normal windows to avoid "Tabs can only be moved to and from normal windows" error
      const allTabs = await chrome.tabs.query({ windowType: "normal" });

      return allTabs.filter((tab) => {
        if (!validateTab(tab)) return false;
        // Skip extension internal pages
        if (!tab.url || tab.url.startsWith("chrome-extension://")) {
          return false;
        }
        return true;
      });
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
    const nonAppTabs = await this.getNormalTabs();

    return nonAppTabs.filter((tab) => {
      const domain = service.getDomain(tab.url);
      const rule = rulesByDomain[domain];
      return rule?.skipProcess == null || rule?.skipProcess === false;
    });
  }

  async deduplicateAllTabs(tabs: Tab[]): Promise<Tab[]> {
    const seen = new Set<string>();
    const uniqueTabs: Tab[] = [];
    const duplicateIds: TabId[] = [];

    for (const tab of tabs) {
      if (tab.url && !seen.has(tab.url)) {
        seen.add(tab.url);
        uniqueTabs.push(tab);
      } else if (tab.id) {
        duplicateIds.push(asTabId(tab.id)!);
      }
    }

    if (duplicateIds.length > 0) {
      const batches = this.batchArray(duplicateIds, this.MAX_BATCH_SIZE);
      for (const batch of batches) {
        const result = await retry(() => chrome.tabs.remove(batch as number[]));
        if (!result.success) {
          console.warn("Failed to remove duplicate tabs:", result.error);
        }
        await this.sleep(this.RATE_LIMIT_DELAY);
      }
    }

    return uniqueTabs;
  }

  async applyAutoDeleteRules(
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

    if (toDelete.length > 0) {
      const batches = this.batchArray(toDelete, this.MAX_BATCH_SIZE);
      for (const batch of batches) {
        const result = await retry(() => chrome.tabs.remove(batch as number[]));
        if (!result.success) {
          console.warn("Failed to auto-delete tabs:", result.error);
        }
        await this.sleep(this.RATE_LIMIT_DELAY);
      }
    }

    return remaining;
  }

  async mergeToActiveWindow(tabs: Tab[]): Promise<void> {
    const normalWindows = await chrome.windows.getAll({
      windowTypes: ["normal"],
    });
    if (normalWindows.length <= 1) return;

    const activeWindow = await chrome.windows.getCurrent();
    // Use current window if it's normal, otherwise fallback to the first available normal window
    const targetWindowId =
      activeWindow.type === "normal" ? activeWindow.id : normalWindows[0].id;
    if (!targetWindowId) return;

    const tabsToMove = tabs.filter((t) => t.windowId !== targetWindowId);
    if (tabsToMove.length === 0) return;

    const batches = this.batchArray(
      extractTabIds(tabsToMove),
      this.MAX_BATCH_SIZE,
    );
    for (const batch of batches) {
      const result = await retry(() =>
        chrome.tabs.move(batch as number[], {
          windowId: targetWindowId,
          index: -1,
        }),
      );
      if (!result.success) {
        console.warn("Failed to merge tabs to active window:", result.error);
      }
      await this.sleep(this.RATE_LIMIT_DELAY);
    }
  }

  private async handleSingleTab(state: GroupState): Promise<void> {
    if (state.groupId === null || state.tabIds.length === 0) return;

    const result = await retry(() =>
      chrome.tabs.ungroup(state.tabIds as number[]),
    );
    if (!result.success) {
      console.warn(
        `Failed to ungroup single tab for ${state.domain}:`,
        result.error,
      );
    }
  }

  private async handleMultiTabGroup(
    state: GroupState,
    tabCache: Map<TabId, Tab>,
  ): Promise<void> {
    if (state.groupId === null) {
      const result = await retry(() =>
        chrome.tabs.group({ tabIds: state.tabIds as number[] }),
      );
      if (!result.success) {
        console.error(
          `Failed to create group for ${state.domain}:`,
          result.error,
        );
        return;
      }

      const updateResult = await retry(() =>
        chrome.tabGroups.update(result.value, {
          collapsed: false,
          title: state.domain,
        }),
      );

      if (updateResult.success) {
        state.groupId = asGroupId(result.value);
      }
      return;
    }

    const wrongGroup = state.tabIds.filter((id) => {
      const tab = tabCache.get(id);
      return tab && tab.groupId !== state.groupId && isGrouped(tab);
    });

    if (wrongGroup.length > 0) {
      await retry(() => chrome.tabs.ungroup(wrongGroup as number[]));
    }

    const groupResult = await retry(() =>
      chrome.tabs.group({
        groupId: state.groupId as number,
        tabIds: state.tabIds as number[],
      }),
    );

    if (!groupResult.success) {
      const newGroupResult = await retry(() =>
        chrome.tabs.group({ tabIds: state.tabIds as number[] }),
      );
      if (!newGroupResult.success) {
        console.error(
          `Failed to create new group for ${state.domain}:`,
          newGroupResult.error,
        );
        return;
      }
      state.groupId = asGroupId(newGroupResult.value);
    }

    await retry(() =>
      chrome.tabGroups.update(state.groupId as number, {
        collapsed: false,
        title: state.domain,
      }),
    );
  }

  async applyGroupState(
    state: GroupState,
    tabCache: Map<TabId, Tab>,
  ): Promise<void> {
    if (state.tabIds.length < 2) {
      await this.handleSingleTab(state);
    } else {
      await this.handleMultiTabGroup(state, tabCache);
    }
  }

  async executeGroupPlan(plan: GroupPlan): Promise<Result<void, Error>> {
    const snapshot = await this.captureState();

    try {
      if (plan.toUngroup.length > 0) {
        const batches = this.batchArray(plan.toUngroup, this.MAX_BATCH_SIZE);
        for (const batch of batches) {
          const result = await retry(() =>
            chrome.tabs.ungroup(batch as number[]),
          );
          if (!result.success) {
            await this.rollback(snapshot);
            return result;
          }
          await this.sleep(this.RATE_LIMIT_DELAY);
        }
      }

      for (const moveOp of plan.toMove) {
        const result = await retry(() =>
          chrome.tabs.move(moveOp.tabIds as number[], { index: moveOp.index }),
        );
        if (!result.success) {
          await this.rollback(snapshot);
          return result;
        }
        await this.sleep(this.RATE_LIMIT_DELAY);
      }

      for (const groupOp of plan.toGroup) {
        const result = await retry(async () => {
          const newGroupId = await chrome.tabs.group({
            tabIds: groupOp.tabIds as number[],
          });
          await chrome.tabGroups.update(newGroupId, {
            collapsed: false,
            title: groupOp.displayName,
          });
          return newGroupId;
        });

        if (!result.success) {
          await this.rollback(snapshot);
          return { success: false, error: result.error };
        }
        await this.sleep(this.RATE_LIMIT_DELAY);
      }

      return { success: true, value: undefined };
    } catch (error) {
      await this.rollback(snapshot);
      return {
        success: false,
        error: error instanceof Error ? error : new Error(String(error)),
      };
    }
  }

  async ungroupSingleTabs(
    domainMap: DomainMap,
    allGroupedTabIds: Set<TabId>,
  ): Promise<void> {
    const singles: TabId[] = [];

    for (const data of domainMap.values()) {
      if (data.tabs.length === 1) {
        const singleTab = data.tabs[0];
        const tabId = asTabId(singleTab?.id);
        if (tabId && isGrouped(singleTab) && !allGroupedTabIds.has(tabId)) {
          singles.push(tabId);
        }
      }
    }

    if (singles.length > 0) {
      const batches = this.batchArray(singles, this.MAX_BATCH_SIZE);
      for (const batch of batches) {
        const result = await retry(() =>
          chrome.tabs.ungroup(batch as number[]),
        );
        if (!result.success) {
          console.warn("Failed to ungroup single tabs:", result.error);
        }
        await this.sleep(this.RATE_LIMIT_DELAY);
      }
    }
  }

  async getGroupsInWindow(
    windowId: number,
  ): Promise<chrome.tabGroups.TabGroup[]> {
    return (await chrome.tabGroups.query({ windowId })) || [];
  }

  async updateBadge(service: TabGroupingService): Promise<void> {
    const tabs = await this.getNormalTabs();
    const duplicateCount = service.countDuplicates(tabs);

    if (duplicateCount > 0) {
      chrome.action.setBadgeText({ text: duplicateCount.toString() });
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

    const batches = this.batchArray(tabIds, this.MAX_BATCH_SIZE);
    for (const batch of batches) {
      const result = await retry(() =>
        chrome.tabs.move(batch as number[], {
          windowId: targetWindowId,
          index: -1,
        }),
      );
      if (!result.success) {
        console.warn(
          `Failed to move tabs to window ${targetWindowId}:`,
          result.error,
        );
      }
      await this.sleep(this.RATE_LIMIT_DELAY);
    }
  }

  private batchArray<T>(array: readonly T[], batchSize: number): T[][] {
    const batches: T[][] = [];
    for (let i = 0; i < array.length; i += batchSize) {
      batches.push(array.slice(i, i + batchSize) as T[]);
    }
    return batches;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async captureState(): Promise<{
    tabs: Tab[];
    groups: chrome.tabGroups.TabGroup[];
  }> {
    const tabs = await chrome.tabs.query({});
    const groups = await chrome.tabGroups.query({});
    return { tabs, groups };
  }

  private async rollback(snapshot: {
    tabs: Tab[];
    groups: chrome.tabGroups.TabGroup[];
  }): Promise<void> {
    console.warn("Rolling back to previous state...");
    // Best effort rollback - log errors but continue
    try {
      const currentTabs = await chrome.tabs.query({});
      const tabsById = new Map(currentTabs.map((t) => [t.id, t]));

      for (const snapshotTab of snapshot.tabs) {
        if (!snapshotTab.id) continue;
        const currentTab = tabsById.get(snapshotTab.id);
        if (!currentTab) continue;

        // Restore group membership
        if (snapshotTab.groupId !== currentTab.groupId) {
          if (snapshotTab.groupId === -1) {
            await chrome.tabs.ungroup([snapshotTab.id]).catch(() => {});
          }
        }
      }
    } catch (error) {
      console.error("Rollback failed:", error);
    }
  }
}

// ============================================================================
// APPLICATION LAYER (Orchestration)
// ============================================================================

export class TabGroupingController {
  private static isProcessing = false;
  private service = new TabGroupingService();
  private windowService = new WindowManagementService();
  private adapter = new ChromeTabAdapter();

  async groupByWindow(tabs: Tab[]): Promise<Map<WindowId, Tab[]>> {
    const byWindow = new Map<WindowId, Tab[]>();

    for (const tab of tabs) {
      if (!tab.windowId) continue;
      const windowId = asWindowId(tab.windowId);
      if (!byWindow.has(windowId)) {
        byWindow.set(windowId, []);
      }
      byWindow.get(windowId)!.push(tab);
    }

    return byWindow;
  }

  async processGrouping(
    domainMap: DomainMap,
    windowId?: WindowId,
  ): Promise<Result<void, Error>> {
    try {
      let allCurrentTabs = await this.adapter.getNormalTabs();
      let relevantTabs = windowId
        ? allCurrentTabs.filter((t) => t.windowId === windowId)
        : allCurrentTabs;
      let tabCache = new Map(relevantTabs.map((t) => [asTabId(t.id)!, t]));

      const groupsByTitle = new Map<string, GroupId>();
      if (windowId) {
        const groups = await this.adapter.getGroupsInWindow(windowId);
        for (const g of groups) {
          if (g.title) {
            groupsByTitle.set(g.title, asGroupId(g.id));
          }
        }
      }

      let groupStates = this.service.buildGroupStates(
        domainMap,
        tabCache,
        groupsByTitle,
      );

      const results = await Promise.allSettled(
        groupStates.map((s) => this.adapter.applyGroupState(s, tabCache)),
      );

      const failures = results
        .map((r, i) => ({ result: r, state: groupStates[i] }))
        .filter(({ result }) => result.status === "rejected")
        .map(({ result, state }) => ({
          domain: state.domain,
          error: (result as PromiseRejectedResult).reason,
        }));

      if (failures.length > 0) {
        console.warn("Grouping errors:", failures);
      }

      const allGroupedTabIds = new Set(groupStates.flatMap((s) => s.tabIds));
      await this.adapter.ungroupSingleTabs(domainMap, allGroupedTabIds);

      // Refresh cache after grouping as it may have changed indices and group IDs
      allCurrentTabs = await this.adapter.getNormalTabs();
      relevantTabs = windowId
        ? allCurrentTabs.filter((t) => t.windowId === windowId)
        : allCurrentTabs;
      tabCache = new Map(relevantTabs.map((t) => [asTabId(t.id)!, t]));

      groupStates = this.service.calculateRepositionNeeds(
        groupStates,
        tabCache,
      );

      const needsReposition = groupStates.filter((s) => s.needsReposition);

      if (needsReposition.length === 0) {
        return { success: true, value: undefined };
      }

      const plan = this.service.createGroupPlan(groupStates);
      return await this.adapter.executeGroupPlan(plan);
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error : new Error(String(error)),
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

    if (!state || !state.rules || !state.grouping) {
      console.error("Invalid store state:", state);
      return null;
    }

    const validRules = state.rules.filter(validateRule);
    if (validRules.length !== state.rules.length) {
      console.warn(
        `Filtered ${state.rules.length - validRules.length} invalid rules`,
      );
    }

    const rulesByDomain: RulesByDomain = {};
    for (const rule of validRules) {
      if (rule.domain.length > 0) {
        rulesByDomain[rule.domain] = rule;
      }
    }

    const config: GroupingConfig = {
      byWindow: state.grouping.byWindow,
      numWindowsToKeep: state.grouping.numWindowsToKeep,
    };

    return { rulesByDomain, config };
  }

  private async prepareTabs(rulesByDomain: RulesByDomain): Promise<Tab[]> {
    let tabs = await this.adapter.getRelevantTabs(rulesByDomain, this.service);

    const uniqueTabs = await this.adapter.deduplicateAllTabs(tabs);
    return await this.adapter.applyAutoDeleteRules(
      uniqueTabs,
      rulesByDomain,
      this.service,
    );
  }

  private async consolidateWindows(
    tabs: Tab[],
    numWindowsToKeep: number,
  ): Promise<Map<WindowId, Tab[]>> {
    const windowGroups = await this.groupByWindow(tabs);
    const windowEntries = Array.from(windowGroups.entries());

    if (windowEntries.length <= numWindowsToKeep) {
      return windowGroups;
    }

    // Sort windows by amount of tabs (descending)
    windowEntries.sort((a, b) => b[1].length - a[1].length);

    const retainedEntries = windowEntries.slice(0, numWindowsToKeep);
    const excessEntries = windowEntries.slice(numWindowsToKeep);

    const retainedMap = new Map(retainedEntries);
    const excessTabs = excessEntries.flatMap((e) => e[1]);

    const mergePlan = this.windowService.calculateMergePlan(
      retainedMap,
      excessTabs,
      this.service,
    );

    for (const [targetWindowId, tabIds] of mergePlan.entries()) {
      await this.adapter.moveTabsToWindow(tabIds, targetWindowId as number);
      // Update local state for robustness and test mocks
      const targetTabs = retainedMap.get(targetWindowId)!;
      const movedTabs = excessTabs.filter((t) =>
        tabIds.includes(asTabId(t.id)!),
      );
      targetTabs.push(...movedTabs);
    }

    return retainedMap;
  }

  private async processWindowGroups(
    windowGroups: Map<WindowId, Tab[]>,
    rulesByDomain: RulesByDomain,
  ): Promise<void> {
    for (const [windowId, windowTabs] of windowGroups) {
      const domainMap = this.service.buildDomainMap(windowTabs, rulesByDomain);
      const result = await this.processGrouping(domainMap, windowId);
      if (!result.success) {
        console.warn(`Grouping failed for window ${windowId}:`, result.error);
      }
    }
  }

  async execute(): Promise<void> {
    if (TabGroupingController.isProcessing) {
      console.log("Already processing, skipping...");
      return;
    }

    TabGroupingController.isProcessing = true;

    try {
      const configData = await this.loadConfiguration();
      if (!configData) return;

      const { rulesByDomain, config } = configData;

      let tabs = await this.adapter.getRelevantTabs(
        rulesByDomain,
        this.service,
      );

      if (!config.byWindow) {
        await this.adapter.mergeToActiveWindow(tabs);
        // Refresh tabs after merge
        tabs = await this.adapter.getRelevantTabs(rulesByDomain, this.service);
      }

      const processedTabs = await this.prepareTabs(rulesByDomain);

      if (config.byWindow) {
        let windowMap: Map<WindowId, Tab[]>;
        if (isDefined(config.numWindowsToKeep)) {
          windowMap = await this.consolidateWindows(
            processedTabs,
            config.numWindowsToKeep,
          );
        } else {
          windowMap = await this.groupByWindow(processedTabs);
        }
        await this.processWindowGroups(windowMap, rulesByDomain);
      } else {
        const domainMap = this.service.buildDomainMap(
          processedTabs,
          rulesByDomain,
        );
        const result = await this.processGrouping(domainMap);
        if (!result.success) {
          console.error("Grouping failed:", result.error);
        }
      }
    } catch (e) {
      console.warn("Execute error:", e);
    } finally {
      TabGroupingController.isProcessing = false;
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

// In a non-test environment, you would typically call init() here:
if (typeof process === "undefined" || process.env.NODE_ENV !== "test") {
  init();
}
