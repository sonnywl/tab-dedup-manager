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
      domainMap[domain] = { tabs: [], windowCounts: {} };
    }
    domainMap[domain].tabs.push(tab);
    domainMap[domain].windowCounts[tab.windowId] =
      (domainMap[domain].windowCounts[tab.windowId] || 0) + 1;
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

async function groupDomainTabs(domainMap) {
  const domainGroups = {};

  for (const [domain, data] of Object.entries(domainMap)) {
    if (data.tabs.length < 2) continue;

    const targetWindow = getWindowWithMostTabs(data.windowCounts);
    await consolidateToWindow(data.tabs, targetWindow);

    const tabIds = data.tabs.map(t => t.id);
    const existingGroupId = domainGroups[domain] || data.tabs.find(t => t.groupId !== -1)?.groupId || null;

    if (existingGroupId) {
      const ungrouped = tabIds.filter(id => {
        const tab = data.tabs.find(t => t.id === id);
        return tab.groupId !== existingGroupId;
      });
      if (ungrouped.length > 0) {
        await chrome.tabs.group({ groupId: existingGroupId, tabIds: ungrouped });
      }
      domainGroups[domain] = existingGroupId;
    } else {
      const groupId = await chrome.tabs.group({ tabIds });
      await chrome.tabGroups.update(groupId, {
        collapsed: false,
        title: domain,
      });
      domainGroups[domain] = groupId;
    }
  }
}

async function sortTabsByGroupStatus(windowIds) {
  for (const windowId of windowIds) {
    const tabs = await chrome.tabs.query({ windowId });
    const grouped = tabs.filter(t => t.groupId !== -1);
    const ungrouped = tabs.filter(t => t.groupId === -1);
    
    const sortedTabs = [...grouped, ...ungrouped];
    for (let i = 0; i < sortedTabs.length; i++) {
      await chrome.tabs.move(sortedTabs[i].id, { index: i });
    }
  }
}

async function collapseDuplicateDomains() {
  try {
    const tabs = await chrome.tabs.query({});
    const store = await startSyncStore({ rules: [] });
    const { rules } = await store.getState();
    
    const rulesByDomain = rules.reduce((acc, curr) => {
      if (curr.domain.length === 0) return acc;
      acc[curr.domain] = curr;
      return acc;
    }, {});

    const uniqueTabs = await deduplicateAllTabs(tabs);
    const remainingTabs = await applyAutoDeleteRules(uniqueTabs, rulesByDomain);
    const domainMap = buildDomainMap(remainingTabs);
    
    await groupDomainTabs(domainMap);
    
    const windowIds = new Set(remainingTabs.map(t => t.windowId));
    await sortTabsByGroupStatus(windowIds);
    
  } catch (e) {
    console.warn(e);
  }
}