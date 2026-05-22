import { describe, expect, it, vi, beforeEach } from "vitest";
import { TabGroupingService, isInternalTab } from "./grouping";
import { mkTab, mockChrome } from "../core/test-utils";
import { GroupState, Tab } from "@/types";

describe("Grouping Sorting Logic", () => {
  let service: TabGroupingService;

  beforeEach(() => {
    service = new TabGroupingService();
    vi.stubGlobal("chrome", mockChrome);
  });

  it("should sort manual groups alphabetically when sortManualGroups is true", () => {
    const tabCache = new Map<number, Tab>();
    const groupStates: GroupState[] = [
      {
        displayName: "Zebra",
        sourceDomain: "other",
        tabIds: [1],
        groupId: 101,
        collapsed: false,
        needsReposition: false,
        isExternal: true,
      },
      {
        displayName: "Apple",
        sourceDomain: "other",
        tabIds: [2],
        groupId: 102,
        collapsed: false,
        needsReposition: false,
        isExternal: true,
      },
    ];

    // Mocking the tabs in the cache
    tabCache.set(1, mkTab(1, "https://zebra.com", 101, 0, 1));
    tabCache.set(2, mkTab(2, "https://apple.com", 102, 1, 1));

    const result = service.calculateRepositionNeeds(
      groupStates,
      tabCache,
      1,
      new Map(),
      true, // sortManualGroups enabled
    );

    // Apple should come before Zebra
    expect(result[0].displayName).toBe("Apple");
    expect(result[1].displayName).toBe("Zebra");
  });
});
