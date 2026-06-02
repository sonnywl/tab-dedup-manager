import { beforeEach, describe, expect, it } from "vitest";

import { TabGroupingService } from "./grouping";
import { mkTab } from "core/test-utils";

describe("TabGroupingService - compareTabOrder", () => {
  let service: TabGroupingService;

  beforeEach(() => {
    service = new TabGroupingService();
  });

  it("should sort correctly according to business rules", () => {
    const tab1 = mkTab(1, "edge://settings", { index: 0, windowId: 1 }); // Internal
    const tab2 = mkTab(2, "https://google.com/1", {
      groupId: 100,
      index: 1,
      windowId: 1,
    }); // Grouped
    const tab3 = mkTab(3, "https://google.com/2", { index: 2, windowId: 1 }); // Solo
    const pinnedTab = mkTab(4, "https://pinned.com", {
      index: 2,
      windowId: 1,
      pinned: true,
    });
    expect(service.compareTabOrder(tab1, tab2)).toBeLessThan(0);
    expect(service.compareTabOrder(tab2, tab3)).toBeLessThan(0);
    expect(service.compareTabOrder(pinnedTab, tab3)).toBeLessThan(0);
  });
});
