import { Tab, asTabId } from "@/types";

import { vi } from "vitest";

export let currentTabs: Tab[] = [];
export const currentGroups = new Map<number, chrome.tabGroups.TabGroup>();

/**
 * Creates a mock Chrome Tab object for testing.
 * Standardizes tab creation across the test suite.
 */
export const mkTab = (
  id: number,
  url: string,
  groupId: number | null = null,
  index = 0,
  windowId = 1,
  pinned = false,
  title = "",
): Tab => {
  const hasProtocol = /^[a-z-]+:/.test(url);
  return {
    id,
    url: hasProtocol ? url : `https://${url}`,
    index,
    windowId,
    groupId: groupId === null ? -1 : groupId,
    pinned,
    active: false,
    audible: false,
    autoDiscardable: true,
    discarded: false,
    favIconUrl: "",
    height: 0,
    highlighted: false,
    incognito: false,
    mutedInfo: { muted: false },
    selected: false,
    status: "complete",
    title: title,
    width: 0,
  } as Tab;
};

/**
 * Helper to extract tab IDs from an array of tabs and cast them to TabId.
 */
export const getTabIds = (tabs: Tab[]) => tabs.map((t) => asTabId(t.id)!);

/**
 * Properly moves tabs within currentTabs, handling index shifts and re-indexing.
 */
export const moveTabsInMock = (
  tabIds: number[],
  targetIndex: number,
  targetWindowId: number,
) => {
  const ids = Array.isArray(tabIds) ? tabIds : [tabIds];

  // 1. Separate tabs being moved and those staying
  const tabsToMove = ids.map((id) => currentTabs.find((t) => t.id === id)!);
  let otherTabs = currentTabs.filter((t) => !ids.includes(t.id));

  // 2. Identify target window tabs
  let targetWindowTabs = otherTabs
    .filter((t) => t.windowId === targetWindowId)
    .sort((a, b) => a.index - b.index);

  // 3. Insert tabs at target index
  let index = targetIndex;
  if (index === -1) index = targetWindowTabs.length;

  tabsToMove.forEach((t) => {
    t.windowId = targetWindowId;
  });

  targetWindowTabs.splice(index, 0, ...tabsToMove);

  // 4. Re-index all tabs in the target window
  targetWindowTabs.forEach((t, i) => {
    t.index = i;
  });

  // 5. Re-index remaining tabs in other windows (in case they shifted)
  const otherWindows = Array.from(
    new Set(otherTabs.map((t) => t.windowId)),
  ).filter((wid) => wid !== targetWindowId);
  
  for (const wid of otherWindows) {
    otherTabs
      .filter((t) => t.windowId === wid)
      .sort((a, b) => a.index - b.index)
      .forEach((t, i) => {
        t.index = i;
      });
  }

  // 6. Update currentTabs
  currentTabs = [
    ...targetWindowTabs,
    ...otherTabs.filter((t) => t.windowId !== targetWindowId),
  ];
};

export const mockChrome = {
  // ... (keep existing mocks)
  tabs: {
    // ... (keep existing mocks for group, ungroup, remove, etc.)
    move: vi.fn().mockImplementation((ids, options) => {
      const tabIds = Array.isArray(ids) ? ids : [ids];
      const targetWin = options.windowId ?? currentTabs.find(t => tabIds.includes(t.id))?.windowId ?? 1;
      const targetIndex = options.index;
      
      moveTabsInMock(tabIds, targetIndex, targetWin);
      
      return Promise.resolve([]);
    }),
    // ...
    query: vi.fn().mockImplementation(() => Promise.resolve([...currentTabs])),
    remove: vi.fn().mockImplementation((ids) => {
      const toRemove = Array.isArray(ids) ? ids : [ids];
      currentTabs = currentTabs.filter((t) => !toRemove.includes(t.id));
      return Promise.resolve();
    }),
    onCreated: { addListener: vi.fn() },
    onRemoved: { addListener: vi.fn() },
    onUpdated: { addListener: vi.fn() },
  },
  tabGroups: {
    update: vi.fn().mockImplementation((gid, update) => {
      const group = currentGroups.get(gid) || { id: gid };
      currentGroups.set(gid, { ...group, ...update });
      return Promise.resolve(currentGroups.get(gid));
    }),
    query: vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(Array.from(currentGroups.values())),
      ),
    move: vi.fn().mockImplementation((gid, options) => {
      const group = currentGroups.get(gid);
      if (group && options.windowId) group.windowId = options.windowId;
      currentTabs.forEach((t) => {
        if (t.groupId === gid && options.windowId)
          t.windowId = options.windowId;
      });
      return Promise.resolve(group);
    }),
  },
  windows: {
    getAll: vi.fn().mockResolvedValue([{ id: 1, type: "normal" }]),
    getCurrent: vi.fn().mockResolvedValue({ id: 1, type: "normal" }),
  },
};
