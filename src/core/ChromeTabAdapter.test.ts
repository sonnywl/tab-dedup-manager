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

  it("deduplicates tabs by URL", async () => {
    const tabs = [mkTab(1, "https://u1.com"), mkTab(2, "https://u1.com")];
    const unique = await adapter.deduplicateAllTabs(tabs);
    expect(unique.length).toBe(1);
    expect(mockChrome.tabs.remove).toHaveBeenCalledWith([2]);
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
