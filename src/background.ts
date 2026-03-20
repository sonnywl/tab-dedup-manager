import { TabGroupingController } from "./controllers/TabGroupingController.js";
import {
  ChromeTabAdapter,
  debounce,
} from "./infrastructure/ChromeTabAdapter.js";
import {
  TabGroupingService,
  WindowManagementService,
} from "./utils/grouping.js";

function init() {
  const service = new TabGroupingService();
  const windowService = new WindowManagementService();
  const adapter = new ChromeTabAdapter();
  const controller = new TabGroupingController(service, windowService, adapter);

  const debouncedUpdateBadge = debounce(() => adapter.updateBadge(service), 300);

  chrome.action.onClicked.addListener(() => controller.execute());
  chrome.tabs.onCreated.addListener(debouncedUpdateBadge);
  chrome.tabs.onRemoved.addListener(debouncedUpdateBadge);
  chrome.tabs.onUpdated.addListener(debouncedUpdateBadge);
}

if (typeof process === "undefined" || process.env.NODE_ENV !== "test") {
  init();
}
