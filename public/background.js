import deepEquals from "./utils/deepEquals.js";
import { startSyncStore } from "./utils/startSyncStore.js";

chrome.action.onClicked.addListener(collapseDuplicateDomains);
chrome.tabs.onCreated.addListener(updateBadge);
chrome.tabs.onRemoved.addListener(updateBadge);
chrome.tabs.onUpdated.addListener(updateBadge);

function getDomain(url) {
  try {
    const urlObj = new URL(url);
    return urlObj.hostname;
  } catch {
    return "other";
  }
}

function buildDomainMap(tabs) {
  const domainMap = {};
  tabs.forEach((tab) => {
    const domain = getDomain(tab.url);
    if (!domainMap[domain]) {
      domainMap[domain] = { tabs: [] };
    }
    domainMap[domain].tabs.push(tab);
  });
  return domainMap;
}

function countDuplicates(tabs) {
  const domainMap = {};
  let duplicateCount = 0;

  tabs.forEach((tab) => {
    const domain = getDomain(tab.url);
    if (!domainMap[domain]) {
      domainMap[domain] = new Set();
    }

    if (domainMap[domain].has(tab.url)) {
      duplicateCount++;
    } else {
      domainMap[domain].add(tab.url);
    }
  });

  return duplicateCount;
}

async function updateBadge() {
  const tabs = await chrome.tabs.query({});
  const duplicateCount = countDuplicates(tabs);

  if (duplicateCount > 0) {
    chrome.action.setBadgeText({ text: duplicateCount.toString() });
    chrome.action.setBadgeBackgroundColor({ color: "#9688F1" });
  } else {
    chrome.action.setBadgeText({ text: "" });
  }
}

function getWindowWithMostTabs(windowCounts) {
  return Object.entries(windowCounts).reduce(
    (max, [wId, count]) =>
      count > max.count ? { windowId: parseInt(wId), count } : max,
    { windowId: null, count: 0 },
  ).windowId;
}

async function deduplicateAllTabs(tabs) {
  const seen = new Set();
  const uniqueTabs = [];
  const duplicateIds = [];

  tabs.forEach((tab) => {
    if (!seen.has(tab.url)) {
      seen.add(tab.url);
      uniqueTabs.push(tab);
    } else {
      duplicateIds.push(tab.id);
    }
  });

  if (duplicateIds.length > 0) {
    await chrome.tabs.remove(duplicateIds);
  }

  return uniqueTabs;
}

async function applyAutoDeleteRules(tabs, rulesByDomain) {
  const toDelete = [];
  const remaining = [];

  tabs.forEach((tab) => {
    const domain = getDomain(tab.url);
    const ruleKey = Object.keys(rulesByDomain).find((d) => d.includes(domain));
    const rule = ruleKey ? rulesByDomain[ruleKey] : null;

    if (rule?.autoDelete) {
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

async function consolidateToWindow(tabs, targetWindow) {
  const tabsToMove = tabs.filter((t) => t.windowId !== targetWindow);
  if (tabsToMove.length > 0) {
    await chrome.tabs.move(
      tabsToMove.map((t) => t.id),
      { windowId: targetWindow, index: -1 },
    );
  }
}

function buildDomainToGroupMap(domainMap) {
  const domainToGroupId = {};
  const discoveredGroupId = new Set();

  for (const [domain, data] of Object.entries(domainMap)) {
    for (const tab of data.tabs) {
      const isDiscovered = discoveredGroupId.has(tab.groupId);
      !isDiscovered && discoveredGroupId.add(tab.groupId);
      if (domainToGroupId[domain] == null) {
        domainToGroupId[domain] = {
          tabs: [],
          groupID: isDiscovered ? null : tab.groupId,
        };
      }
      domainToGroupId[domain].tabs.push(tab);
    }
  }

  return domainToGroupId;
}

async function groupDomainTabs(domainMap) {
  const domainToGroupId = buildDomainToGroupMap(domainMap);
  for (const [domain, data] of Object.entries(domainToGroupId)) {
    const { groupID, tabs } = data;
    if (tabs.length < 2) {
      continue;
    }

    const tabIDs = tabs.map((t) => t.id);
    if (groupID == null || groupID === -1) {
      domainToGroupId[domain].groupID = await chrome.tabs.group({
        tabIds: tabIDs,
      });
    } else {
      const incorrectTabGroup = tabs.filter((t) => t.groupId !== -1);
      if (incorrectTabGroup.length > 0) {
        await chrome.tabs.ungroup(incorrectTabGroup.map((tab) => tab.id));
      }
      try {
        await chrome.tabs.group({ groupId: groupID, tabIds: tabIDs });
      } catch {
        domainToGroupId[domain].groupID = await chrome.tabs.group({
          tabIds: tabIDs,
        });
      }
    }

    await chrome.tabGroups.update(domainToGroupId[domain].groupID, {
      collapsed: false,
      title: domain,
    });
    const groupedTabs = await chrome.tabs.query({
      groupId: domainToGroupId[domain].groupID,
    });
    groupedTabs.sort((a, b) => a.url.localeCompare(b.url));
    const firstIndex = Math.min(...groupedTabs.map((t) => t.index));
    for (let i = 0; i < groupedTabs.length; i++) {
      await chrome.tabs.move(groupedTabs[i].id, { index: firstIndex + i });
    }
  }
}

async function getRelevantTabs(rulesByDomain) {
  const allTabs = await chrome.tabs.query({});
  return allTabs.filter((tab) => {
    const domain = getDomain(tab.url);
    const rule = rulesByDomain[domain];
    return rule?.skipProcess == null || rule?.skipProcess === false;
  });
}

function determineDomainMapIsSortable(domainMap) {
  for (const [domain, data] of Object.entries(domainMap)) {
    const { tabs } = data;
    if (tabs.length < 2) continue;

    // Check 1: Duplicate URLs
    const urls = new Set();
    for (const tab of tabs) {
      if (urls.has(tab.url)) return true;
      urls.add(tab.url);
    }

    // Check 3: Ungrouped tabs (when multiple tabs exist)
    const hasUngrouped = tabs.some((t) => t.groupId === -1);
    if (hasUngrouped) return true;

    // Check 4: Unsorted tabs within groups
    const grouped = tabs.filter((t) => t.groupId !== -1);
    if (grouped.length > 1) {
      const sortedUrls = [...grouped].sort((a, b) =>
        a.url.localeCompare(b.url),
      );
      for (let i = 0; i < grouped.length - 1; i++) {
        if (grouped[i].url !== sortedUrls[i].url) return true;
      }
    }
  }

  // Check 5: Mixed domains in same group (global check)
  const allTabs = Object.values(domainMap).flatMap((d) => d.tabs);
  const groupMap = {};
  for (const tab of allTabs) {
    if (tab.groupId === -1) continue;
    if (!groupMap[tab.groupId]) groupMap[tab.groupId] = new Set();
    groupMap[tab.groupId].add(getDomain(tab.url));
  }
  for (const domains of Object.values(groupMap)) {
    if (domains.size > 1) return true;
  }

  return false;
}

async function collapseDuplicateDomains() {
  try {
    const store = await startSyncStore({ rules: [] });
    const { rules } = await store.getState();

    const rulesByDomain = rules.reduce((acc, curr) => {
      if (curr.domain.length === 0) return acc;
      acc[curr.domain] = curr;
      return acc;
    }, {});

    let tabs = await getRelevantTabs(rulesByDomain);

    const windows = await chrome.windows.getAll();
    if (windows.length > 1) {
      const activeWindow = await chrome.windows.getCurrent();
      const targetWindow = activeWindow.id;
      const tabsToMove = tabs.filter((t) => t.windowId !== targetWindow);

      if (tabsToMove.length > 0) {
        await chrome.tabs.move(
          tabsToMove.map((t) => t.id),
          { windowId: targetWindow, index: -1 },
        );
      }
    }

    tabs = await getRelevantTabs(rulesByDomain);
    const isDomainMapSortable = determineDomainMapIsSortable(
      buildDomainMap(tabs),
    );
    if (isDomainMapSortable) {
      const uniqueTabs = await deduplicateAllTabs(tabs);
      const remainingTabs = await applyAutoDeleteRules(
        uniqueTabs,
        rulesByDomain,
      );
      await groupDomainTabs(buildDomainMap(remainingTabs));
    }
  } catch (e) {
    console.warn(e);
  }
}
