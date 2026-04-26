import ChromeTabAdapter, { debounce } from "core/ChromeTabAdapter";
import { TabGroupingService, WindowManagementService } from "utils/grouping";

import TabGroupingController from "core/TabGroupingController";
import startSyncStore from "utils/startSyncStore";

async function init() {
  try {
    const store = await startSyncStore({
      rules: [],
      grouping: {
        byWindow: false,
        numWindowsToKeep: 2,
        ungroupSingleTab: false,
        processGroupOnChange: false,
      },
    });

    const service = new TabGroupingService();
    const windowService = new WindowManagementService();
    const adapter = new ChromeTabAdapter();
    const controller = new TabGroupingController(
      service,
      windowService,
      adapter,
      store,
    );

    const handleTabChange = debounce(async () => {
      try {
        const state = await store.getState();
        controller.clearHash();
        if (state.grouping?.processGroupOnChange) {
          await controller.execute();
        }
        await controller.updateBadge();
      } catch (err) {
        console.error("Error in handleTabChange:", err);
      }
    }, 100);

    // Initial update
    handleTabChange();

    chrome.action.onClicked.addListener(() => controller.execute());
    chrome.tabs.onCreated.addListener(handleTabChange);
    chrome.tabs.onRemoved.addListener(handleTabChange);
    chrome.tabs.onUpdated.addListener(handleTabChange);
    chrome.tabs.onMoved.addListener(handleTabChange);
    chrome.tabs.onAttached.addListener(handleTabChange);
    chrome.tabs.onDetached.addListener(handleTabChange);
  } catch (err) {
    console.error("Fatal initialization error:", err);
  }
}

if (typeof process === "undefined" || process.env.NODE_ENV !== "test") {
  init();
}
