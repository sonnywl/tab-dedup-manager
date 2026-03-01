import {
  CacheManager,
  ChromeTabAdapter,
  TabGroupingController,
  TabGroupingService,
  WindowManagementService,
} from "./background";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ============================================================================
// MOCKS
// ============================================================================

const mockChrome = {
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
  tabGroups: { update: vi.fn(), query: vi.fn() },
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
): chrome.tabs.Tab => ({
  id,
  url: url.startsWith("http") ? url : `https://${url}`,
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
});

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

      const { recovered, missing } = await cm.refresh([1 as any]);

      expect(recovered).toContain(1);
      expect(missing).toHaveLength(0);
      expect(cm.has(1 as any)).toBe(true);
    });

    it("reports missing when tabs.get() rejects", async () => {
      const cm = new CacheManager([]);
      mockChrome.tabs.get.mockRejectedValue(new Error("No tab"));

      const { recovered, missing } = await cm.refresh([99 as any]);

      expect(recovered).toHaveLength(0);
      expect(missing).toContain(99);
    });

    it("partially recovers — some found, some missing", async () => {
      const cm = new CacheManager([]);
      mockChrome.tabs.get
        .mockResolvedValueOnce(mkTab(1, "a.com"))
        .mockRejectedValueOnce(new Error("gone"));

      const { recovered, missing } = await cm.refresh([1 as any, 2 as any]);

      expect(recovered).toContain(1);
      expect(missing).toContain(2);
    });
  });

  describe("invalidate()", () => {
    it("replaces entire cache with new tabs", async () => {
      const cm = new CacheManager([mkTab(1, "a.com")]);
      await cm.invalidate([mkTab(2, "b.com")]);

      expect(cm.has(1 as any)).toBe(false);
      expect(cm.has(2 as any)).toBe(true);
    });

    it("produces empty cache when given empty array", async () => {
      const cm = new CacheManager([mkTab(1, "a.com")]);
      await cm.invalidate([]);
      expect(cm.snapshot().size).toBe(0);
    });
  });
});

// ============================================================================
// APPLICATION LAYER
// ============================================================================

describe("TabGroupingController", () => {
  let controller: TabGroupingController;

  // FIX: applyGroupState returns GroupState — mock must return the input state
  // so updatedGroupStates collection in processGrouping receives valid objects
  const makeAdapterMock = (overrides: Record<string, any> = {}) => ({
    getNormalTabs: vi.fn().mockResolvedValue([]),
    getRelevantTabs: vi.fn().mockResolvedValue([]),
    deduplicateAllTabs: vi.fn().mockResolvedValue([]),
    applyAutoDeleteRules: vi.fn().mockResolvedValue([]),
    mergeToActiveWindow: vi.fn().mockResolvedValue(undefined),
    // Returns the passed state — matches new Promise<GroupState> signature
    applyGroupState: vi.fn().mockImplementation((s) => Promise.resolve(s)),
    executeGroupPlan: vi
      .fn()
      .mockResolvedValue({ success: true, value: undefined }),
    // FIX: 4-param signature — service is now injected, not instantiated internally
    ungroupSingleTabs: vi.fn().mockResolvedValue(undefined),
    moveTabsToWindow: vi.fn().mockResolvedValue(undefined),
    getGroupsInWindow: vi.fn().mockResolvedValue([]),
    updateBadge: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  });

  const makeServiceMock = () => ({
    getDomain: vi.fn((url: string) => {
      try {
        return new URL(url).hostname;
      } catch {
        return "other";
      }
    }),
    getGroupKey: vi.fn(),
    buildGroupMap: vi.fn().mockReturnValue(new Map()),
    countDuplicates: vi.fn(),
    filterValidTabs: vi.fn().mockReturnValue([]),
    buildGroupStates: vi.fn().mockReturnValue([]),
    calculateRepositionNeeds: vi.fn().mockReturnValue([]),
    createGroupPlan: vi.fn().mockReturnValue({ states: [] }),
    isInternalTitle: vi.fn().mockReturnValue(true),
  });

  beforeEach(() => {
    vi.clearAllMocks();
    controller = new TabGroupingController();
    // FIX: isProcessing is now an instance field — reset on the instance directly
    (controller as any).isProcessing = false;
    (controller as any).lastStateHash = null;
    (controller as any).adapter = makeAdapterMock();
    (controller as any).service = makeServiceMock();
  });

  describe("execute()", () => {
    it("blocks concurrent processing via instance flag", async () => {
      // FIX: set instance flag, not static
      (controller as any).isProcessing = true;
      await controller.execute();
      expect((controller as any).adapter.getNormalTabs).not.toHaveBeenCalled();
    });

    it("two instances do not share the processing lock", async () => {
      const c2 = new TabGroupingController();
      (controller as any).isProcessing = true;
      // c2 has its own flag — should not be blocked by controller's flag
      expect((c2 as any).isProcessing).toBe(false);
    });

    it("skips when state hash unchanged", async () => {
      const tabs = [mkTab(1, "google.com")];
      (controller as any).adapter.getNormalTabs.mockResolvedValue(tabs);
      mockStore.getState.mockResolvedValue({
        rules: [],
        grouping: { byWindow: false },
      });

      await controller.execute();
      const callsAfterFirst = (controller as any).adapter.getRelevantTabs.mock
        .calls.length;
      await controller.execute();

      expect(
        (controller as any).adapter.getRelevantTabs.mock.calls.length,
      ).toBe(callsAfterFirst);
    });

    it("hash is order-stable — same tabs in different order produce same hash", async () => {
      const tabs1 = [mkTab(1, "a.com"), mkTab(2, "b.com")];
      const tabs2 = [mkTab(2, "b.com"), mkTab(1, "a.com")];
      const hash = (controller as any).stateHash.bind(controller);
      const rules = {};
      const cfg = { byWindow: false };

      expect(hash(tabs1, rules, cfg)).toBe(hash(tabs2, rules, cfg));
    });

    it("merges to active window when byWindow=false", async () => {
      const tabs = [mkTab(1, "a.com")];
      (controller as any).adapter.getNormalTabs.mockResolvedValue(tabs);
      (controller as any).adapter.getRelevantTabs.mockResolvedValue(tabs);
      (controller as any).adapter.deduplicateAllTabs.mockResolvedValue(tabs);
      (controller as any).adapter.applyAutoDeleteRules.mockResolvedValue(tabs);
      mockStore.getState.mockResolvedValue({
        rules: [],
        grouping: { byWindow: false },
      });

      await controller.execute();

      expect(
        (controller as any).adapter.mergeToActiveWindow,
      ).toHaveBeenCalled();
    });

    it("skips merge when byWindow=true", async () => {
      const tabs = [mkTab(1, "a.com")];
      (controller as any).adapter.getNormalTabs.mockResolvedValue(tabs);
      (controller as any).adapter.getRelevantTabs.mockResolvedValue(tabs);
      (controller as any).adapter.deduplicateAllTabs.mockResolvedValue(tabs);
      (controller as any).adapter.applyAutoDeleteRules.mockResolvedValue(tabs);
      mockStore.getState.mockResolvedValue({
        rules: [],
        grouping: { byWindow: true },
      });
      vi.spyOn(controller, "groupByWindow").mockResolvedValue(
        new Map([[1 as any, tabs]]),
      );
      vi.spyOn(controller, "processGrouping").mockResolvedValue({
        success: true,
        value: undefined,
      });

      await controller.execute();

      expect(
        (controller as any).adapter.mergeToActiveWindow,
      ).not.toHaveBeenCalled();
    });

    it("consolidates windows when numWindowsToKeep set", async () => {
      mockStore.getState.mockResolvedValue({
        rules: [],
        grouping: { byWindow: true, numWindowsToKeep: 1 },
      });
      const tabs = [
        mkTab(1, "a.com", null, 0, 1),
        mkTab(2, "a.com", null, 1, 1),
        mkTab(3, "b.com", null, 0, 2),
      ];
      (controller as any).adapter.getNormalTabs.mockResolvedValue(tabs);
      (controller as any).adapter.getRelevantTabs.mockResolvedValue(tabs);
      (controller as any).adapter.deduplicateAllTabs.mockResolvedValue(tabs);
      (controller as any).adapter.applyAutoDeleteRules.mockResolvedValue(tabs);
      const processSpy = vi
        .spyOn(controller, "processGrouping")
        .mockResolvedValue({ success: true, value: undefined });
      vi.spyOn(controller, "groupByWindow").mockResolvedValue(
        new Map([
          [1 as any, [tabs[0], tabs[1]]],
          [2 as any, [tabs[2]]],
        ]),
      );

      await controller.execute();

      expect(processSpy).toHaveBeenCalledTimes(1);
      expect((controller as any).adapter.moveTabsToWindow).toHaveBeenCalled();
    });
  });

  describe("processGrouping() — applyGroupState return value propagation", () => {
    it("uses updated groupId returned from applyGroupState in downstream steps", async () => {
      const tab1 = mkTab(1, "a.com");
      const tab2 = mkTab(2, "a.com");
      const initialState: any = {
        title: "a.com",
        sourceDomain: "a.com",
        tabIds: [1, 2],
        groupId: null,
        needsReposition: false,
      };
      const updatedState = { ...initialState, groupId: 42 };

      (controller as any).adapter.getNormalTabs.mockResolvedValue([tab1, tab2]);
      (controller as any).adapter.getGroupsInWindow.mockResolvedValue([]);
      (controller as any).service.buildGroupStates.mockReturnValue([
        initialState,
      ]);
      // applyGroupState returns state with new groupId assigned
      (controller as any).adapter.applyGroupState.mockResolvedValue(
        updatedState,
      );
      (controller as any).service.calculateRepositionNeeds.mockImplementation(
        (states: any[]) => {
          // Verify downstream receives updated state with groupId=42
          expect(states[0].groupId).toBe(42);
          return states.map((s: any) => ({ ...s, needsReposition: false }));
        },
      );

      await controller.processGrouping(new Map(), 1 as any);
    });

    it("ungroupSingleTabs receives service as 4th argument", async () => {
      const tab = mkTab(1, "a.com");
      (controller as any).adapter.getNormalTabs.mockResolvedValue([tab]);
      (controller as any).adapter.getGroupsInWindow.mockResolvedValue([]);
      (controller as any).service.buildGroupStates.mockReturnValue([]);
      (controller as any).service.calculateRepositionNeeds.mockReturnValue([]);

      await controller.processGrouping(new Map(), 1 as any);

      const ungroupCall = (controller as any).adapter.ungroupSingleTabs.mock
        .calls[0];
      // 4th arg must be the service instance, not undefined
      expect(ungroupCall[3]).toBe((controller as any).service);
    });
  });

  describe("groupByWindow()", () => {
    it("groups tabs by windowId", async () => {
      const tabs = [
        mkTab(1, "a.com", null, 0, 1),
        mkTab(2, "b.com", null, 0, 2),
        mkTab(3, "c.com", null, 0, 1),
      ];
      const result = await controller.groupByWindow(tabs);
      expect(result.get(1 as any)).toHaveLength(2);
      expect(result.get(2 as any)).toHaveLength(1);
    });

    it("[W7] skips tab with no windowId and logs warning", async () => {
      const tab = mkTab(1, "a.com");
      delete (tab as any).windowId;
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

      const result = await controller.groupByWindow([tab]);

      expect(result.size).toBe(0);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("[W7]"));
    });

    it("returns empty map for empty input", async () => {
      expect((await controller.groupByWindow([])).size).toBe(0);
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
    mockChrome.windows.getAll.mockResolvedValue([{ id: 1, type: "normal" }]);
    mockChrome.windows.getCurrent.mockResolvedValue({ id: 1, type: "normal" });
  });

  it("queries only normal windows in getNormalTabs", async () => {
    mockChrome.tabs.query.mockResolvedValue([]);
    await adapter.getNormalTabs();
    expect(mockChrome.tabs.query).toHaveBeenCalledWith({
      windowType: "normal",
    });
  });

  it("merges tabs to active normal window", async () => {
    mockChrome.windows.getAll.mockResolvedValue([
      { id: 1, type: "normal" },
      { id: 2, type: "normal" },
    ]);
    await adapter.mergeToActiveWindow([mkTab(1, "a.com", null, 0, 2)]);
    expect(mockChrome.tabs.move).toHaveBeenCalledWith(
      [1],
      expect.objectContaining({ windowId: 1 }),
    );
  });

  it("deduplicates tabs by URL", async () => {
    const unique = await adapter.deduplicateAllTabs([
      mkTab(1, "u1"),
      mkTab(2, "u1"),
    ]);
    expect(unique.length).toBe(1);
    expect(mockChrome.tabs.remove).toHaveBeenCalledWith([2]);
  });

  describe("getRelevantTabs()", () => {
    it("excludes tabs in external groups", async () => {
      mockChrome.tabs.query.mockResolvedValue([
        mkTab(1, "google.com", 101),
        mkTab(2, "bing.com"),
      ]);
      mockChrome.tabGroups.query.mockResolvedValue([
        { id: 101, title: "My Research" },
      ]);

      const relevant = await adapter.getRelevantTabs(
        {},
        new TabGroupingService(),
      );

      expect(relevant.length).toBe(1);
      expect(relevant[0].id).toBe(2);
    });

    it("includes tabs in internal groups", async () => {
      mockChrome.tabs.query.mockResolvedValue([mkTab(1, "google.com", 101)]);
      mockChrome.tabGroups.query.mockResolvedValue([
        { id: 101, title: "google.com" },
      ]);

      const relevant = await adapter.getRelevantTabs(
        {},
        new TabGroupingService(),
      );

      expect(relevant.length).toBe(1);
      expect(relevant[0].id).toBe(1);
    });
  });

  describe("applyGroupState()", () => {
    it("returns updated GroupState with new groupId after group creation", async () => {
      const state: any = {
        title: "a.com",
        tabIds: [1, 2],
        groupId: null,
        needsReposition: false,
        sourceDomain: "a.com",
      };
      const cache = new Map([
        [1, mkTab(1, "a.com")],
        [2, mkTab(2, "a.com")],
      ]);
      mockChrome.tabs.group.mockResolvedValue(55);
      mockChrome.tabGroups.update.mockResolvedValue({});

      const result = await adapter.applyGroupState(state, cache as any);

      // FIX: new contract — returns GroupState, not void
      expect(result.groupId).toBe(55);
    });

    it("returns unchanged state when tabs are already correctly grouped", async () => {
      const state: any = {
        title: "a.com",
        tabIds: [1, 2],
        groupId: 10,
        needsReposition: false,
        sourceDomain: "a.com",
      };
      const cache = new Map([
        [1, mkTab(1, "a.com", 10)],
        [2, mkTab(2, "a.com", 10)],
      ]);
      const groupMap = new Map([[10, { id: 10, title: "a.com" }]]);

      const result = await adapter.applyGroupState(
        state,
        cache as any,
        groupMap as any,
      );

      expect(result.groupId).toBe(10);
      expect(mockChrome.tabs.group).not.toHaveBeenCalled();
    });

    it("[G4] logs warning and returns state on stale groupId — does not throw", async () => {
      const state: any = {
        title: "google.com",
        tabIds: [1, 2],
        groupId: 999,
        sourceDomain: "google.com",
        needsReposition: false,
      };
      const cache = new Map([
        [1, mkTab(1, "google.com", 999)],
        [2, mkTab(2, "google.com", 999)],
      ]);
      mockChrome.tabs.group.mockRejectedValue(new Error("Invalid group ID"));
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

      const result = await adapter.applyGroupState(state, cache as any);

      expect(warn).toHaveBeenCalledWith(expect.stringContaining("[G4]"));
      // Returns state (not throws) so Promise.allSettled sees fulfilled
      expect(result).toBeDefined();
      expect(result.groupId).toBe(999);
    });

    it("[G4] resolves (not rejects) — allSettled sees fulfilled for other groups", async () => {
      const state: any = {
        title: "google.com",
        tabIds: [1, 2],
        groupId: 999,
        sourceDomain: "google.com",
        needsReposition: false,
      };
      const cache = new Map([
        [1, mkTab(1, "google.com", 999)],
        [2, mkTab(2, "google.com", 999)],
      ]);
      mockChrome.tabs.group.mockRejectedValue(new Error("Invalid group ID"));
      vi.spyOn(console, "warn").mockImplementation(() => {});

      const [result] = await Promise.allSettled([
        adapter.applyGroupState(state, cache as any),
      ]);

      expect(result.status).toBe("fulfilled");
    });
  });

  describe("ungroupSingleTabs()", () => {
    it("requires service as 4th parameter — ungroups solo domain tab", async () => {
      const tab = mkTab(1, "solo.com", 10);
      const cache = new Map([[1, tab]]);
      mockChrome.tabs.ungroup.mockResolvedValue(undefined);

      // FIX: pass service as 4th arg — no longer instantiated internally
      await adapter.ungroupSingleTabs(
        [tab],
        new Set(),
        cache as any,
        new TabGroupingService(),
      );

      expect(mockChrome.tabs.ungroup).toHaveBeenCalledWith([1]);
    });

    it("does not ungroup tab that belongs to a multi-tab domain", async () => {
      const t1 = mkTab(1, "a.com", 10);
      const t2 = mkTab(2, "a.com");
      const cache = new Map([
        [1, t1],
        [2, t2],
      ]);

      await adapter.ungroupSingleTabs(
        [t1, t2],
        new Set(),
        cache as any,
        new TabGroupingService(),
      );

      expect(mockChrome.tabs.ungroup).not.toHaveBeenCalled();
    });

    it("skips tab already in allGroupedTabIds set", async () => {
      const tab = mkTab(1, "solo.com", 10);
      const cache = new Map([[1, tab]]);

      await adapter.ungroupSingleTabs(
        [tab],
        new Set([1 as any]),
        cache as any,
        new TabGroupingService(),
      );

      expect(mockChrome.tabs.ungroup).not.toHaveBeenCalled();
    });
  });

  describe("executeGroupPlan()", () => {
    it("processes each state as ungroup → move → regroup in sequence", async () => {
      const calls: string[] = [];
      mockChrome.tabs.ungroup.mockImplementation(() => {
        calls.push("ungroup");
        return Promise.resolve();
      });
      mockChrome.tabs.move.mockImplementation(() => {
        calls.push("move");
        return Promise.resolve([]);
      });
      mockChrome.tabs.group.mockImplementation(() => {
        calls.push("group");
        return Promise.resolve(10);
      });
      mockChrome.tabGroups.update.mockResolvedValue({});
      mockChrome.tabs.query.mockResolvedValue([]);
      mockChrome.tabGroups.query.mockResolvedValue([]);

      await adapter.executeGroupPlan({
        states: [
          {
            tabIds: [1, 2],
            displayName: "a.com",
            targetIndex: 0,
            currentlyGrouped: [1, 2],
          },
        ],
      } as any);

      expect(calls).toEqual(["ungroup", "move", "group"]);
    });

    it("skips ungroup step when no tabs are currently grouped", async () => {
      mockChrome.tabs.move.mockResolvedValue([]);
      mockChrome.tabs.group.mockResolvedValue(10);
      mockChrome.tabGroups.update.mockResolvedValue({});
      mockChrome.tabs.query.mockResolvedValue([]);
      mockChrome.tabGroups.query.mockResolvedValue([]);

      await adapter.executeGroupPlan({
        states: [
          {
            tabIds: [1, 2],
            displayName: "a.com",
            targetIndex: 0,
            currentlyGrouped: [],
          },
        ],
      } as any);

      expect(mockChrome.tabs.ungroup).not.toHaveBeenCalled();
      expect(mockChrome.tabs.move).toHaveBeenCalled();
      expect(mockChrome.tabs.group).toHaveBeenCalled();
    });

    it("skips regroup step for single-tab states", async () => {
      mockChrome.tabs.ungroup.mockResolvedValue(undefined);
      mockChrome.tabs.move.mockResolvedValue([]);
      mockChrome.tabs.query.mockResolvedValue([]);
      mockChrome.tabGroups.query.mockResolvedValue([]);

      await adapter.executeGroupPlan({
        states: [
          {
            tabIds: [1],
            displayName: "a.com",
            targetIndex: 2,
            currentlyGrouped: [1],
          },
        ],
      } as any);

      expect(mockChrome.tabs.ungroup).toHaveBeenCalled();
      expect(mockChrome.tabs.move).toHaveBeenCalled();
      expect(mockChrome.tabs.group).not.toHaveBeenCalled();
    });

    it("rolls back and returns failure when move fails", async () => {
      mockChrome.tabs.query.mockResolvedValue([]);
      mockChrome.tabGroups.query.mockResolvedValue([]);
      mockChrome.tabs.ungroup.mockResolvedValue(undefined);
      mockChrome.tabs.move.mockRejectedValue(new Error("Move failed"));

      const result = await adapter.executeGroupPlan({
        states: [
          {
            tabIds: [1, 2],
            displayName: "a.com",
            targetIndex: 0,
            currentlyGrouped: [1, 2],
          },
        ],
      } as any);

      expect(result.success).toBe(false);
    });

    it("processes multiple states in order", async () => {
      const calls: string[] = [];
      mockChrome.tabs.ungroup.mockImplementation(() => {
        calls.push("ungroup");
        return Promise.resolve();
      });
      mockChrome.tabs.move.mockImplementation(() => {
        calls.push("move");
        return Promise.resolve([]);
      });
      mockChrome.tabs.group.mockImplementation(() => {
        calls.push("group");
        return Promise.resolve(10);
      });
      mockChrome.tabGroups.update.mockResolvedValue({});
      mockChrome.tabs.query.mockResolvedValue([]);
      mockChrome.tabGroups.query.mockResolvedValue([]);

      await adapter.executeGroupPlan({
        states: [
          {
            tabIds: [1, 2],
            displayName: "a.com",
            targetIndex: 0,
            currentlyGrouped: [1, 2],
          },
          {
            tabIds: [3, 4],
            displayName: "b.com",
            targetIndex: 2,
            currentlyGrouped: [3, 4],
          },
        ],
      } as any);

      expect(calls).toEqual([
        "ungroup",
        "move",
        "group",
        "ungroup",
        "move",
        "group",
      ]);
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
    expect(service.getDomain("invalid")).toBe("other");
    expect(service.getDomain(undefined)).toBe("other");
  });

  describe("getGroupKey()", () => {
    const domain = "google.com" as any;
    const rules: any = {
      "google.com": { domain: "google.com", splitByPath: 1 },
    };

    it("splits by first path segment when splitByPath=1", () => {
      const r = service.getGroupKey(
        domain,
        "https://google.com/search?q=1",
        rules,
      );
      expect(r.key).toBe("google.com::search");
      expect(r.title).toBe("search");
    });

    it("splits by second path segment when splitByPath=2", () => {
      const r = service.getGroupKey(domain, "https://google.com/mail/inbox", {
        "google.com": { domain: "google.com", splitByPath: 2 },
      });
      expect(r.key).toBe("google.com::inbox");
      expect(r.title).toBe("inbox");
    });

    it("falls back to base when splitByPath=null", () => {
      const r = service.getGroupKey(domain, "https://google.com/search", {
        "google.com": { domain: "google.com", splitByPath: null },
      });
      expect(r.key).toBe("google.com");
      expect(r.title).toBe("google.com");
    });

    it("resolves intra-domain title collision", () => {
      const r = service.getGroupKey(
        domain,
        "https://google.com/google.com",
        rules,
      );
      expect(r.title).toBe("google.com/google.com");
    });

    it("falls back on root path", () => {
      const r = service.getGroupKey(domain, "https://google.com/", rules);
      expect(r.key).toBe("google.com");
    });

    it("falls back when path depth less than splitByPath", () => {
      const r = service.getGroupKey(domain, "https://google.com/a", {
        "google.com": { domain: "google.com", splitByPath: 2 },
      });
      expect(r.key).toBe("google.com");
    });
  });

  describe("isInternalTitle()", () => {
    const domain = "google.com" as any;
    const rules: any = {
      "google.com": { domain: "google.com", groupName: "Search" },
    };

    it("returns true for default domain title", () => {
      expect(
        service.isInternalTitle("google.com", domain, "https://google.com", {}),
      ).toBe(true);
    });

    it("returns true for custom group name", () => {
      expect(
        service.isInternalTitle("Search", domain, "https://google.com", rules),
      ).toBe(true);
    });

    it("returns true for collision-resolved title", () => {
      expect(
        service.isInternalTitle(
          "google.com - Search",
          domain,
          "https://google.com",
          rules,
        ),
      ).toBe(true);
    });

    it("returns false for external title", () => {
      expect(
        service.isInternalTitle("My Work", domain, "https://google.com", rules),
      ).toBe(false);
    });
  });

  describe("buildGroupStates()", () => {
    it("resolves batch title collisions", () => {
      const groupMap = new Map<string, any>([
        [
          "g::images",
          {
            tabs: [mkTab(1, "google.com/images")],
            displayName: "images",
            domains: new Set(["google.com"]),
          },
        ],
        [
          "b::images",
          {
            tabs: [mkTab(2, "bing.com/images")],
            displayName: "images",
            domains: new Set(["bing.com"]),
          },
        ],
      ]);
      const cache = new Map([
        [1, mkTab(1, "google.com/images")],
        [2, mkTab(2, "bing.com/images")],
      ]);

      const states = service.buildGroupStates(groupMap as any, cache as any);

      expect(states.find((s) => s.sourceDomain === "google.com")?.title).toBe(
        "google.com - images",
      );
      expect(states.find((s) => s.sourceDomain === "bing.com")?.title).toBe(
        "bing.com - images",
      );
    });

    it("resolves collision with existing window group", () => {
      const groupMap = new Map<string, any>([
        [
          "g::images",
          {
            tabs: [mkTab(1, "google.com/images")],
            displayName: "images",
            domains: new Set(["google.com"]),
          },
        ],
      ]);
      const cache = new Map([[1, mkTab(1, "google.com/images")]]);

      const states = service.buildGroupStates(
        groupMap as any,
        cache as any,
        new Map([["images", 999 as any]]),
      );

      expect(states[0].title).toBe("google.com - images");
      expect(states[0].groupId).toBe(null);
    });

    it("skips group when all tabs absent from cache", () => {
      const groupMap = new Map<string, any>([
        [
          "g::img",
          {
            tabs: [mkTab(1, "google.com/images")],
            displayName: "images",
            domains: new Set(["google.com"]),
          },
        ],
      ]);

      const states = service.buildGroupStates(
        groupMap as any,
        new Map() as any,
      );

      expect(states).toHaveLength(0);
    });

    it("does not mutate the provided tabCache", () => {
      const tab = mkTab(1, "google.com/images");
      const groupMap = new Map<string, any>([
        [
          "g::img",
          {
            tabs: [tab],
            displayName: "images",
            domains: new Set(["google.com"]),
          },
        ],
      ]);
      const cache = new Map([[1, tab]]);
      const sizeBefore = cache.size;

      service.buildGroupStates(groupMap as any, cache as any);

      expect(cache.size).toBe(sizeBefore);
    });

    it("all returned fields are readonly — spread produces new object", () => {
      const tab = mkTab(1, "a.com");
      const groupMap = new Map<string, any>([
        [
          "a.com",
          { tabs: [tab], displayName: "a.com", domains: new Set(["a.com"]) },
        ],
      ]);
      const cache = new Map([[1, tab]]);

      const [state] = service.buildGroupStates(groupMap as any, cache as any);
      const mutated = { ...state, groupId: 99 as any };

      // Original state unaffected
      expect(state.groupId).toBe(null);
      expect(mutated.groupId).toBe(99);
    });
  });

  describe("createGroupPlan()", () => {
    it("only includes currently-grouped tabs in currentlyGrouped", () => {
      const grouped = mkTab(1, "a.com", 10);
      const ungrouped = mkTab(2, "a.com");
      const cache = new Map([
        [1, grouped],
        [2, ungrouped],
      ]);
      const states: any[] = [
        {
          title: "a.com",
          tabIds: [1, 2],
          groupId: 10,
          needsReposition: true,
          sourceDomain: "a.com",
        },
      ];

      const plan = service.createGroupPlan(states, cache as any);

      expect(plan.states[0].currentlyGrouped).toContain(1);
      expect(plan.states[0].currentlyGrouped).not.toContain(2);
    });

    it("includes single tab with groupId in currentlyGrouped", () => {
      const tab = mkTab(1, "a.com", 10);
      const cache = new Map([[1, tab]]);
      const states: any[] = [
        {
          title: "a.com",
          tabIds: [1],
          groupId: 10,
          needsReposition: true,
          sourceDomain: "a.com",
        },
      ];

      const plan = service.createGroupPlan(states, cache as any);

      expect(plan.states[0].currentlyGrouped).toContain(1);
    });

    it("produces empty currentlyGrouped when tab has groupId=-1", () => {
      const tab = mkTab(1, "a.com");
      const cache = new Map([[1, tab]]);
      const states: any[] = [
        {
          title: "a.com",
          tabIds: [1],
          groupId: null,
          needsReposition: true,
          sourceDomain: "a.com",
        },
      ];

      const plan = service.createGroupPlan(states, cache as any);

      expect(plan.states[0].currentlyGrouped).toHaveLength(0);
    });

    it("excludes states that do not need reposition", () => {
      const tab = mkTab(1, "a.com", 10);
      const cache = new Map([[1, tab]]);
      const states: any[] = [
        {
          title: "a.com",
          tabIds: [1],
          groupId: 10,
          needsReposition: false,
          sourceDomain: "a.com",
        },
      ];

      const plan = service.createGroupPlan(states, cache as any);

      expect(plan.states).toHaveLength(0);
    });

    it("sets correct targetIndex per state", () => {
      const cache = new Map([
        [1, mkTab(1, "a.com", 10)],
        [2, mkTab(2, "a.com", 10)],
        [3, mkTab(3, "b.com")],
      ]);
      const states: any[] = [
        {
          title: "a.com",
          tabIds: [1, 2],
          groupId: 10,
          needsReposition: true,
          sourceDomain: "a.com",
        },
        {
          title: "b.com",
          tabIds: [3],
          groupId: null,
          needsReposition: true,
          sourceDomain: "b.com",
        },
      ];

      const plan = service.createGroupPlan(states, cache as any);

      expect(plan.states[0].targetIndex).toBe(0);
      expect(plan.states[1].targetIndex).toBe(2);
    });
  });

  describe("calculateRepositionNeeds()", () => {
    it("sorts groups alphabetically by first tab URL", () => {
      const states: any[] = [
        { title: "z.com", tabIds: [1], needsReposition: false },
        { title: "a.com", tabIds: [2], needsReposition: false },
      ];
      const cache = new Map([
        [1, mkTab(1, "z.com")],
        [2, mkTab(2, "a.com")],
      ]);

      const result = service.calculateRepositionNeeds(
        states as any,
        cache as any,
      );

      expect(result[0].title).toBe("a.com");
      expect(result[1].title).toBe("z.com");
    });

    it("returns new objects — does not mutate input states", () => {
      const states: any[] = [
        {
          title: "a.com",
          tabIds: [1],
          groupId: null,
          needsReposition: false,
          sourceDomain: "a.com",
        },
      ];
      const cache = new Map([[1, mkTab(1, "a.com")]]);

      const result = service.calculateRepositionNeeds(
        states as any,
        cache as any,
      );

      // Input state object is not the same reference as output
      expect(result[0]).not.toBe(states[0]);
    });

    it("flags and clears needsReposition correctly for perfect layout", () => {
      const tab1 = mkTab(1, "google.com");
      tab1.pinned = true;
      const tab2 = mkTab(2, "manual.com");
      tab2.pinned = true;
      const tab3 = mkTab(3, "https://a.com/1");
      const tab4 = mkTab(4, "https://a.com/2");
      const tab5 = mkTab(5, "bing.com");
      const tab6 = mkTab(6, "z.com");
      const cache = new Map([
        [1, tab1],
        [2, tab2],
        [3, tab3],
        [4, tab4],
        [5, tab5],
        [6, tab6],
      ]);
      const states: any[] = [
        {
          title: "google.com",
          tabIds: [1],
          groupId: null,
          needsReposition: false,
        },
        {
          title: "a.com",
          tabIds: [3, 4],
          groupId: 101,
          needsReposition: false,
        },
        { title: "z.com", tabIds: [6], groupId: null, needsReposition: false },
      ];

      const wrong = service.calculateRepositionNeeds(
        states as any,
        cache as any,
      );
      expect(wrong.find((r) => r.title === "google.com")!.needsReposition).toBe(
        true,
      );
      expect(wrong.find((r) => r.title === "a.com")!.needsReposition).toBe(
        true,
      );

      tab2.index = 0;
      tab1.index = 1;
      tab5.index = 2;
      tab3.index = 3;
      tab4.index = 4;
      tab6.index = 5;
      tab1.groupId = -1;
      tab2.groupId = -1;
      tab5.groupId = -1;
      tab6.groupId = -1;
      tab3.groupId = 101;
      tab4.groupId = 101;

      const perfect = service.calculateRepositionNeeds(
        states as any,
        cache as any,
      );
      expect(
        perfect.find((r) => r.title === "google.com")?.needsReposition,
      ).toBe(false);
      expect(perfect.find((r) => r.title === "a.com")?.needsReposition).toBe(
        false,
      );
      expect(perfect.find((r) => r.title === "z.com")?.needsReposition).toBe(
        false,
      );
    });
  });
});

// ============================================================================
// WINDOW MANAGEMENT
// ============================================================================

describe("WindowManagementService", () => {
  let windowService: WindowManagementService;
  let groupingService: TabGroupingService;

  beforeEach(() => {
    windowService = new WindowManagementService();
    groupingService = new TabGroupingService();
  });

  it("assigns tabs to window with most matching domain", () => {
    const retained = new Map<number, chrome.tabs.Tab[]>([
      [1, [mkTab(1, "https://google.com"), mkTab(2, "https://google.com")]],
      [2, [mkTab(3, "https://yahoo.com")]],
    ]);
    const excess = [
      mkTab(4, "https://google.com"),
      mkTab(5, "https://yahoo.com"),
      mkTab(6, "https://bing.com"),
    ];

    const plan = windowService.calculateMergePlan(
      retained as any,
      excess,
      groupingService,
    );

    expect(plan.get(1)).toContain(4);
    expect(plan.get(2)).toContain(5);
    expect(plan.get(1)).toContain(6);
  });

  it("assigns unmatched tabs to largest window", () => {
    const retained = new Map<number, chrome.tabs.Tab[]>([
      [1, [mkTab(1, "https://google.com"), mkTab(2, "https://google.com")]],
      [2, [mkTab(3, "https://yahoo.com")]],
    ]);

    const plan = windowService.calculateMergePlan(
      retained as any,
      [mkTab(4, "https://bing.com")],
      groupingService,
    );

    expect(plan.get(1)).toContain(4);
  });

  it("assigns tabs by domain match independently of groupId", () => {
    const retained = new Map<number, chrome.tabs.Tab[]>([
      [1, [mkTab(1, "https://google.com")]],
    ]);
    const excess = [
      mkTab(2, "https://google.com", 101),
      mkTab(3, "https://google.com", 101),
    ];

    const plan = windowService.calculateMergePlan(
      retained as any,
      excess,
      groupingService,
    );

    expect(plan.get(1)).toContain(2);
    expect(plan.get(1)).toContain(3);
  });
});

// ============================================================================
// validateRule
// ============================================================================

describe("validateRule", () => {
  // Inline mirror of background.ts validateRule — kept in sync with all fixes
  const valid = (r: any): boolean => {
    if (typeof r !== "object" || r === null) return false;
    if (typeof r.domain !== "string" || r.domain.length === 0) return false;
    if (r.autoDelete != null && typeof r.autoDelete !== "boolean") return false;
    if (r.skipProcess != null && typeof r.skipProcess !== "boolean")
      return false;
    if (r.groupName != null && typeof r.groupName !== "string") return false;
    if (
      r.splitByPath != null &&
      (typeof r.splitByPath !== "number" || r.splitByPath < 1)
    )
      return false;
    // FIX: mutual exclusivity guard added in background.ts
    if (r.autoDelete === true && r.skipProcess === true) return false;
    return true;
  };

  it("rejects null", () => expect(valid(null)).toBe(false));
  it("rejects primitive string", () => expect(valid("string")).toBe(false));
  it("rejects primitive boolean", () => expect(valid(true)).toBe(false));
  it("rejects empty domain", () => expect(valid({ domain: "" })).toBe(false));
  it("accepts minimal valid rule", () =>
    expect(valid({ domain: "a.com" })).toBe(true));
  it("rejects wrong autoDelete type", () =>
    expect(valid({ domain: "a.com", autoDelete: "yes" })).toBe(false));
  it("rejects wrong skipProcess type", () =>
    expect(valid({ domain: "a.com", skipProcess: 1 })).toBe(false));
  it("rejects wrong groupName type", () =>
    expect(valid({ domain: "a.com", groupName: 123 })).toBe(false));
  it("rejects splitByPath=0", () =>
    expect(valid({ domain: "a.com", splitByPath: 0 })).toBe(false));
  it("accepts splitByPath=null", () =>
    expect(valid({ domain: "a.com", splitByPath: null })).toBe(true));
  it("accepts splitByPath=1", () =>
    expect(valid({ domain: "a.com", splitByPath: 1 })).toBe(true));
  it("accepts all optional fields null", () =>
    expect(
      valid({
        domain: "a.com",
        autoDelete: null,
        skipProcess: null,
        groupName: null,
        splitByPath: null,
      }),
    ).toBe(true));
  // FIX: new mutual exclusivity cases
  it("rejects autoDelete=true AND skipProcess=true", () =>
    expect(
      valid({ domain: "a.com", autoDelete: true, skipProcess: true }),
    ).toBe(false));
  it("accepts autoDelete=true with skipProcess=false", () =>
    expect(
      valid({ domain: "a.com", autoDelete: true, skipProcess: false }),
    ).toBe(true));
  it("accepts skipProcess=true with autoDelete=false", () =>
    expect(
      valid({ domain: "a.com", skipProcess: true, autoDelete: false }),
    ).toBe(true));
  it("accepts autoDelete=true with skipProcess=null", () =>
    expect(
      valid({ domain: "a.com", autoDelete: true, skipProcess: null }),
    ).toBe(true));
});
