import { Tab, asTabId } from "./types";

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
