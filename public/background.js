import { startSyncStore } from "./utils/startSyncStore.js";

chrome.action.onClicked.addListener(collapseDuplicateDomains);
chrome.tabs.onCreated.addListener(updateBadge);
chrome.tabs.onRemoved.addListener(updateBadge);
chrome.tabs.onUpdated.addListener(updateBadge);

// chrome.commands.onCommand.addListener((command) => {
// switch (command) {
// case "merge-windows":
// collapseDuplicateDomains();
// break;
// case "collapse-tabs-by-window":
// break;
// }
// });

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
      domainMap[domain] = { tabs: [], windowCounts: {}, seen: new Set() };
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

function deduplicateTabs(tabs, seen) {
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

  return { uniqueTabs, duplicateIds };
}

function findHostTabAndGroup(tabs, targetWindow) {
  let hostTab = null;
  let existingGroupId = null;

  for (const tab of tabs) {
    if (tab.windowId === targetWindow) {
      if (!hostTab) hostTab = tab;
      if (tab.groupId !== -1 && !existingGroupId) {
        existingGroupId = tab.groupId;
      }
    }
  }

  return { hostTab: hostTab || tabs[0], existingGroupId };
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

async function groupOrMergeTabs(tabIds, existingGroupId) {
  if (existingGroupId) {
    const ungrouped = tabIds.filter((id, i) => {
      return !tabIds.slice(0, i).includes(id);
    });
    if (ungrouped.length > 0) {
      await chrome.tabs.group({ groupId: existingGroupId, tabIds: ungrouped });
    }
    return existingGroupId;
  }
  return await chrome.tabs.group({ tabIds });
}

async function collapseDuplicateDomains() {
  const tabs = await chrome.tabs.query({});
  const domainMap = buildDomainMap(tabs);
  const store = await startSyncStore({ rules: [] });
  console.log(await store.getState());
  try {
    for (const [domain, data] of Object.entries(domainMap)) {
      if (data.tabs.length > 1) {
        const targetWindow = getWindowWithMostTabs(data.windowCounts);
        const { uniqueTabs, duplicateIds } = deduplicateTabs(
          data.tabs,
          data.seen,
        );
        const { hostTab, existingGroupId } = findHostTabAndGroup(
          uniqueTabs,
          targetWindow,
        );
        if (duplicateIds.length > 0) {
          await chrome.tabs.remove(duplicateIds);
        }
        await consolidateToWindow(uniqueTabs, targetWindow);
        const uniqueTabIds = uniqueTabs.map((t) => t.id);
        if (uniqueTabIds.length > 1) {
          const groupId = await groupOrMergeTabs(uniqueTabIds, existingGroupId);
          await chrome.tabGroups.update(groupId, {
            collapsed: true,
            title: hostTab.title || domain,
          });
        }
      }
    }
  } catch (e) {
    console.warn(e);
  }
}
