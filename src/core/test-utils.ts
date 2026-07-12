import { Tab, asTabId } from "@/types";

import { vi } from "vitest";

export const mockState = {
  currentTabs: [] as Tab[],
  currentGroups: new Map<number, chrome.tabGroups.TabGroup>(),
  reset: () => {
    mockState.currentTabs.length = 0;
    mockState.currentGroups.clear();
  },
};

/**
 * Creates a mock Chrome Tab object for testing.
 * Standardizes tab creation across the test suite.
 */
export const mkTab = (
  id: number,
  url: string,
  options: {
    groupId?: number | null;
    index?: number;
    windowId?: number;
    pinned?: boolean;
    title?: string;
  } = {},
): Tab => {
  const {
    groupId = null,
    index = 0,
    windowId = 1,
    pinned = false,
    title = "",
  } = options;
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
 * Creates a mock Chrome TabGroup object for testing.
 */
export const mkGroup = (
  id: number,
  title: string,
  options: {
    windowId?: number;
    collapsed?: boolean;
    color?: chrome.tabGroups.Color;
    shared?: boolean;
  } = {},
): chrome.tabGroups.TabGroup => ({
  id,
  title,
  windowId: options.windowId ?? 1,
  collapsed: options.collapsed ?? false,
  color: options.color ?? "blue",
  shared: options.shared ?? false,
});

/**
 * Helper to extract tab IDs from an array of tabs and cast them to TabId.
 */
export const getTabIds = (tabs: Tab[]) => tabs.map((t) => asTabId(t.id)!);

/**
 * Properly moves tabs within mockState.currentTabs, handling index shifts and re-indexing.
 */
export const moveTabsInMock = (
  tabIds: number[],
  targetIndex: number,
  targetWindowId: number,
) => {
  const ids = Array.isArray(tabIds) ? tabIds : [tabIds];

  // 1. Separate tabs being moved and those staying
  const tabsToMove = ids.map(
    (id) => mockState.currentTabs.find((t) => t.id === id)!,
  );
  const otherTabs = mockState.currentTabs.filter(
    (t) => t.id != null && !ids.includes(t.id),
  );

  // 2. Identify target window tabs
  const targetWindowTabs = otherTabs
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

  // 6. Update mockState.currentTabs
  mockState.currentTabs = [
    ...targetWindowTabs,
    ...otherTabs.filter((t) => t.windowId !== targetWindowId),
  ];
};

export const mockChrome = {
  runtime: {
    getURL: vi.fn().mockReturnValue("chrome-extension://self-id/"),
  },
  storage: {
    local: {
      get: vi.fn().mockImplementation((key) => {
        if (key === "rules") return Promise.resolve({ rules: [] });
        if (key === "grouping") return Promise.resolve({ grouping: {} });
        return Promise.resolve({});
      }),
      set: vi.fn().mockResolvedValue(undefined),
    },
    onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
  },
  action: {
    setBadgeText: vi.fn(),
    setBadgeBackgroundColor: vi.fn(),
  },
  tabs: {
    group: vi.fn().mockImplementation((options) => {
      const gid = options.groupId || Math.floor(Math.random() * 1000) + 1000;
      const tabIds = Array.isArray(options.tabIds)
        ? options.tabIds
        : [options.tabIds];
      mockState.currentTabs.forEach((t) => {
        if (tabIds.includes(t.id)) t.groupId = gid;
      });
      if (!mockState.currentGroups.has(gid)) {
        mockState.currentGroups.set(gid, {
          id: gid,
          title: "",
          windowId:
            mockState.currentTabs.find((t) => tabIds.includes(t.id))
              ?.windowId || 1,
          collapsed: false,
          color: "blue",
          shared: false,
        });
      }
      return Promise.resolve(gid);
    }),
    ungroup: vi.fn().mockImplementation((ids) => {
      const tabIds = Array.isArray(ids) ? ids : [ids];
      mockState.currentTabs.forEach((t) => {
        if (tabIds.includes(t.id)) t.groupId = -1;
      });
      return Promise.resolve();
    }),
    move: vi.fn().mockImplementation((ids, options) => {
      const tabIds = Array.isArray(ids) ? ids : [ids];
      const targetWin =
        options.windowId ??
        mockState.currentTabs.find((t) => tabIds.includes(t.id))?.windowId ??
        1;
      const targetIndex = options.index;

      moveTabsInMock(tabIds, targetIndex, targetWin);

      return Promise.resolve([]);
    }),
    query: vi
      .fn()
      .mockImplementation(() => Promise.resolve([...mockState.currentTabs])),
    remove: vi.fn().mockImplementation((ids) => {
      const toRemove = Array.isArray(ids) ? ids : [ids];
      mockState.currentTabs = mockState.currentTabs.filter(
        (t) => !toRemove.includes(t.id),
      );
      return Promise.resolve();
    }),
    onCreated: { addListener: vi.fn() },
    onRemoved: { addListener: vi.fn() },
    onUpdated: { addListener: vi.fn() },
  },
  tabGroups: {
    update: vi.fn().mockImplementation((gid, update) => {
      const group = mockState.currentGroups.get(gid) || { id: gid };
      mockState.currentGroups.set(gid, { ...group, ...update });
      return Promise.resolve(mockState.currentGroups.get(gid));
    }),
    query: vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(Array.from(mockState.currentGroups.values())),
      ),
    move: vi.fn().mockImplementation((gid, options) => {
      const group = mockState.currentGroups.get(gid);
      if (group && options.windowId) group.windowId = options.windowId;
      mockState.currentTabs.forEach((t) => {
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
