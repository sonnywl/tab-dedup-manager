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
}

interface SyncStore {
  getState: () => Promise<{
    rules: Rule[];
    grouping: {
      byWindow: boolean;
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

    tabs.forEach((tab) => {
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
    });

    return domainMap;
  }

  countDuplicates(tabs: Tab[]): number {
    const urlsByDomain = new Map<Domain, Set<string>>();
    let duplicateCount = 0;

    tabs.forEach((tab) => {
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
    });

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
  ): GroupState[] {
    const groupStates: GroupState[] = [];

    for (const data of domainMap.values()) {
      const { tabs, displayName, domains } = data;

      if (tabs.length < 2) {
        continue;
      }

      const validTabs = this.filterValidTabs(tabs, domains, tabCache);

      if (validTabs.length < 2) {
        continue;
      }

      validTabs.sort((a, b) =>
        a.url && b.url ? a.url.localeCompare(b.url) : 0,
      );

      const existingGroup = validTabs.find(isGrouped);
      const sortedTabIds = extractTabIds(validTabs);

      groupStates.push({
        domain: displayName,
        tabIds: sortedTabIds,
        groupId: existingGroup?.groupId
          ? asGroupId(existingGroup.groupId)
          : null,
        needsReposition: false,
      });
    }

    return groupStates;
  }

  calculateRepositionNeeds(
    groupStates: GroupState[],
    tabIndexMap: Map<TabId, number>,
  ): GroupState[] {
    const sorted = [...groupStates].sort((a, b) =>
      a.domain.localeCompare(b.domain),
    );

    let expectedIndex = 0;

    return sorted.map((state) => {
      if (state.tabIds.length === 0) {
        return state;
      }

      const currentIndices = state.tabIds
        .map((id) => tabIndexMap.get(id))
        .filter(isDefined);

      const currentFirstIndex =
        currentIndices.length > 0 ? Math.min(...currentIndices) : expectedIndex;

      const needsReposition = currentFirstIndex !== expectedIndex;
      expectedIndex += state.tabIds.length;

      return { ...state, needsReposition };
    });
  }

  createGroupPlan(groupStates: GroupState[]): GroupPlan {
    const toUngroup: TabId[] = [];
    const toGroup: Array<{ tabIds: readonly TabId[]; displayName: string }> =
      [];
    const toMove: Array<{ tabIds: readonly TabId[]; index: number }> = [];

    groupStates.forEach((state) => {
      if (state.tabIds.length === 0) return;
      toUngroup.push(...state.tabIds);
    });

    let targetIndex = 0;
    groupStates.forEach((state) => {
      if (state.tabIds.length === 0) return;

      toMove.push({ tabIds: state.tabIds, index: targetIndex });

      if (state.tabIds.length >= 2) {
        toGroup.push({ tabIds: state.tabIds, displayName: state.domain });
      }

      targetIndex += state.tabIds.length;
    });

    return { toUngroup, toGroup, toMove };
  }
}

// ============================================================================
// INFRASTRUCTURE LAYER (Chrome API)
// ============================================================================

export class ChromeTabAdapter {
  private readonly MAX_BATCH_SIZE = 100;
  private readonly RATE_LIMIT_DELAY = 50;

  async getAllNonAppTabs(): Promise<Tab[]> {
    const result = await retry(async () => {
      const allTabs = await chrome.tabs.query({});
      const windows = await chrome.windows.getAll({ populate: false });
      const appWindowIds = new Set(
        windows.filter((w) => w.type === "app").map((w) => w.id),
      );

      return allTabs.filter((tab) => {
        if (!validateTab(tab)) return false;
        if (!tab.url || tab.url.startsWith("chrome-extension://")) {
          return false;
        }
        if (tab.windowId && appWindowIds.has(tab.windowId)) {
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
    const nonAppTabs = await this.getAllNonAppTabs();

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

    tabs.forEach((tab) => {
      if (tab.url && !seen.has(tab.url)) {
        seen.add(tab.url);
        uniqueTabs.push(tab);
      } else if (tab.id) {
        duplicateIds.push(asTabId(tab.id)!);
      }
    });

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

    tabs.forEach((tab) => {
      const domain = service.getDomain(tab.url);
      const rule = rulesByDomain[domain];

      if (rule?.autoDelete && tab.id) {
        toDelete.push(asTabId(tab.id)!);
      } else {
        remaining.push(tab);
      }
    });

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
    const windows = await chrome.windows.getAll();
    if (windows.length <= 1) return;

    const activeWindow = await chrome.windows.getCurrent();
    const targetWindow = activeWindow.id;
    if (!targetWindow) return;

    const tabsToMove = tabs.filter((t) => t.windowId !== targetWindow);
    if (tabsToMove.length === 0) return;

    const batches = this.batchArray(
      extractTabIds(tabsToMove),
      this.MAX_BATCH_SIZE,
    );
    for (const batch of batches) {
      const result = await retry(() =>
        chrome.tabs.move(batch as number[], {
          windowId: targetWindow,
          index: -1,
        }),
      );
      if (!result.success) {
        console.warn("Failed to merge tabs to active window:", result.error);
      }
      await this.sleep(this.RATE_LIMIT_DELAY);
    }
  }

  async applyGroupState(
    state: GroupState,
    tabCache: Map<TabId, Tab>,
  ): Promise<void> {
    if (state.tabIds.length < 2) {
      if (state.groupId !== null && state.tabIds.length > 0) {
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
      return;
    }

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
    } else {
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

  async updateBadge(service: TabGroupingService): Promise<void> {
    const tabs = await this.getAllNonAppTabs();
    const duplicateCount = service.countDuplicates(tabs);

    if (duplicateCount > 0) {
      chrome.action.setBadgeText({ text: duplicateCount.toString() });
      chrome.action.setBadgeBackgroundColor({ color: "#9688F1" });
    } else {
      chrome.action.setBadgeText({ text: "" });
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
  private isProcessing = false;
  private service = new TabGroupingService();
  private adapter = new ChromeTabAdapter();

  async groupByWindow(tabs: Tab[]): Promise<Map<WindowId, Tab[]>> {
    const byWindow = new Map<WindowId, Tab[]>();

    tabs.forEach((tab) => {
      if (!tab.windowId) return;
      const windowId = asWindowId(tab.windowId);
      if (!byWindow.has(windowId)) {
        byWindow.set(windowId, []);
      }
      byWindow.get(windowId)!.push(tab);
    });

    return byWindow;
  }

  async processGrouping(
    domainMap: DomainMap,
    windowId?: WindowId,
  ): Promise<Result<void, Error>> {
    try {
      const allCurrentTabs = await this.adapter.getAllNonAppTabs();
      const relevantTabs = windowId
        ? allCurrentTabs.filter((t) => t.windowId === windowId)
        : allCurrentTabs;
      const tabCache = new Map(relevantTabs.map((t) => [asTabId(t.id)!, t]));

      let groupStates = this.service.buildGroupStates(domainMap, tabCache);

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

      const tabIndexMap = new Map(
        relevantTabs.map((t) => [asTabId(t.id)!, t.index]),
      );
      groupStates = this.service.calculateRepositionNeeds(
        groupStates,
        tabIndexMap,
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

  async execute(): Promise<void> {
    if (this.isProcessing) {
      console.log("Already processing, skipping...");
      return;
    }

    this.isProcessing = true;

    try {
      const store: SyncStore = await startSyncStore({
        rules: [],
        grouping: { byWindow: false },
      });
      const state = await store.getState();

      if (!state || !state.rules || !state.grouping) {
        console.error("Invalid store state:", state);
        return;
      }

      const { rules, grouping } = state;

      const validRules = rules.filter(validateRule);
      if (validRules.length !== rules.length) {
        console.warn(
          `Filtered ${rules.length - validRules.length} invalid rules`,
        );
      }

      const config: GroupingConfig = {
        byWindow: grouping.byWindow,
      };

      const rulesByDomain: RulesByDomain = validRules.reduce(
        (acc: RulesByDomain, curr: Rule) => {
          if (curr.domain.length === 0) return acc;
          acc[curr.domain] = curr;
          return acc;
        },
        {},
      );

      let tabs = await this.adapter.getRelevantTabs(
        rulesByDomain,
        this.service,
      );

      if (!config.byWindow) {
        await this.adapter.mergeToActiveWindow(tabs);
        tabs = await this.adapter.getRelevantTabs(rulesByDomain, this.service);
      }

      const uniqueTabs = await this.adapter.deduplicateAllTabs(tabs);
      const remainingTabs = await this.adapter.applyAutoDeleteRules(
        uniqueTabs,
        rulesByDomain,
        this.service,
      );

      if (config.byWindow) {
        const windowGroups = await this.groupByWindow(remainingTabs);

        const results = await Promise.allSettled(
          Array.from(windowGroups.entries()).map(
            async ([windowId, windowTabs]) => {
              const domainMap = this.service.buildDomainMap(
                windowTabs,
                rulesByDomain,
              );
              return this.processGrouping(domainMap, windowId);
            },
          ),
        );

        const failures = results.filter((r) => r.status === "rejected");
        if (failures.length > 0) {
          console.warn("Window processing errors:", failures);
        }
      } else {
        const domainMap = this.service.buildDomainMap(
          remainingTabs,
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
      this.isProcessing = false;
    }
  }
}

// ============================================================================
// EVENT HANDLERS
// ============================================================================

export function init() {
  const controller = new TabGroupingController();
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
// init();
