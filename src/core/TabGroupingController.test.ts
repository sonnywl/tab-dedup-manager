import { Tab, asTabId, asWindowId } from "@/types";
import { TabGroupingService, WindowManagementService } from "utils/grouping";
import { beforeEach, describe, expect, it, vi } from "vitest";

import ChromeTabAdapter from "./ChromeTabAdapter";
import TabGroupingController from "./TabGroupingController";
import { mkTab } from "./test-utils";

// ============================================================================
// MOCKS & STATEFUL MOCK CHROME
// ============================================================================

let currentTabs: Tab[] = [];
let currentGroups = new Map<number, chrome.tabGroups.TabGroup>();

const mockChrome = {
  runtime: {
    getURL: vi.fn().mockReturnValue("chrome-extension://self-id/"),
  },
  storage: {
    local: {
      get: vi.fn().mockImplementation((key) => {
        if (key === "rules") return Promise.resolve({ rules: [] });
        if (key === "grouping") return Promise.resolve({ grouping: {} });
        return Promise.resolve({});
      }),
      set: vi.fn().mockResolvedValue(undefined),
    },
    onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
  },
  action: {
    setBadgeText: vi.fn(),
    setBadgeBackgroundColor: vi.fn(),
  },
  tabs: {
    group: vi.fn().mockImplementation((options) => {
      const gid = options.groupId || Math.floor(Math.random() * 1000) + 1000;
      const tabIds = Array.isArray(options.tabIds)
        ? options.tabIds
        : [options.tabIds];
      currentTabs.forEach((t) => {
        if (tabIds.includes(t.id)) t.groupId = gid;
      });
      if (!currentGroups.has(gid)) {
        currentGroups.set(gid, {
          id: gid,
          title: "",
          windowId:
            currentTabs.find((t) => tabIds.includes(t.id))?.windowId || 1,
        } as chrome.tabGroups.TabGroup);
      }
      return Promise.resolve(gid);
    }),
    ungroup: vi.fn().mockImplementation((ids) => {
      const tabIds = Array.isArray(ids) ? ids : [ids];
      currentTabs.forEach((t) => {
        if (tabIds.includes(t.id)) t.groupId = -1;
      });
      return Promise.resolve();
    }),
    move: vi.fn().mockImplementation((ids, options) => {
      const tabIds = Array.isArray(ids) ? ids : [ids];
      const targetWin = options.windowId;
      currentTabs.forEach((t) => {
        if (tabIds.includes(t.id)) {
          if (targetWin) t.windowId = targetWin;
        }
      });
      return Promise.resolve([]);
    }),
    query: vi.fn().mockImplementation(() => Promise.resolve([...currentTabs])),
    remove: vi.fn().mockImplementation((ids) => {
      const toRemove = Array.isArray(ids) ? ids : [ids];
      currentTabs = currentTabs.filter((t) => !toRemove.includes(t.id));
      return Promise.resolve();
    }),
    onCreated: { addListener: vi.fn() },
    onRemoved: { addListener: vi.fn() },
    onUpdated: { addListener: vi.fn() },
  },
  tabGroups: {
    update: vi.fn().mockImplementation((gid, update) => {
      const group =
        currentGroups.get(gid) || ({ id: gid } as chrome.tabGroups.TabGroup);
      currentGroups.set(gid, { ...group, ...update });
      return Promise.resolve(currentGroups.get(gid));
    }),
    query: vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(Array.from(currentGroups.values())),
      ),
    move: vi.fn().mockImplementation((gid, options) => {
      const group = currentGroups.get(gid);
      if (group && options.windowId) group.windowId = options.windowId;
      currentTabs.forEach((t) => {
        if (t.groupId === gid && options.windowId)
          t.windowId = options.windowId;
      });
      return Promise.resolve(group);
    }),
  },
  windows: {
    getAll: vi.fn().mockResolvedValue([{ id: 1, type: "normal" }]),
    getCurrent: vi.fn().mockResolvedValue({ id: 1, type: "normal" }),
  },
};

vi.stubGlobal("chrome", mockChrome);

const mockStore = {
  getState: vi.fn().mockResolvedValue({
    rules: [],
    grouping: { byWindow: false, numWindowsToKeep: 2, ungroupSingleTab: false },
  }),
};
vi.mock("../utils/startSyncStore.js", () => ({ default: () => mockStore }));

/**
 * Helper to assert that a second execution of the controller does nothing.
 */
const assertIdempotent = async (controller: TabGroupingController) => {
  mockChrome.tabs.move.mockClear();
  mockChrome.tabs.group.mockClear();
  mockChrome.tabs.ungroup.mockClear();
  mockChrome.tabs.remove.mockClear();
  mockChrome.tabGroups.update.mockClear();
  mockChrome.tabGroups.move.mockClear();

  await controller.execute();

  expect(mockChrome.tabs.move).not.toHaveBeenCalled();
  expect(mockChrome.tabs.group).not.toHaveBeenCalled();
  expect(mockChrome.tabs.ungroup).not.toHaveBeenCalled();
  expect(mockChrome.tabs.remove).not.toHaveBeenCalled();
  expect(mockChrome.tabGroups.update).not.toHaveBeenCalled();
  expect(mockChrome.tabGroups.move).not.toHaveBeenCalled();
};

describe("TabGroupingController", () => {
  let controller: TabGroupingController;
  let service: TabGroupingService;
  let windowService: WindowManagementService;
  let adapter: ChromeTabAdapter;

  beforeEach(() => {
    vi.clearAllMocks();
    currentTabs = [];
    currentGroups = new Map();

    service = new TabGroupingService();
    windowService = new WindowManagementService();
    adapter = new ChromeTabAdapter();

    controller = new TabGroupingController(
      service,
      windowService,
      adapter,
      mockStore as any,
    );

    mockChrome.windows.getCurrent.mockResolvedValue({ id: 1, type: "normal" });
    mockChrome.windows.getAll.mockResolvedValue([{ id: 1, type: "normal" }]);
    vi.mocked(mockStore.getState).mockResolvedValue({
      rules: [],
      grouping: {
        byWindow: false,
        numWindowsToKeep: 2,
        ungroupSingleTab: false,
      },
    });
  });

  describe("Core Logic Unit Tests", () => {
    it("blocks concurrent processing via instance flag", async () => {
      (controller as any).isProcessing = true;
      await controller.execute();
      expect(mockChrome.tabs.query).not.toHaveBeenCalled();
    });

    it("skips when state hash unchanged", async () => {
      currentTabs = [mkTab(1, "https://google.com")];
      await controller.execute();

      const callsBefore = mockChrome.tabs.query.mock.calls.length;
      await controller.execute();
      // Should only have called query once more for the initial check in execute
      expect(mockChrome.tabs.query.mock.calls.length).toBe(callsBefore + 1);
    });

    it("hash is order-stable", () => {
      const tabs1 = [mkTab(1, "https://a.com"), mkTab(2, "https://b.com")];
      const tabs2 = [mkTab(2, "https://b.com"), mkTab(1, "https://a.com")];
      const hash1 = service.hashState(tabs1, new Map());
      const hash2 = service.hashState(tabs2, new Map());
      expect(hash1).toBe(hash2);
    });
  });

  describe("Integration Tests (High-Fidelity)", () => {
    it("SplitPath: correctly groups tabs by path segment", async () => {
      const rules = [
        { domain: "github.com", splitByPath: 1, autoDelete: false },
      ];
      vi.mocked(mockStore.getState).mockResolvedValue({
        rules: rules,
        grouping: { byWindow: false },
      });

      currentTabs = [
        mkTab(1, "https://github.com/project-a/file1"),
        mkTab(2, "https://github.com/project-a/file2"),
        mkTab(3, "https://github.com/project-b/file1"),
        mkTab(4, "https://github.com/project-b/file2"),
      ];

      await controller.execute();

      const groupCalls = mockChrome.tabs.group.mock.calls;
      expect(groupCalls.length).toBeGreaterThanOrEqual(2);

      expect(mockChrome.tabGroups.update).toHaveBeenCalledWith(
        expect.any(Number),
        expect.objectContaining({ title: "project-a - github.com" }),
      );
      expect(mockChrome.tabGroups.update).toHaveBeenCalledWith(
        expect.any(Number),
        expect.objectContaining({ title: "project-b - github.com" }),
      );

      await assertIdempotent(controller);
    });

    it("Auto-Delete: correctly closes tabs session-wide before grouping", async () => {
      const rules = [
        { domain: "trash.com", autoDelete: true },
        { domain: "keep.com", autoDelete: false },
      ];
      vi.mocked(mockStore.getState).mockResolvedValue({
        rules: rules,
        grouping: { byWindow: false },
      });

      currentTabs = [
        mkTab(1, "https://trash.com/ads"),
        mkTab(2, "https://keep.com/important"),
        mkTab(3, "https://trash.com/tracker"),
      ];

      await controller.execute();

      const removedIds = mockChrome.tabs.remove.mock.calls.flatMap(
        (call) => call[0],
      );
      expect(removedIds).toContain(1);
      expect(removedIds).toContain(3);
      expect(removedIds).not.toContain(2);

      await assertIdempotent(controller);
    });

    it("Deduplication: closes duplicate URLs session-wide", async () => {
      currentTabs = [
        mkTab(1, "https://shared.com/page", 101, 0, 1),
        mkTab(2, "https://unique.com/page", -1, 1, 1),
        mkTab(3, "https://shared.com/page", -1, 0, 2),
      ];
      currentGroups.set(101, {
        id: 101,
        title: "My Manual Group",
        windowId: 1,
      } as chrome.tabGroups.TabGroup);

      await controller.execute();

      const removedIds = mockChrome.tabs.remove.mock.calls.flatMap(
        (call) => call[0],
      );
      expect(removedIds).toContain(3);
      expect(removedIds).not.toContain(1);

      await assertIdempotent(controller);
    });

    it("Single-Tab Ungroup: immediately ungroups 1-tab groups if enabled", async () => {
      vi.mocked(mockStore.getState).mockResolvedValue({
        rules: [],
        grouping: { byWindow: false, ungroupSingleTab: true },
      });

      currentTabs = [
        mkTab(1, "https://shared.com/page", 101, 0, 1),
        mkTab(2, "https://unique.com/page", -1, 1, 1),
      ];
      currentGroups.set(101, {
        id: 101,
        title: "shared.com",
        windowId: 1,
      } as chrome.tabGroups.TabGroup);

      await controller.execute();

      const tab1 = currentTabs.find((t) => t.id === 1);
      expect(tab1?.groupId).toBe(-1);
      expect(mockChrome.tabs.ungroup).toHaveBeenCalledWith(1);
    });

    it("Localhost: ports are grouped separately", async () => {
      currentTabs = [
        mkTab(1, "http://localhost:8000/1", -1, 0, 1),
        mkTab(2, "http://localhost:8000/2", -1, 1, 1),
        mkTab(3, "http://localhost:8529/1", -1, 2, 1),
        mkTab(4, "http://localhost:8529/2", -1, 3, 1),
      ];

      await controller.execute();

      const t1 = currentTabs.find((t) => t.id === 1);
      const t3 = currentTabs.find((t) => t.id === 3);

      expect(t1?.groupId).not.toBe(-1);
      expect(t3?.groupId).not.toBe(-1);
      expect(t1?.groupId).not.toBe(t3?.groupId);

      expect(currentGroups.get(t1?.groupId!)?.title).toBe("localhost:8000");
      expect(currentGroups.get(t3?.groupId!)?.title).toBe("localhost:8529");
    });
  });

  describe("updateBadge() behavior", () => {
    it("shows '!' for tabs needing grouping or sorting", async () => {
      currentTabs = [
        mkTab(1, "https://google.com/1"),
        mkTab(2, "https://google.com/2"),
      ];
      vi.mocked(mockStore.getState).mockResolvedValue({
        rules: [],
        grouping: { byWindow: true },
      });

      await controller.updateBadge();
      expect(mockChrome.action.setBadgeText).toHaveBeenCalledWith(
        expect.objectContaining({ text: "!" }),
      );
    });

    it("clears badge when hash matches", async () => {
      currentTabs = [mkTab(1, "https://google.com/1")];
      const hash = service.hashState(currentTabs, new Map());
      (controller as any).lastFullStateHash = hash;

      await controller.updateBadge();
      expect(mockChrome.action.setBadgeText).toHaveBeenCalledWith(
        expect.objectContaining({ text: "" }),
      );
    });

    it("counts potential closures", async () => {
      currentTabs = [
        mkTab(1, "https://google.com/1"),
        mkTab(2, "https://google.com/1"), // Duplicate
        mkTab(3, "https://trash.com/1"), // To delete
      ];
      vi.mocked(mockStore.getState).mockResolvedValue({
        rules: [{ domain: "trash.com", autoDelete: true }],
        grouping: { byWindow: true },
      });

      await controller.updateBadge();
      expect(mockChrome.action.setBadgeText).toHaveBeenCalledWith(
        expect.objectContaining({ text: "2" }),
      );
    });
  });

  describe("State Consistency", () => {
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
      const tabCache = new Map(tabs.map((t) => [asTabId(t.id)!, t]));
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
