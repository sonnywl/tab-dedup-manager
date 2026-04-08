import { TabGroupingService, WindowManagementService } from "utils/grouping";
import { TabId, asWindowId } from "@/types";
import { beforeEach, describe, expect, it, vi } from "vitest";

import ChromeTabAdapter from "./ChromeTabAdapter";
import TabGroupingController from "./TabGroupingController";
import { mkTab } from "./test-utils";

// ============================================================================
// MOCKS
// ============================================================================

const mockChrome = {
  runtime: {
    getURL: vi.fn().mockReturnValue("chrome-extension://self-id/"),
  },
  storage: {
    local: { get: vi.fn(), set: vi.fn() },
    onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
  },
  action: {
    onClicked: { addListener: vi.fn() },
    setBadgeText: vi.fn(),
    setBadgeBackgroundColor: vi.fn(),
  },
  tabs: {
    group: vi.fn(),
    get: vi.fn(),
    update: vi.fn(),
    query: vi.fn().mockResolvedValue([]),
    move: vi.fn(),
    ungroup: vi.fn(),
    remove: vi.fn(),
    onCreated: { addListener: vi.fn() },
    onRemoved: { addListener: vi.fn() },
    onUpdated: { addListener: vi.fn() },
  },
  tabGroups: {
    update: vi.fn(),
    query: vi.fn().mockResolvedValue([]),
    move: vi.fn(),
  },
  windows: {
    getAll: vi.fn(),
    getCurrent: vi.fn().mockResolvedValue({ id: 1, type: "normal" }),
  },
};

vi.stubGlobal("chrome", mockChrome);

const mockStore = {
  getState: vi
    .fn()
    .mockResolvedValue({ rules: [], grouping: { byWindow: false } }),
};
vi.mock("../utils/startSyncStore.js", () => ({ default: () => mockStore }));

describe("TabGroupingController", () => {
  let controller: TabGroupingController;

  const makeAdapterMock = (overrides: Record<string, any> = {}) =>
    ({
      getNormalTabs: vi.fn().mockResolvedValue([]),
      deduplicateAllTabs: vi.fn().mockResolvedValue([]),
      cleanupTabsByRules: vi.fn().mockResolvedValue([]),
      moveInternalTabsToStart: vi
        .fn()
        .mockImplementation((tabs) => Promise.resolve(tabs)),
      ungroupSingleTabGroups: vi.fn().mockResolvedValue(undefined),
      executeConsolidationPlan: vi
        .fn()
        .mockResolvedValue({ success: true, value: undefined }),
      executeMembershipPlan: vi
        .fn()
        .mockResolvedValue({ success: true, value: undefined }),
      executeOrderPlan: vi
        .fn()
        .mockResolvedValue({ success: true, value: undefined }),
      updateBadge: vi.fn().mockResolvedValue(undefined),
      settle: vi.fn().mockResolvedValue(undefined),
      ...overrides,
    }) as unknown as ChromeTabAdapter;

  beforeEach(() => {
    vi.clearAllMocks();
    const service = new TabGroupingService();
    const windowService = new WindowManagementService();
    const adapter = makeAdapterMock();

    controller = new TabGroupingController(
      service,
      windowService,
      adapter,
      mockStore as any,
    );
  });

  describe("execute()", () => {
    it("blocks concurrent processing via instance flag", async () => {
      (controller as any).isProcessing = true;
      await controller.execute();
      expect((controller as any).adapter.getNormalTabs).not.toHaveBeenCalled();
    });

    it("skips when state hash unchanged", async () => {
      const tabs = [mkTab(1, "google.com")];
      (controller as any).adapter.getNormalTabs.mockResolvedValue(tabs);
      (controller as any).adapter.deduplicateAllTabs.mockResolvedValue(tabs);
      (controller as any).adapter.cleanupTabsByRules.mockResolvedValue(tabs);
      mockStore.getState.mockResolvedValue({
        rules: [],
        grouping: { byWindow: false },
      });

      await controller.execute();
      const callsAfterFirst = (controller as any).adapter.getNormalTabs.mock
        .calls.length;
      await controller.execute();

      expect((controller as any).adapter.getNormalTabs.mock.calls.length).toBe(
        callsAfterFirst + 1,
      );
    });

    it("hash is order-stable", async () => {
      const tabs1 = [mkTab(1, "https://a.com"), mkTab(2, "https://b.com")];
      const tabs2 = [mkTab(2, "https://b.com"), mkTab(1, "https://a.com")];
      const service = (controller as any).service;
      const hash = (t: any[]) => service.hashState(t, new Map());
      expect(hash(tabs1)).toBe(hash(tabs2));
    });
  });

  describe("updateBadge()", () => {
    it("counts tabs needing grouping", async () => {
      const tabs = [
        mkTab(1, "https://google.com/1"),
        mkTab(2, "https://google.com/2"),
      ];
      (controller as any).adapter.getNormalTabs.mockResolvedValue(tabs);
      mockStore.getState.mockResolvedValue({
        rules: [],
        grouping: { byWindow: true },
      });

      await controller.updateBadge();
      expect((controller as any).adapter.updateBadge).toHaveBeenCalledWith(2);
    });

    it("counts tabs needing window move (global consolidation)", async () => {
      const tabs = [
        mkTab(1, "https://a.com/1", -1, 0, 1),
        mkTab(2, "https://a.com/2", -1, 1, 2), // Different window
      ];
      (controller as any).adapter.getNormalTabs.mockResolvedValue(tabs);
      mockChrome.windows.getCurrent.mockResolvedValue({ id: 1, type: "normal" });
      mockStore.getState.mockResolvedValue({
        rules: [],
        grouping: { byWindow: false }, // Global grouping moves all to active
      });

      await controller.updateBadge();
      // Tab 2 moves to window 1 (+1)
      // Tab 1 & 2 will be grouped together (+2)
      // Total 2 affected tabs (Tab 1 and Tab 2)
      expect((controller as any).adapter.updateBadge).toHaveBeenCalledWith(2);
    });

    it("counts duplicates and auto-deletes", async () => {
      const tabs = [
        mkTab(1, "https://google.com/1"),
        mkTab(2, "https://google.com/1"), // Duplicate
        mkTab(3, "https://trash.com/1"), // To delete
      ];
      (controller as any).adapter.getNormalTabs.mockResolvedValue(tabs);
      mockStore.getState.mockResolvedValue({
        rules: [{ domain: "trash.com", autoDelete: true }],
        grouping: { byWindow: true },
      });

      await controller.updateBadge();
      // Tab 2 (dupe) + Tab 3 (auto-delete) = 2
      expect((controller as any).adapter.updateBadge).toHaveBeenCalledWith(2);
    });

    it("counts tabs needing ungrouping (single tab managed groups)", async () => {
      const tabs = [
        mkTab(1, "https://google.com/1", 101), // Only 1 tab in group 101
      ];
      const groups = [
        { id: 101, title: "google.com", windowId: 1 } as any,
      ];
      (controller as any).adapter.getNormalTabs.mockResolvedValue(tabs);
      mockChrome.tabGroups.query.mockResolvedValue(groups);
      mockStore.getState.mockResolvedValue({
        rules: [],
        grouping: { byWindow: true },
      });

      await controller.updateBadge();
      // Tab 1 is in a managed group but shouldn't be (threshold 2)
      expect((controller as any).adapter.updateBadge).toHaveBeenCalledWith(1);
    });
  });

  describe("Collapse state persistence", () => {
    let service: TabGroupingService;

    beforeEach(() => {
      service = new TabGroupingService();
    });

    it("should preserve collapsed state in MembershipPlan", () => {
      const tabs = [
        mkTab(1, "google.com/a", 101),
        mkTab(2, "google.com/b", 101),
      ];
      const groupIdToGroup = new Map([
        [
          101,
          { id: 101, title: "google.com", collapsed: true, windowId: 1 } as any,
        ],
      ]);
      const rulesByDomain = {};

      const groupMap = service.buildGroupMap(
        tabs,
        rulesByDomain,
        groupIdToGroup,
      );
      const tabCache = new Map(tabs.map((t) => [t.id as TabId, t]));
      const managedGroupIds = new Map([[101, "google.com"]]);

      const groupStates = service.buildGroupStates(
        groupMap,
        tabCache,
        new Map(),
        managedGroupIds,
      );

      expect(groupStates[0].collapsed).toBe(true);

      const plan = service.buildMembershipPlan(
        groupStates,
        tabCache,
        managedGroupIds,
        asWindowId(1),
      );

      expect(plan.toGroup[0].collapsed).toBe(true);
    });
  });
});
