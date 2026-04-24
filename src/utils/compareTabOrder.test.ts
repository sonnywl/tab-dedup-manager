import { Tab, asTabId } from "@/types";
import { TabGroupingService } from "./grouping";
import { mkTab } from "core/test-utils";
import { describe, expect, it, beforeEach } from "vitest";

describe("TabGroupingService - compareTabOrder", () => {
  let service: TabGroupingService;

  beforeEach(() => {
    service = new TabGroupingService();
  });

  it("should sort correctly according to business rules", () => {
    const tab1 = mkTab(1, "edge://settings", -1, 0, 1, false); // Internal
    const tab2 = mkTab(2, "https://google.com/1", 100, 1, 1, false); // Grouped
    const tab3 = mkTab(3, "https://google.com/2", -1, 2, 1, false); // Solo
    const pinnedTab = mkTab(4, "https://pinned.com", -1, 0, 1, true); // Pinned

    // Pinned < Internal < Grouped < Solo
    expect(service.compareTabOrder(pinnedTab, tab1)).toBeLessThan(0);
    expect(service.compareTabOrder(tab1, tab2)).toBeLessThan(0);
    expect(service.compareTabOrder(tab2, tab3)).toBeLessThan(0);
  });
});
