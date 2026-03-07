import {
  ChromeTabAdapter,
  TabGroupingController,
} from "./background";
import {
  CacheManager,
  TabGroupingService,
  asTabId,
} from "./utils/grouping";
import { beforeEach, describe, expect, it, vi } from "vitest";

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
// HELPERS
// ============================================================================

const mkTab = (
  id: number,
  url: string,
  groupId: number | null = null,
  index = 0,
  windowId = 1,
): chrome.tabs.Tab => {
  const hasProtocol = /^[a-z-]+:/.test(url);
  return {
    id,
    url: hasProtocol ? url : `https://${url}`,
    index,
    windowId,
    groupId: groupId === null ? -1 : groupId,
    active: false,
    audible: false,
    autoDiscardable: true,
    discarded: false,
    favIconUrl: "",
    height: 0,
    highlighted: false,
    incognito: false,
    mutedInfo: { muted: false },
    pinned: false,
    selected: false,
    status: "complete",
    title: "",
    width: 0,
  };
};

// ============================================================================
// CACHE MANAGER
// ============================================================================

describe("CacheManager", () => {
  it("builds cache from initial tabs", () => {
    const tab = mkTab(1, "a.com");
    const cm = new CacheManager([tab]);
    expect(cm.has(1 as any)).toBe(true);
    expect(cm.get(1 as any)).toEqual(tab);
  });

  it("skips tabs with no id", () => {
    const cm = new CacheManager([
      { ...mkTab(1, "a.com"), id: undefined } as any,
    ]);
    expect(cm.snapshot().size).toBe(0);
  });

  describe("refresh()", () => {
    it("recovers missing tabs and reports recovered/missing", async () => {
      const tab = mkTab(1, "a.com");
      const cm = new CacheManager([]);
      mockChrome.tabs.get.mockResolvedValueOnce(tab);

      const { recovered, missing } = await cm.refresh([1 as any], (fn) =>
        Promise.resolve({ success: true, value: fn() }),
      );

      expect(recovered).toContain(1);
      expect(missing).toHaveLength(0);
      expect(cm.has(1 as any)).toBe(true);
    });

    it("reports missing when tabs.get() rejects", async () => {
      const cm = new CacheManager([]);
      mockChrome.tabs.get.mockRejectedValue(new Error("No tab"));

      const { recovered, missing } = await cm.refresh([99 as any], (fn) =>
        Promise.resolve({ success: false, error: new Error("fail") }),
      );

      expect(recovered).toHaveLength(0);
      expect(missing).toContain(99);
    });
  });

  describe("invalidate()", () => {
    it("replaces entire cache with new tabs", async () => {
      const cm = new CacheManager([mkTab(1, "a.com")]);
      await cm.invalidate([mkTab(2, "b.com")]);

      expect(cm.has(1 as any)).toBe(false);
      expect(cm.has(2 as any)).toBe(true);
    });
  });
});

// ============================================================================
// APPLICATION LAYER
// ============================================================================

describe("TabGroupingController", () => {
  let controller: TabGroupingController;

  const makeAdapterMock = (overrides: Record<string, any> = {}) => ({
    getNormalTabs: vi.fn().mockResolvedValue([]),
    deduplicateAllTabs: vi.fn().mockResolvedValue([]),
    cleanupTabsByRules: vi.fn().mockResolvedValue([]),
    executeGroupPlan: vi
      .fn()
      .mockResolvedValue({ success: true, value: undefined }),
    updateBadge: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    controller = new TabGroupingController();
    (controller as any).isProcessing = false;
    (controller as any).lastStateHash = null;
    (controller as any).adapter = makeAdapterMock();
    (controller as any).service = new TabGroupingService();
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
      expect(hash(tabs1, {}, { byWindow: false }, 1)).toBe(
        hash(tabs2, {}, { byWindow: false }, 1),
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

      vi.spyOn((controller as any).service, "createGroupPlan").mockReturnValue({
        states: [
          {
            tabIds: [1],
            displayName: "a.com",
            sourceDomain: "a.com",
            targetIndex: 0,
            isExternal: false,
          },
        ],
        tabsToUngroup: [],
      });

      await controller.execute();
      expect((controller as any).adapter.executeGroupPlan).toHaveBeenCalled();
    });

    it("skips calling chrome.tabs.move if tab is already at target window and index", async () => {
      const tab = mkTab(1, "a.com", -1, 5, 1);
      const plan: any = {
        states: [
          {
            tabIds: [1],
            displayName: "a.com",
            sourceDomain: "a.com",
            targetIndex: 5,
            isExternal: false,
            groupId: null,
          },
        ],
        tabsToUngroup: [],
      };

      const adapter = new ChromeTabAdapter();
      const snapshot = { tabs: [tab], groups: [] };

      await adapter.executeGroupPlan(
        plan,
        new Map(), // existingGroups
        1,         // targetWindowId
        snapshot,  // snapshotOverride
      );

      expect(mockChrome.tabs.move).not.toHaveBeenCalled();
    });

    it("does NOT skip move if windowId is different", async () => {
      const tab = mkTab(1, "a.com", -1, 5, 2);
      const plan: any = {
        states: [
          {
            tabIds: [1],
            displayName: "a.com",
            sourceDomain: "a.com",
            targetIndex: 5,
            isExternal: false,
            groupId: null,
          },
        ],
        tabsToUngroup: [],
      };

      const adapter = new ChromeTabAdapter();
      const snapshot = { tabs: [tab], groups: [] };

      await adapter.executeGroupPlan(
        plan,
        new Map(), // existingGroups
        1,         // targetWindowId
        snapshot,  // snapshotOverride
      );

      expect(mockChrome.tabs.move).toHaveBeenCalled();
    });

    it("falls back to 'Managed Group' if both displayName and sourceDomain are missing in executeGroupPlan", async () => {
      const plan: any = {
        states: [
          {
            tabIds: [1, 2],
            displayName: "", // Missing
            sourceDomain: "", // Missing
            targetIndex: 0,
            isExternal: false,
            groupId: null, // New group
          },
        ],
        tabsToUngroup: [],
      };

      const adapter = new ChromeTabAdapter();
      mockChrome.tabs.group.mockResolvedValue(1000);
      const snapshot = { tabs: [mkTab(1, "a.com"), mkTab(2, "b.com")], groups: [] };

      await adapter.executeGroupPlan(plan, new Map(), 1, snapshot);

      expect(mockChrome.tabGroups.update).toHaveBeenCalledWith(
        1000,
        expect.objectContaining({ title: "Managed Group" }),
      );
    });

    it("respects the architectural delay (TAB_UPDATE_DELAY) before updating group title", async () => {
      const plan: any = {
        states: [
          {
            tabIds: [1, 2],
            displayName: "Delayed Title",
            sourceDomain: "a.com",
            targetIndex: 0,
            isExternal: false,
            groupId: null,
          },
        ],
        tabsToUngroup: [],
      };

      const adapter = new ChromeTabAdapter();
      mockChrome.tabs.group.mockResolvedValue(1000);
      const snapshot = { tabs: [mkTab(1, "a.com"), mkTab(2, "b.com")], groups: [] };

      const startTime = Date.now();
      await adapter.executeGroupPlan(plan, new Map(), 1, snapshot);
      const endTime = Date.now();

      // We expect a delay of AT LEAST 50ms per the TAB_UPDATE_DELAY constant
      expect(endTime - startTime).toBeGreaterThanOrEqual(50);
      expect(mockChrome.tabGroups.update).toHaveBeenCalled();
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
      vi.spyOn((controller as any).service, "buildGroupStates").mockReturnValue([initialState]);
      vi.spyOn((controller as any).service, "calculateRepositionNeeds").mockReturnValue([initialState]);
      vi.spyOn((controller as any).service, "createGroupPlan").mockReturnValue({
        states: [initialState],
        tabsToUngroup: [],
      });

      await controller.processGrouping(
        [tab1, tab2],
        new Map(),
        new Map(),
        new Map(),
      );

      expect((controller as any).adapter.executeGroupPlan).toHaveBeenCalled();
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
    expect(mockChrome.tabs.query).toHaveBeenCalledWith({ windowType: "normal" });
  });

  it("deduplicates tabs by URL", async () => {
    const tabs = [mkTab(1, "u1"), mkTab(2, "u1")];
    const unique = await adapter.deduplicateAllTabs(tabs);
    expect(unique.length).toBe(1);
    expect(mockChrome.tabs.remove).toHaveBeenCalledWith([2]);
  });

  describe("executeGroupPlan()", () => {
    it("ungroups tabs listed in tabsToUngroup", async () => {
      const plan: any = {
        states: [],
        tabsToUngroup: [99],
      };
      const tab99 = mkTab(99, "intruder.com", 101);
      mockChrome.tabs.query.mockResolvedValue([tab99]);

      await adapter.executeGroupPlan(plan, new Map([[99, tab99]]), new Map());
      expect(mockChrome.tabs.ungroup).toHaveBeenCalledWith([99]);
    });
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
      const rules: any = { "google.com": { domain: "google.com", splitByPath: 1 } };
      const r = service.getGroupKey("google.com" as any, "https://google.com/search", rules);
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
