import { beforeEach, describe, expect, it, vi } from "vitest";

import ChromeTabAdapter from "./ChromeTabAdapter";
import { mkTab } from "./test-utils";

const mockChrome = {
  tabs: {
    query: vi.fn(),
    remove: vi.fn(),
    group: vi.fn(),
  },
  tabGroups: {
    update: vi.fn(),
  },
};

vi.stubGlobal("chrome", mockChrome);

describe("ChromeTabAdapter", () => {
  let adapter: ChromeTabAdapter;

  beforeEach(() => {
    vi.clearAllMocks();
    adapter = new ChromeTabAdapter();
  });

  it("queries only normal windows in getNormalTabs", async () => {
    mockChrome.tabs.query.mockResolvedValue([]);
    await adapter.getNormalTabs();
    expect(mockChrome.tabs.query).toHaveBeenCalledWith({
      windowType: "normal",
    });
  });

  it("removes tabs by ID in batches", async () => {
    const tabIds = [1, 2, 3] as any;
    await adapter.removeTabs(tabIds);
    expect(mockChrome.tabs.remove).toHaveBeenCalledWith([1, 2, 3]);
  });

  it("should apply collapsed state in executeMembershipPlan", async () => {
    const plan: any = {
      toUngroup: [],
      toGroup: [
        {
          tabIds: [1, 2],
          groupId: 101,
          title: "google.com",
          collapsed: true,
        },
      ],
      targetWindowId: 1,
    };

    mockChrome.tabs.group.mockResolvedValue(101);

    await adapter.executeMembershipPlan(plan, []);

    expect(mockChrome.tabGroups.update).toHaveBeenCalledWith(101, {
      title: "google.com",
      collapsed: true,
    });
  });
});
