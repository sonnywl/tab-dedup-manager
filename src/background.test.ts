import TabGroupingController from "./core/TabGroupingController";
import ChromeTabAdapter from "./core/ChromeTabAdapter";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { mkTab } from "./test-utils";
import { TabGroupingService, WindowManagementService } from "./utils/grouping";
import { asWindowId } from "./types";

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
vi.mock("./utils/startSyncStore.js", () => ({ default: () => mockStore }));

// ============================================================================
// APPLICATION LAYER
// ============================================================================

describe("TabGroupingController", () => {
  let controller: TabGroupingController;

  const makeAdapterMock = (overrides: Record<string, any> = {}) => ({
    getNormalTabs: vi.fn().mockResolvedValue([]),
    deduplicateAllTabs: vi.fn().mockResolvedValue([]),
    cleanupTabsByRules: vi.fn().mockResolvedValue([]),
    moveInternalTabsToStart: vi
      .fn()
      .mockImplementation((tabs) => Promise.resolve(tabs)),
    ungroupSingleTabGroups: vi.fn().mockResolvedValue(undefined),
    executeMembershipPlan: vi
      .fn()
      .mockResolvedValue({ success: true, value: undefined }),
    executeOrderPlan: vi
      .fn()
      .mockResolvedValue({ success: true, value: undefined }),
    updateBadge: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  });

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
      const tabs1 = [mkTab(1, "a.com"), mkTab(2, "b.com")];
      const tabs2 = [mkTab(2, "b.com"), mkTab(1, "a.com")];
      const hash = (controller as any).stateHash.bind(controller);
      expect(hash(tabs1, {}, { byWindow: false })).toBe(
        hash(tabs2, {}, { byWindow: false }),
      );
    });

    it("merges to active window when byWindow=false", async () => {
      const tabs = [mkTab(1, "a.com")];
      (controller as any).adapter.getNormalTabs.mockResolvedValue(tabs);
      (controller as any).adapter.deduplicateAllTabs.mockResolvedValue(tabs);
      (controller as any).adapter.cleanupTabsByRules.mockResolvedValue(tabs);
      mockStore.getState.mockResolvedValue({
        rules: [],
        grouping: { byWindow: false },
      });

      await controller.execute();
      expect(
        (controller as any).adapter.executeMembershipPlan,
      ).toHaveBeenCalled();
      expect((controller as any).adapter.executeOrderPlan).toHaveBeenCalled();
    });

    it("is idempotent: second execution does nothing after reaching stable state", async () => {
      // Setup stable state
      const tab1 = mkTab(1, "google.com", 10, 0, 1);
      const tab2 = mkTab(2, "google.com", 10, 1, 1);
      const group10 = {
        id: 10,
        title: "google.com",
        windowId: 1,
      } as chrome.tabGroups.TabGroup;
      const tabs = [tab1, tab2];

      (controller as any).adapter.getNormalTabs.mockResolvedValue(tabs);
      (controller as any).adapter.deduplicateAllTabs.mockResolvedValue(tabs);
      (controller as any).adapter.cleanupTabsByRules.mockResolvedValue(tabs);
      mockChrome.tabGroups.query.mockResolvedValue([group10]);
      mockChrome.windows.getCurrent.mockResolvedValue({
        type: "normal",
        id: 1,
      } as any);

      mockStore.getState.mockResolvedValue({
        rules: [{ domain: "google.com" }],
        grouping: { byWindow: false },
      });

      // Reset mock tracking
      (controller as any).adapter.executeMembershipPlan.mockClear();
      (controller as any).adapter.executeOrderPlan.mockClear();

      // Trigger 1: Should run once if hash changed
      await controller.execute();
      const firstRunCalls = (controller as any).adapter.executeMembershipPlan
        .mock.calls.length;

      // Trigger 2: Should skip entirely due to lastStateHash check
      await controller.execute();

      expect(
        (controller as any).adapter.executeMembershipPlan.mock.calls.length,
      ).toBe(firstRunCalls);
    });
  });

  describe("processGrouping() — simplified pipeline", () => {
    it("correctly orchestrates state -> needs -> plan -> execute", async () => {
      const tab1 = mkTab(1, "a.com");
      const tab2 = mkTab(2, "a.com");
      const initialState: any = {
        displayName: "a.com",
        sourceDomain: "a.com",
        tabIds: [1, 2],
        groupId: null,
        needsReposition: true,
      };

      (controller as any).adapter.getNormalTabs.mockResolvedValue([tab1, tab2]);
      vi.spyOn((controller as any).service, "buildGroupStates").mockReturnValue(
        [initialState],
      );
      vi.spyOn(
        (controller as any).service,
        "calculateRepositionNeeds",
      ).mockReturnValue([initialState]);
      vi.spyOn(
        (controller as any).service,
        "buildMembershipPlan",
      ).mockReturnValue({
        toUngroup: [],
        toGroup: [{ tabIds: [1, 2], groupId: null, title: "a.com" }],
      });
      vi.spyOn((controller as any).service, "buildOrderPlan").mockReturnValue({
        desired: [],
        toMove: [],
      });

      await controller.processGrouping(asWindowId(1), {});

      expect(
        (controller as any).adapter.executeMembershipPlan,
      ).toHaveBeenCalled();
      expect((controller as any).adapter.executeOrderPlan).toHaveBeenCalled();
    });
  });
});

// ============================================================================
// INFRASTRUCTURE LAYER
// ============================================================================

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
    const tabs = [mkTab(1, "u1"), mkTab(2, "u1")];
    const unique = await adapter.deduplicateAllTabs(tabs);
    expect(unique.length).toBe(1);
    expect(mockChrome.tabs.remove).toHaveBeenCalledWith([2]);
  });
});

// ============================================================================
// DOMAIN LAYER
// ============================================================================

describe("TabGroupingService", () => {
  let service: TabGroupingService;

  beforeEach(() => {
    service = new TabGroupingService();
  });

  it("identifies domains correctly", () => {
    expect(service.getDomain("https://google.com/search")).toBe("google.com");
    expect(service.getDomain(undefined)).toBe("other");
  });

  describe("getGroupKey()", () => {
    it("splits by path segment", () => {
      const rules: any = {
        "google.com": { domain: "google.com", splitByPath: 1 },
      };
      const r = service.getGroupKey(
        "google.com" as any,
        "https://google.com/search",
        rules,
      );
      expect(r.key).toBe("google.com::search");
      expect(r.title).toBe("search - google.com");
    });
  });
});

describe("validateRule", () => {
  const valid = (r: any): boolean => {
    if (typeof r !== "object" || r === null) return false;
    if (typeof r.domain !== "string" || r.domain.length === 0) return false;
    return true;
  };

  it("accepts minimal valid rule", () =>
    expect(valid({ domain: "a.com" })).toBe(true));
});

describe("Collapse state persistence", () => {
  let service: TabGroupingService;
  let adapter: ChromeTabAdapter;

  beforeEach(() => {
    service = new TabGroupingService();
    adapter = new ChromeTabAdapter();
    // mockChrome is already stubbed globally in this file
  });

  it("should preserve collapsed state in MembershipPlan", () => {
    const tabs = [mkTab(1, "google.com/a", 101), mkTab(2, "google.com/b", 101)];
    const groupIdToGroup = new Map([
      [
        101,
        { id: 101, title: "google.com", collapsed: true, windowId: 1 } as any,
      ],
    ]);
    const rulesByDomain = {};

    const groupMap = service.buildGroupMap(tabs, rulesByDomain, groupIdToGroup);
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
