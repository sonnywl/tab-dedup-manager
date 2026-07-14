import ChromeTabAdapter, { debounce } from "core/ChromeTabAdapter";
import { TabGroupingService, WindowManagementService } from "utils/grouping";

import TabGroupingController from "core/TabGroupingController";
import startSyncStore from "utils/startSyncStore";

let controllerPromise: Promise<TabGroupingController> | null = null;

function getController(): Promise<TabGroupingController> {
  if (!controllerPromise) {
    controllerPromise = (async () => {
      const store = await startSyncStore({
        rules: [],
        grouping: {
          byWindow: false,
          numWindowsToKeep: 2,
          ungroupSingleTab: false,
        },
      });
      return new TabGroupingController(
        new TabGroupingService(),
        new WindowManagementService(),
        new ChromeTabAdapter(),
        store,
      );
    })();
  }
  return controllerPromise;
}

const handleTabChange = debounce(async () => {
  try {
    await (await getController()).updateBadge();
  } catch (err) {
    console.error("Error in handleTabChange:", err);
  }
}, 100);

// Must run synchronously on every script (re)start — this is what lets
// Firefox/Chrome wake a suspended background script for these events.
chrome.action.onClicked.addListener(async () => {
  try {
    await (await getController()).execute();
  } catch (err) {
    console.error("Error in onClicked:", err);
  }
});
chrome.tabs.onCreated.addListener(handleTabChange);
chrome.tabs.onRemoved.addListener(handleTabChange);
chrome.tabs.onUpdated.addListener(handleTabChange);
chrome.tabs.onMoved.addListener(handleTabChange);
chrome.tabs.onAttached.addListener(handleTabChange);
chrome.tabs.onDetached.addListener(handleTabChange);

if (typeof process === "undefined" || process.env.NODE_ENV !== "test") {
  handleTabChange();
}
