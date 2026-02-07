import startSyncStore from "./utils/startSyncStore.js";

chrome.action.onClicked.addListener(collapseDuplicateDomains);
chrome.tabs.onCreated.addListener(updateBadge);
chrome.tabs.onRemoved.addListener(updateBadge);
chrome.tabs.onUpdated.addListener(updateBadge);

function getDomain(url: string | undefined): string {
  if (!url) {
    return "other";
  }
  try {
    const urlObj = new URL(url);
    return urlObj.hostname;
  } catch {
    return "other";
  }
}

interface DomainMap {
  [domain: string]: { tabs: chrome.tabs.Tab[] };
}

function buildDomainMap(tabs: chrome.tabs.Tab[]): DomainMap {
  const domainMap: DomainMap = {};
  tabs.forEach((tab) => {
    const domain = getDomain(tab.url);
    if (!domainMap[domain]) {
      domainMap[domain] = { tabs: [] };
    }
    domainMap[domain].tabs.push(tab);
  });
  return domainMap;
}

function countDuplicates(tabs: chrome.tabs.Tab[]): number {
  const domainMap: { [domain: string]: Set<string> } = {};
  let duplicateCount = 0;

  tabs.forEach((tab) => {
    const domain = getDomain(tab.url);
    if (!domainMap[domain]) {
      domainMap[domain] = new Set();
    }

    if (tab.url && domainMap[domain].has(tab.url)) {
      duplicateCount++;
    } else if (tab.url) {
      domainMap[domain].add(tab.url);
    }
  });

  return duplicateCount;
}

async function updateBadge(): Promise<void> {
  const tabs = await getAllNonAppTabs();
  const duplicateCount = countDuplicates(tabs);

  if (duplicateCount > 0) {
    chrome.action.setBadgeText({ text: duplicateCount.toString() });
    chrome.action.setBadgeBackgroundColor({ color: "#9688F1" });
  } else {
    chrome.action.setBadgeText({ text: "" });
  }
}

async function deduplicateAllTabs(
  tabs: chrome.tabs.Tab[],
): Promise<chrome.tabs.Tab[]> {
  const seen = new Set<string>();
  const uniqueTabs: chrome.tabs.Tab[] = [];
  const duplicateIds: number[] = [];

  tabs.forEach((tab) => {
    if (tab.url && !seen.has(tab.url)) {
      seen.add(tab.url);
      uniqueTabs.push(tab);
    } else if (tab.id) {
      duplicateIds.push(tab.id);
    }
  });

  if (duplicateIds.length > 0) {
    await chrome.tabs.remove(duplicateIds);
  }

  return uniqueTabs;
}

interface Rule {
  domain: string;
  autoDelete: boolean;
  skipProcess: boolean;
}

interface RulesByDomain {
  [domain: string]: Rule;
}

async function applyAutoDeleteRules(
  tabs: chrome.tabs.Tab[],
  rulesByDomain: RulesByDomain,
): Promise<chrome.tabs.Tab[]> {
  const toDelete: number[] = [];
  const remaining: chrome.tabs.Tab[] = [];

  tabs.forEach((tab) => {
    const domain = getDomain(tab.url);
    const ruleKey = Object.keys(rulesByDomain).find((d) => d.includes(domain));
    const rule = ruleKey ? rulesByDomain[ruleKey] : null;

    if (rule?.autoDelete && tab.id) {
      toDelete.push(tab.id);
    } else {
      remaining.push(tab);
    }
  });

  if (toDelete.length > 0) {
    await chrome.tabs.remove(toDelete);
  }

  return remaining;
}

function extractTabIds(tabs: chrome.tabs.Tab[]): number[] {
  return tabs.map((t) => t.id).filter((id): id is number => id !== undefined);
}

function isGrouped(tab: chrome.tabs.Tab): boolean {
  return tab.groupId != null && tab.groupId !== -1;
}

async function ungroupSingleTab(
  tab: chrome.tabs.Tab | undefined,
): Promise<void> {
  if (tab?.id && isGrouped(tab)) {
    await chrome.tabs.ungroup([tab.id]);
  }
}

async function getValidTabsForDomain(
  tabs: chrome.tabs.Tab[],
  domain: string,
  tabCache: Map<number, chrome.tabs.Tab>,
): Promise<chrome.tabs.Tab[]> {
  const tabIDs = extractTabIds(tabs);
  const freshTabs = tabIDs
    .map((id) => tabCache.get(id))
    .filter((t): t is chrome.tabs.Tab => t !== undefined);
  return freshTabs.filter((t) => getDomain(t.url) === domain);
}

async function ungroupIfNeeded(tabs: chrome.tabs.Tab[]): Promise<void> {
  const tabIds = extractTabIds(tabs);
  if (tabIds.length > 0) {
    const grouped = tabs.filter(isGrouped);
    if (grouped.length > 0) {
      await chrome.tabs.ungroup(tabIds);
    }
  }
}

interface GroupState {
  domain: string;
  tabIds: number[];
  groupId: number | null;
  needsReposition: boolean;
}

interface GroupState {
  domain: string;
  tabIds: number[];
  groupId: number | null;
  needsReposition: boolean;
}

async function buildGroupState(
  domainMap: DomainMap,
  tabCache: Map<number, chrome.tabs.Tab>,
): Promise<GroupState[]> {
  const groupStates: GroupState[] = [];

  for (const [domain, data] of Object.entries(domainMap)) {
    const { tabs } = data;

    if (tabs.length < 2) {
      continue;
    }

    const validTabs = await getValidTabsForDomain(tabs, domain, tabCache);

    if (validTabs.length < 2) {
      continue;
    }

    validTabs.sort((a, b) => (a.url && b.url ? a.url.localeCompare(b.url) : 0));

    const existingGroup = validTabs.find(isGrouped);
    const sortedTabIds = extractTabIds(validTabs);

    groupStates.push({
      domain,
      tabIds: sortedTabIds,
      groupId: existingGroup?.groupId ?? null,
      needsReposition: false,
    });
  }

  return groupStates;
}

async function calculateRepositionNeeds(
  groupStates: GroupState[],
): Promise<GroupState[]> {
  groupStates.sort((a, b) => a.domain.localeCompare(b.domain));

  const allTabs = await getAllNonAppTabs();
  const tabIndexMap = new Map(allTabs.map((t) => [t.id, t.index]));

  let expectedIndex = 0;

  return groupStates.map((state) => {
    if (state.tabIds.length === 0) {
      return state;
    }

    const currentIndices = state.tabIds
      .map((id) => tabIndexMap.get(id))
      .filter((idx): idx is number => idx !== undefined);

    const currentFirstIndex =
      currentIndices.length > 0 ? Math.min(...currentIndices) : expectedIndex;

    const needsReposition = currentFirstIndex !== expectedIndex;
    expectedIndex += state.tabIds.length;

    return { ...state, needsReposition };
  });
}

async function applyGroupState(
  state: GroupState,
  tabCache: Map<number, chrome.tabs.Tab>,
): Promise<void> {
  if (state.tabIds.length < 2) {
    if (state.groupId !== null && state.tabIds.length > 0) {
      await chrome.tabs.ungroup(state.tabIds);
    }
    return;
  }

  if (state.groupId === null) {
    const newGroupId = await chrome.tabs.group({ tabIds: state.tabIds });
    await chrome.tabGroups.update(newGroupId, {
      collapsed: false,
      title: state.domain,
    });
    state.groupId = newGroupId;
  } else {
    const wrongGroup = state.tabIds.filter((id) => {
      const tab = tabCache.get(id);
      return tab && tab.groupId !== state.groupId && isGrouped(tab);
    });

    if (wrongGroup.length > 0) {
      await chrome.tabs.ungroup(wrongGroup);
    }

    try {
      await chrome.tabs.group({ groupId: state.groupId, tabIds: state.tabIds });
    } catch {
      const newGroupId = await chrome.tabs.group({ tabIds: state.tabIds });
      await chrome.tabGroups.update(newGroupId, {
        collapsed: false,
        title: state.domain,
      });
      state.groupId = newGroupId;
    }

    await chrome.tabGroups.update(state.groupId, {
      collapsed: false,
      title: state.domain,
    });
  }
}

export async function groupDomainTabs(domainMap: DomainMap): Promise<void> {
  const errors: Array<{ domain: string; error: Error }> = [];

  try {
    const allCurrentTabs = await getAllNonAppTabs();
    const tabCache = new Map(allCurrentTabs.map((t) => [t.id, t]));

    let groupStates = await buildGroupState(domainMap, tabCache);

    for (const state of groupStates) {
      try {
        await applyGroupState(state, tabCache);
      } catch (error) {
        errors.push({
          domain: state.domain,
          error: error instanceof Error ? error : new Error(String(error)),
        });
      }
    }

    const allGroupedTabIds = new Set(groupStates.flatMap((s) => s.tabIds));

    for (const [domain, data] of Object.entries(domainMap)) {
      if (data.tabs.length === 1) {
        const singleTab = data.tabs[0];
        if (
          singleTab?.id &&
          isGrouped(singleTab) &&
          !allGroupedTabIds.has(singleTab.id)
        ) {
          await chrome.tabs.ungroup([singleTab.id]);
        }
      }
    }

    groupStates = await calculateRepositionNeeds(groupStates);

    const needsReposition = groupStates.filter((s) => s.needsReposition);

    if (needsReposition.length === 0) {
      if (errors.length > 0) {
        console.warn("Grouping errors:", errors);
      }
      return;
    }

    for (const state of groupStates) {
      if (state.tabIds.length === 0) continue;
      await chrome.tabs.ungroup(state.tabIds);
    }

    let targetIndex = 0;
    for (const state of groupStates) {
      if (state.tabIds.length === 0) continue;

      await chrome.tabs.move(state.tabIds, { index: targetIndex });

      if (state.tabIds.length >= 2) {
        const newGroupId = await chrome.tabs.group({ tabIds: state.tabIds });
        await chrome.tabGroups.update(newGroupId, {
          collapsed: false,
          title: state.domain,
        });
      }

      targetIndex += state.tabIds.length;
    }
  } catch (error) {
    errors.push({
      domain: "global",
      error: error instanceof Error ? error : new Error(String(error)),
    });
  }

  if (errors.length > 0) {
    console.warn("Grouping errors:", errors);
  }
}

async function getAllNonAppTabs(): Promise<chrome.tabs.Tab[]> {
  const allTabs = await chrome.tabs.query({});
  const windows = await chrome.windows.getAll({ populate: false });
  const appWindowIds = new Set(
    windows.filter((w) => w.type === "app").map((w) => w.id),
  );

  return allTabs.filter((tab) => {
    if (!tab.url || tab.url.startsWith("chrome-extension://")) {
      return false;
    }
    if (tab.windowId && appWindowIds.has(tab.windowId)) {
      return false;
    }
    return true;
  });
}

async function getRelevantTabs(
  rulesByDomain: RulesByDomain,
): Promise<chrome.tabs.Tab[]> {
  const nonAppTabs = await getAllNonAppTabs();

  return nonAppTabs.filter((tab) => {
    const domain = getDomain(tab.url);
    const rule = rulesByDomain[domain];
    return rule?.skipProcess == null || rule?.skipProcess === false;
  });
}

interface SyncStore {
  getState: () => Promise<{ rules: Rule[] }>;
}

async function collapseDuplicateDomains(): Promise<void> {
  try {
    const store: SyncStore = await startSyncStore({ rules: [] });
    const { rules } = await store.getState();

    const rulesByDomain: RulesByDomain = rules.reduce(
      (acc: RulesByDomain, curr: Rule) => {
        if (curr.domain.length === 0) return acc;
        acc[curr.domain] = curr;
        return acc;
      },
      {},
    );

    let tabs = await getRelevantTabs(rulesByDomain);

    const windows = await chrome.windows.getAll();
    if (windows.length > 1) {
      const activeWindow = await chrome.windows.getCurrent();
      const targetWindow = activeWindow.id;
      const tabsToMove = tabs.filter((t) => t.windowId !== targetWindow);

      if (tabsToMove.length > 0) {
        await chrome.tabs.move(extractTabIds(tabsToMove), {
          windowId: targetWindow,
          index: -1,
        });
      }
    }

    tabs = await getRelevantTabs(rulesByDomain);
    const uniqueTabs = await deduplicateAllTabs(tabs);
    const remainingTabs = await applyAutoDeleteRules(uniqueTabs, rulesByDomain);

    const freshDomainMap = buildDomainMap(remainingTabs);
    await groupDomainTabs(freshDomainMap);
  } catch (e) {
    console.warn(e);
  }
}
