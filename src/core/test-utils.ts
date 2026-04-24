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
    title: "",
    width: 0,
  } as Tab;
};

/**
 * Helper to extract tab IDs from an array of tabs and cast them to TabId.
 */
export const getTabIds = (tabs: Tab[]) => tabs.map((t) => asTabId(t.id)!);

export const mockChrome = {
  runtime: {
    getURL: vi.fn().mockReturnValue("chrome-extension://self-id/"),
  },
  storage: {
    local: { get: vi.fn(), set: vi.fn() },
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
      currentTabs.forEach((t) => {
        if (tabIds.includes(t.id)) t.groupId = gid;
      });
      if (!currentGroups.has(gid)) {
        currentGroups.set(gid, {
          id: gid,
          title: "",
          windowId:
            currentTabs.find((t) => tabIds.includes(t.id))?.windowId || 1,
        });
      }
      return Promise.resolve(gid);
    }),
    ungroup: vi.fn().mockImplementation((ids) => {
      const tabIds = Array.isArray(ids) ? ids : [ids];
      currentTabs.forEach((t) => {
        if (tabIds.includes(t.id)) t.groupId = -1;
      });
      return Promise.resolve();
    }),
    move: vi.fn().mockImplementation((ids, options) => {
      const tabIds = Array.isArray(ids) ? ids : [ids];
      const targetWin = options.windowId;
      currentTabs.forEach((t) => {
        if (tabIds.includes(t.id)) {
          if (targetWin) t.windowId = targetWin;
        }
      });
      return Promise.resolve([]);
    }),
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
