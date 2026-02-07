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
  const tabs = await chrome.tabs.query({});
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

interface DomainToGroupIdMap {
  [domain: string]: {
    tabs: chrome.tabs.Tab[];
    groupID: number | null;
  };
}

export function buildDomainToGroupMap(domainMap: DomainMap): DomainToGroupIdMap {
  const domainToGroupId: DomainToGroupIdMap = {};
  const discoveredGroupId = new Set<number>();

  for (const [domain, data] of Object.entries(domainMap)) {
    for (const tab of data.tabs) {
      if (tab.groupId) {
        const isDiscovered = discoveredGroupId.has(tab.groupId);
        if (!isDiscovered) {
          discoveredGroupId.add(tab.groupId);
        }
        if (domainToGroupId[domain] == null) {
          domainToGroupId[domain] = {
            tabs: [],
            groupID: isDiscovered ? null : tab.groupId,
          };
        }
        domainToGroupId[domain].tabs.push(tab);
      }
    }
  }

  return domainToGroupId;
}

export async function groupDomainTabs(domainMap: DomainMap): Promise<void> {
  const domainToGroupId = buildDomainToGroupMap(domainMap);
  for (const [domain, data] of Object.entries(domainToGroupId)) {
    const { groupID, tabs } = data;
    if (tabs.length < 2) {
      continue;
    }

    const tabIDs = tabs
      .map((t) => t.id)
      .filter((id) => id !== undefined) as number[];
    if (groupID == null || groupID === -1) {
      domainToGroupId[domain].groupID = await chrome.tabs.group({
        tabIds: tabIDs,
      });
    } else {
      const incorrectTabGroup = tabs.filter((t) => t.groupId !== groupID && t.groupId !== -1);
      if (incorrectTabGroup.length > 0) {
        await chrome.tabs.ungroup(
          incorrectTabGroup
            .map((tab) => tab.id)
            .filter((id) => id !== undefined) as number[],
        );
      }
      try {
        await chrome.tabs.group({ groupId: groupID, tabIds: tabIDs });
      } catch {
        domainToGroupId[domain].groupID = await chrome.tabs.group({
          tabIds: tabIDs,
        });
      }
    }

    if (domainToGroupId[domain].groupID !== null) {
      await chrome.tabGroups.update(domainToGroupId[domain].groupID as number, {
        collapsed: false,
        title: domain,
      });
      const groupedTabs = await chrome.tabs.query({
        groupId: domainToGroupId[domain].groupID as number,
      });
      const firstIndex = Math.min(...groupedTabs.map((t) => t.index));
      
      groupedTabs.sort((a, b) =>
        a.url && b.url ? a.url.localeCompare(b.url) : 0,
      );
      
      const sortedTabIds = groupedTabs.map((t) => t.id).filter((id): id is number => id !== undefined);

      if (sortedTabIds.length > 0) {
        await chrome.tabs.move(sortedTabIds, { index: firstIndex });
      }
    }
  }
}

async function getRelevantTabs(
  rulesByDomain: RulesByDomain,
): Promise<chrome.tabs.Tab[]> {
  const allTabs = await chrome.tabs.query({});
  const windows = await chrome.windows.getAll({ populate: false });
  const appWindowIds = new Set(
    windows.filter((w) => w.type === "app").map((w) => w.id),
  );

  return allTabs.filter((tab) => {
    if (
      !tab.url ||
      tab.url.startsWith("chrome-extension://") ||
      (tab.windowId && appWindowIds.has(tab.windowId))
    ) {
      return false;
    }

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
        await chrome.tabs.move(
          tabsToMove
            .map((t) => t.id)
            .filter((id): id is number => id !== undefined),
          { windowId: targetWindow, index: -1 },
        );
      }
    }

    // Get the latest tab status after potential moves
    tabs = await getRelevantTabs(rulesByDomain);
    
    // Always run the organization sequence. The functions are idempotent.
    const uniqueTabs = await deduplicateAllTabs(tabs);
    const remainingTabs = await applyAutoDeleteRules(
      uniqueTabs,
      rulesByDomain,
    );
    await groupDomainTabs(buildDomainMap(remainingTabs));

  } catch (e) {
    console.warn(e);
  }
}
