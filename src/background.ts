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

    const debouncedUpdateBadge = debounce(() => controller.updateBadge(), 300);

    // Initial update
    debouncedUpdateBadge();

    chrome.action.onClicked.addListener(() => controller.execute());
    chrome.tabs.onCreated.addListener(debouncedUpdateBadge);
    chrome.tabs.onRemoved.addListener(debouncedUpdateBadge);
    chrome.tabs.onUpdated.addListener(debouncedUpdateBadge);
  } catch (err) {
    console.error("Fatal initialization error:", err);
  }
}

if (typeof process === "undefined" || process.env.NODE_ENV !== "test") {
  init();
}
