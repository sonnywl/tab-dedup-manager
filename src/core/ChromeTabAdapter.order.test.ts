import { describe, expect, it, vi, beforeEach } from "vitest";

import ChromeTabAdapter from "./ChromeTabAdapter";

// Mocking chrome API globally
const mockChrome = {
  tabs: {
    move: vi.fn().mockResolvedValue([]),
    query: vi.fn(),
  },
  tabGroups: {
    move: vi.fn().mockResolvedValue({}),
  },
};
vi.stubGlobal("chrome", mockChrome);

describe("ChromeTabAdapter - executeOrderPlan", () => {
  let adapter: ChromeTabAdapter;

  beforeEach(() => {
    vi.clearAllMocks();
    adapter = new ChromeTabAdapter();
  });

  it("should move a group of tabs using tabGroups.move", async () => {
    const plan = {
      desired: [
        { kind: "group", groupId: 101 as any, tabIds: [1, 2] as any, targetIndex: 0 },
      ],
      toMove: [
        { kind: "group", groupId: 101 as any, tabIds: [1, 2] as any, targetIndex: 0 },
      ],
    };

    mockChrome.tabs.query.mockResolvedValue([]); // Mock current state

    await adapter.executeOrderPlan(plan as any, 1 as any, []);

    expect(mockChrome.tabGroups.move).toHaveBeenCalledWith(101, {
      windowId: 1,
      index: 0,
    });
  });
});
