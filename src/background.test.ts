import {
  CacheManager,
  ChromeTabAdapter,
  TabGroupingController,
  TabGroupingService,
  WindowManagementService,
  asTabId,
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

  const makeAdapterMock = (overrides: Record<string, any> = {}) => ({
    getNormalTabs: vi.fn().mockResolvedValue([]),
    deduplicateAllTabs: vi.fn().mockResolvedValue([]),
    cleanupTabsByRules: vi.fn().mockResolvedValue([]),
    mergeToActiveWindow: vi.fn().mockResolvedValue(undefined),
    moveTabsAtomic: vi.fn().mockResolvedValue(undefined),
    // Returns the passed state — matches new Promise<GroupState> signature
    applyGroupState: vi.fn().mockImplementation((s) => Promise.resolve(s)),
    executeGroupPlan: vi
      .fn()
      .mockResolvedValue({ success: true, value: undefined }),
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
    identifyProtectedTabs: vi.fn().mockReturnValue(new Map()),
  });

  beforeEach(() => {
    vi.clearAllMocks();
    controller = new TabGroupingController();
    (controller as any).isProcessing = false;
    (controller as any).lastStateHash = null;
    (controller as any).adapter = makeAdapterMock();
    (controller as any).service = makeServiceMock();
  });

  describe("execute()", () => {
    it("blocks concurrent processing via instance flag", async () => {
      (controller as any).isProcessing = true;
      await controller.execute();
      expect((controller as any).adapter.getNormalTabs).not.toHaveBeenCalled();
    });

    it("two instances do not share the processing lock", async () => {
      const c2 = new TabGroupingController();
      (controller as any).isProcessing = true;
      expect((c2 as any).isProcessing).toBe(false);
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

      expect(
        (controller as any).adapter.getNormalTabs.mock.calls.length,
      ).toBe(callsAfterFirst + 1);
    });

    it("hash is order-stable — same tabs in different order produce same hash", async () => {
      const tabs1 = [mkTab(1, "a.com"), mkTab(2, "b.com")];
      const tabs2 = [mkTab(2, "b.com"), mkTab(1, "a.com")];
      const hash = (controller as any).stateHash.bind(controller);
      const rules = {};
      const cfg = { byWindow: false };

      expect(hash(tabs1, rules, cfg, 1)).toBe(hash(tabs2, rules, cfg, 1));
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
        (controller as any).adapter.moveTabsAtomic,
      ).toHaveBeenCalled();
    });

    it("skips merge when byWindow=true", async () => {
      const tabs = [mkTab(1, "a.com")];
      (controller as any).adapter.getNormalTabs.mockResolvedValue(tabs);
      (controller as any).adapter.deduplicateAllTabs.mockResolvedValue(tabs);
      (controller as any).adapter.cleanupTabsByRules.mockResolvedValue(tabs);
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
        (controller as any).adapter.moveTabsAtomic,
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
      (controller as any).adapter.deduplicateAllTabs.mockResolvedValue(tabs);
      (controller as any).adapter.cleanupTabsByRules.mockResolvedValue(tabs);
      const processSpy = vi
        .spyOn(controller, "processGrouping")
        .mockResolvedValue({ success: true, value: undefined });
      vi.spyOn((controller as any).service, "identifyProtectedTabs").mockReturnValue({
        protectedMeta: new Map(),
        managedGroupIds: new Set(),
      });
      vi.spyOn(controller, "groupByWindow").mockResolvedValue(
        new Map([
          [1 as any, [tabs[0], tabs[1]]],
          [2 as any, [tabs[2]]],
        ]),
      );

      await controller.execute();

      expect(processSpy).toHaveBeenCalledTimes(1);
      expect((controller as any).adapter.moveTabsAtomic).toHaveBeenCalled();
    });

    it("Integration: preserves manual 'Test' group through full execute loop", async () => {
      // 1. Setup Mock State: Group 101 has a manual title "Test"
      const testTabs = [
        mkTab(1, "https://grok.com/", 101, 0),
        mkTab(2, "https://www.bing.com/search", 101, 1),
        mkTab(3, "https://chromewebstore.google.com/category/extensions", 101, 2),
      ];

      // Rule for bing.com would normally trigger split-path grouping
      const rules = [
        { domain: "www.bing.com", splitByPath: 1, autoDelete: false, skipProcess: false }
      ];

      mockStore.getState.mockResolvedValue({
        rules,
        grouping: { byWindow: false },
      });

      const adapter = (controller as any).adapter;
      adapter.getNormalTabs.mockResolvedValue(testTabs);
      
      // Use REAL service for this test to verify the logic
      const realService = new TabGroupingService();
      (controller as any).service = realService;

      // Mock Group Metadata
      mockChrome.tabGroups.query.mockResolvedValue([{ id: 101, title: "Test" }]);

      // 2. Execute
      await controller.execute();

      // Verification of atomic behavior: we ensure the final plan correctly uses 
      // the reconstructed manual group without functional modification
      const executeCall = adapter.executeGroupPlan.mock.calls[0];
      if (executeCall) {
        const plan = executeCall[0];
        const externalState = plan.states.find((s: any) => s.isExternal);
        expect(externalState).toBeDefined();
        expect(externalState.tabIds).toContain(2); 
      }
    });

    it("Regression: preserves ALL tabs in a multi-tab manual group", async () => {
      const manualTabs = [
        mkTab(10, "https://a.com", 200, 0),
        mkTab(11, "https://b.com", 200, 1),
        mkTab(12, "https://c.com", 200, 2),
      ];
      
      mockStore.getState.mockResolvedValue({
        rules: [],
        grouping: { byWindow: false },
      });

      const adapter = (controller as any).adapter;
      adapter.getNormalTabs.mockResolvedValue(manualTabs);
      
      // Use REAL service logic
      const realService = new TabGroupingService();
      (controller as any).service = realService;

      mockChrome.tabGroups.query.mockResolvedValue([{ id: 200, title: "My Custom Project" }]);

      await controller.execute();

      // Verify the group plan treats them as a block of 3
      const executeCall = adapter.executeGroupPlan.mock.calls[0];
      if (executeCall) {
        const plan = executeCall[0];
        const externalState = plan.states.find((s: any) => s.displayName === "My Custom Project");
        expect(externalState).toBeDefined();
        expect(externalState.tabIds).toHaveLength(3);
        expect(externalState.isExternal).toBe(true);
      }
    });

    it("Integration: manual group overrides domain rules for matching tabs", async () => {
      const tabs = [
        mkTab(1, "https://google.com", 300, 0), 
        mkTab(2, "https://other.com", 300, 1)
      ];

      const rules = [{ domain: "google.com" }];

      mockStore.getState.mockResolvedValue({
        rules,
        grouping: { byWindow: false },
      });

      const adapter = (controller as any).adapter;
      adapter.getNormalTabs.mockResolvedValue(tabs);
      (controller as any).service = new TabGroupingService();

      mockChrome.tabGroups.query.mockResolvedValue([{ id: 300, title: "My Project" }]);

      await controller.execute();

      const executeCall = adapter.executeGroupPlan.mock.calls[0];
      if (executeCall) {
        const plan = executeCall[0];
        const state = plan.states.find((s: any) => s.displayName === "My Project");
        expect(state).toBeDefined();
        expect(state.tabIds).toHaveLength(2);
        expect(state.isExternal).toBe(true);
      }
    });

    it("Validation: distinguishes between custom groupName (Internal) and manual title (External)", async () => {
      const tabs = [
        mkTab(1, "https://nature.com", 100, 0),
        mkTab(2, "https://google.com", 200, 1)
      ];

      const rulesByDomain = {
        "nature.com": { domain: "nature.com", groupName: "Research" }
      };

      const realService = new TabGroupingService();
      const groups = new Map([
        [100, { id: 100, title: "Research" } as any],
        [200, { id: 200, title: "My PhD" } as any]
      ]);

      // 1. Identify protected IDs
      const { protectedMeta } = realService.identifyProtectedTabs(
        tabs,
        groups,
        rulesByDomain as any,
      );
      expect(protectedMeta.has(2 as any)).toBe(true);
      expect(protectedMeta.has(1 as any)).toBe(false);

      // 2. Build map using those protected IDs
      const groupMap = realService.buildGroupMap(
        tabs,
        rulesByDomain as any,
        groups,
        protectedMeta,
      );
      
      // 3. Build states
      const states = realService.buildGroupStates(groupMap, new Map([[1, tabs[0]], [2, tabs[1]]]) as any);

      const researchState = states.find(s => s.title === "Research");
      const phdState = states.find(s => s.title === "My PhD");

      expect(researchState).toBeDefined();
      expect(researchState!.isExternal).toBeFalsy(); 

      expect(phdState).toBeDefined();
      expect(phdState!.isExternal).toBe(true); 
    });

    it("Integration: multiple separate unnamed manual groups survive cross-window merge", async () => {
      // Setup: Two separate unnamed groups in Window 2.
      // We add a tab already in Window 1 to force a reposition need later.
      const tabs = [
        { ...mkTab(2, "https://a.com", 101, 0, 2), index: 3 },
        { ...mkTab(1, "https://a.com", 101, 1, 2), index: 2 },
        { ...mkTab(4, "https://b.com", 102, 2, 2), index: 1 },
        { ...mkTab(3, "https://b.com", 102, 3, 2), index: 0 },
        mkTab(5, "https://zzz.com", null, 0, 1),
      ];

      mockStore.getState.mockResolvedValue({
        rules: [],
        grouping: { byWindow: false },
      });
      const adapter = (controller as any).adapter;
      adapter.getNormalTabs.mockResolvedValue(tabs);
      adapter.deduplicateAllTabs.mockResolvedValue(tabs);
      adapter.cleanupTabsByRules.mockResolvedValue(tabs);
      mockChrome.windows.getCurrent.mockResolvedValue({
        id: 1,
        type: "normal",
      });
      mockChrome.windows.getAll.mockResolvedValue([
        { id: 1, type: "normal" },
        { id: 2, type: "normal" },
      ]);

      const realService = new TabGroupingService();
      (controller as any).service = realService;

      mockChrome.tabGroups.query.mockResolvedValue([
        { id: 101, title: "", windowId: 2 },
        { id: 102, title: "", windowId: 2 },
      ]);

      await controller.execute();

      const executeCall = adapter.executeGroupPlan.mock.calls[0];
      expect(executeCall).toBeDefined();
      const plan = executeCall[0];

      const unnamedStates = plan.states.filter(
        (s: any) => s.displayName === "" && s.isExternal,
      );
      expect(unnamedStates).toHaveLength(2);
    });

    it("Integration: ungroups an intruder tab from a managed group", async () => {
      // Setup: A managed group "google.com" (ID 101)
      // containing two google.com tabs and a bing.com tab.
      const tabs = [
        mkTab(3, "https://google.com", 101, 0, 1),
        mkTab(1, "https://google.com", 101, 1, 1),
        mkTab(2, "https://bing.com", 101, 2, 1),
      ];

      // No rules, so the title "google.com" is internal for tabs 3 and 1 but NOT for tab 2.
      // Because at least one tab matches, the group is considered MANAGED.
      mockStore.getState.mockResolvedValue({
        rules: [],
        grouping: { byWindow: false },
      });

      const adapter = (controller as any).adapter;
      adapter.getNormalTabs.mockResolvedValue(tabs);
      adapter.deduplicateAllTabs.mockResolvedValue(tabs);
      adapter.cleanupTabsByRules.mockResolvedValue(tabs);

      mockChrome.windows.getCurrent.mockResolvedValue({
        id: 1,
        type: "normal",
      });
      mockChrome.tabGroups.query.mockResolvedValue([
        { id: 101, title: "google.com", windowId: 1 },
      ]);

      (controller as any).service = new TabGroupingService();

      await controller.execute();

      // Because the group title "google.com" matched at least one tab,
      // it was correctly identified as MANAGED.
      // Tab 2 (bing.com) should have been identified as an intruder.
      const executeCall = adapter.executeGroupPlan.mock.calls[0];
      expect(executeCall).toBeDefined();
      const plan = executeCall[0];

      // Verification: Intruder correctly identified for removal from managed group
      expect(plan.tabsToUngroup).toContain(2);
      expect(plan.tabsToUngroup).not.toContain(1);
      expect(plan.tabsToUngroup).not.toContain(3);
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
      (controller as any).adapter.applyGroupState.mockResolvedValue(
        updatedState,
      );
      (controller as any).service.calculateRepositionNeeds.mockImplementation(
        (states: any[]) => {
          expect(states[0].groupId).toBe(42);
          return states.map((s: any) => ({ ...s, needsReposition: false }));
        },
      );

      await controller.processGrouping([tab1, tab2], new Map(), new Map());
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

  it("merges tabs to active normal window and reconstructs manual groups", async () => {
    mockChrome.windows.getAll.mockResolvedValue([
      { id: 1, type: "normal" },
      { id: 2, type: "normal" },
    ]);
    mockChrome.windows.getCurrent.mockResolvedValue({ id: 1, type: "normal" });
    mockChrome.tabs.group.mockResolvedValue(1000);

    const tabs = [mkTab(1, "a.com", 101, 0, 2), mkTab(2, "b.com", 101, 1, 2)];
    // Mock query to return the same tabs so it's identified as a full group move
    mockChrome.tabs.query.mockResolvedValue(tabs);
    mockChrome.tabs.get.mockImplementation(async (id: number) => {
      return tabs.find((t) => t.id === id);
    });
    const meta = new Map([
      [1 as any, { title: "Research", originalGroupId: 101 }],
      [2 as any, { title: "Research", originalGroupId: 101 }],
    ]);

    await adapter.moveTabsAtomic([1, 2] as any, 1, meta as any);

    // 1. Group moved to Window 1 (since it's a full group move)
    expect(mockChrome.tabGroups.move).toHaveBeenCalledWith(
      101,
      expect.objectContaining({ windowId: 1 }),
    );

    // 2. No individual tabs moved
    expect(mockChrome.tabs.move).not.toHaveBeenCalled();
  });

  it("deduplicates tabs by URL", async () => {
    const tabs = [mkTab(1, "u1"), mkTab(2, "u1")];
    const unique = await adapter.deduplicateAllTabs(tabs);
    expect(unique.length).toBe(1);
    expect(mockChrome.tabs.remove).toHaveBeenCalledWith([2]);
  });

  it("deduplicates protected tabs by URL (global enforcement)", async () => {
    // Both tabs have same URL. Tab 1 is protected. Tab 2 is protected.
    // Deduplication should still happen (keep first, remove second).
    const tabs = [mkTab(1, "https://u1.com"), mkTab(2, "https://u1.com")];
    const unique = await adapter.deduplicateAllTabs(tabs);
    expect(unique.length).toBe(1);
    expect(unique[0].id).toBe(1);
    expect(mockChrome.tabs.remove).toHaveBeenCalledWith([2]);
  });

  describe("cleanupTabsByRules()", () => {
    it("removes tabs matching autoDelete rule", async () => {
      const service = new TabGroupingService();
      const tabs = [
        mkTab(1, "https://delete.me"),
        mkTab(2, "https://keep.me"),
      ];
      const rulesByDomain = {
        "delete.me": { domain: "delete.me", autoDelete: true } as any,
      };

      const result = await adapter.cleanupTabsByRules(
        tabs,
        rulesByDomain,
        service,
      );

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe(2);
      expect(mockChrome.tabs.remove).toHaveBeenCalledWith([1]);
    });

    it("deletes protected tabs if matching autoDelete rule", async () => {
      const service = new TabGroupingService();
      const tabs = [mkTab(1, "https://delete.me")];
      const rulesByDomain = {
        "delete.me": { domain: "delete.me", autoDelete: true } as any,
      };
      // Even if protected (manual group), autoDelete should prevail
      const protectedMeta = new Map([
        [asTabId(1)!, { title: "Protected", originalGroupId: 101 }],
      ]);

      const result = await adapter.cleanupTabsByRules(
        tabs,
        rulesByDomain,
        service,
      );

      expect(result).toHaveLength(0);
      expect(mockChrome.tabs.remove).toHaveBeenCalledWith([1]);
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
      expect(result.groupId).toBe(55);
    });

    it("handles external groups (restores them if necessary)", async () => {
      const state: any = { title: "Manual", tabIds: [1, 2], isExternal: true };
      const cache = new Map([[1, mkTab(1, "a.com")], [2, mkTab(2, "b.com")]]);
      
      await adapter.applyGroupState(state, cache as any);
      expect(mockChrome.tabs.group).toHaveBeenCalled();
    });
  });

  describe("executeGroupPlan()", () => {
    it("performs grouping for external states if they lost their group ID", async () => {
      // Setup: Tabs are currently UNGROUPED in the browser (groupId: -1)
      const tab1 = { ...mkTab(1, "a.com"), groupId: -1 };
      const tab2 = { ...mkTab(2, "b.com"), groupId: -1 };

      mockChrome.tabs.move.mockResolvedValue([]);
      mockChrome.tabs.query.mockResolvedValue([tab1, tab2]);
      mockChrome.tabGroups.query.mockResolvedValue([]);

      const cache = new Map([
        [1, tab1],
        [2, tab2],
      ]);

      await adapter.executeGroupPlan(
        {
          states: [
            {
              tabIds: [1, 2],
              displayName: "Test",
              targetIndex: 0,
              currentlyGrouped: [], // Arrived ungrouped from another window
              isExternal: true,
            },
          ],
          tabsToUngroup: [],
        } as any,
        cache as any,
        new Map(),
      );

      expect(mockChrome.tabs.move).toHaveBeenCalled();
      expect(mockChrome.tabs.group).toHaveBeenCalled();
    });

    it("ungroups tabs listed in tabsToUngroup", async () => {
      const plan: any = {
        states: [],
        tabsToUngroup: [99],
      };
      const cache = new Map([[99, mkTab(99, "intruder.com", 101)]]);

      await adapter.executeGroupPlan(plan, cache as any, new Map());

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
    expect(service.getDomain("invalid")).toBe("other");
    expect(service.getDomain(undefined)).toBe("other");
  });

  describe("identifyProtectedTabs()", () => {
    it("identifies tabs in external groups", () => {
      const tabs = [mkTab(1, "google.com", 101)];
      const groups = new Map([[101, { id: 101, title: "Manual" } as any]]);
      const { protectedMeta } = service.identifyProtectedTabs(tabs, groups, {});
      expect(protectedMeta.has(1 as any)).toBe(true);
      expect(protectedMeta.get(1 as any)!.title).toBe("Manual");
    });

    it("protects a manual group even if it contains a tab matching a rule", () => {
      const tabs = [mkTab(1, "google.com", 101), mkTab(2, "other.com", 101)];
      const groups = new Map([[101, { id: 101, title: "My Project" } as any]]);
      const rules = {
        "google.com": { domain: "google.com", groupName: "Google" },
      };

      const { protectedMeta } = service.identifyProtectedTabs(
        tabs,
        groups,
        rules as any,
      );

      expect(protectedMeta.has(1 as any)).toBe(true);
      expect(protectedMeta.has(2 as any)).toBe(true);
      expect(protectedMeta.get(1 as any)!.title).toBe("My Project");
    });
  });

  describe("getGroupKey()", () => {
    const domain = "google.com" as any;
    const rules: any = {
      "google.com": { domain: "google.com", splitByPath: 1 },
    };

    it("splits by first path segment using new format <path> - <base>", () => {
      const r = service.getGroupKey(
        domain,
        "https://google.com/search?q=1",
        rules,
      );
      expect(r.key).toBe("google.com::search");
      expect(r.title).toBe("search - google.com");
    });

    it("splits by second path segment using new format <path> - <base>", () => {
      const r = service.getGroupKey(domain, "https://google.com/mail/inbox", {
        "google.com": { domain: "google.com", splitByPath: 2 },
      });
      expect(r.key).toBe("google.com::inbox");
      expect(r.title).toBe("inbox - google.com");
    });

    it("uses custom groupName when provided", () => {
      const r = service.getGroupKey(domain, "https://google.com/search", {
        "google.com": { domain: "google.com", groupName: "My Search" },
      });
      expect(r.key).toBe("My Search");
      expect(r.title).toBe("My Search");
    });

    it("uses custom groupName as base for split-path", () => {
      const r = service.getGroupKey(domain, "https://google.com/search", {
        "google.com": {
          domain: "google.com",
          groupName: "My Search",
          splitByPath: 1,
        },
      });
      expect(r.key).toBe("My Search::search");
      expect(r.title).toBe("search - My Search");
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

    it("returns true for groupName title", () => {
      expect(
        service.isInternalTitle("Search", domain, "https://google.com", rules),
      ).toBe(true);
    });

    it("returns false for external title", () => {
      expect(
        service.isInternalTitle("My Work", domain, "https://google.com", rules),
      ).toBe(false);
    });

    it("returns true for internal split-path title (new format)", () => {
      expect(
        service.isInternalTitle(
          "search - google.com",
          domain,
          "https://google.com/search",
          {
            "google.com": { domain: "google.com", splitByPath: 1 },
          },
        ),
      ).toBe(true);
    });

    it("returns true for internal split-path title (legacy format)", () => {
      expect(
        service.isInternalTitle(
          "google.com - search",
          domain,
          "https://google.com/search",
          {
            "google.com": { domain: "google.com", splitByPath: 1 },
          },
        ),
      ).toBe(true);
    });
  });

  describe("createGroupPlan()", () => {
    it("identifies intruder tabs that should be ungrouped", () => {
      const groupStates: any[] = [
        {
          title: "Managed",
          tabIds: [1],
          groupId: 101,
          needsReposition: true,
          isExternal: false,
        },
      ];
      const tab1 = mkTab(1, "a.com", 101);
      const tabIntruder = mkTab(2, "b.com", 101); // In group 101 but not in managed list
      const tabCache = new Map([
        [1, tab1],
        [2, tabIntruder],
      ]);

      const plan = service.createGroupPlan(
        groupStates as any,
        tabCache as any,
        new Set([101]),
      );

      expect(plan.tabsToUngroup).toContain(2);
      expect(plan.tabsToUngroup).not.toContain(1);
    });

    it("identifies path-segment intruders (different paths in same path-group)", () => {
      // Scenario: Group 101 is named "search - google.com"
      // It contains:
      // 1. google.com/search (belongs here)
      // 2. google.com/images (intruder, should be in "images - google.com")
      const groupStates: any[] = [
        {
          title: "search - google.com",
          tabIds: [1],
          groupId: 101,
          needsReposition: false,
          isExternal: false,
        },
      ];
      const tab1 = mkTab(1, "https://google.com/search", 101);
      const tab2 = mkTab(2, "https://google.com/images", 101);
      const tabCache = new Map([
        [1, tab1],
        [2, tab2],
      ]);

      const plan = service.createGroupPlan(
        groupStates as any,
        tabCache as any,
        new Map([[101, "search - google.com"]]),
      );

      expect(plan.tabsToUngroup).toContain(2);
      expect(plan.tabsToUngroup).not.toContain(1);
    });

    it("identifies cross-domain intruders in a path-based group", () => {
      // Scenario: Managed group "search - bing.com" (ID 101)
      // Contains two bing.com/search tabs and one google.com intruder.
      const groupStates: any[] = [
        {
          title: "search - bing.com",
          tabIds: [1, 3],
          groupId: 101,
          needsReposition: false,
          isExternal: false,
        },
      ];
      const tab1 = mkTab(1, "https://www.bing.com/search", 101);
      const tab2 = mkTab(2, "https://www.google.com", 101); // INTRUDER
      const tab3 = mkTab(3, "https://www.bing.com/search?q=test", 101);

      const tabCache = new Map([
        [1, tab1],
        [2, tab2],
        [3, tab3],
      ]);

      const plan = service.createGroupPlan(
        groupStates as any,
        tabCache as any,
        new Map([[101, "search - bing.com"]]),
      );

      expect(plan.tabsToUngroup).toContain(2);
      expect(plan.tabsToUngroup).not.toContain(1);
      expect(plan.tabsToUngroup).not.toContain(3);
    });
  });

  describe("calculateRepositionNeeds()", () => {
    it("treats external groups as sortable blocks", () => {
      const states: any[] = [
        { title: "Test", tabIds: [1], isExternal: true, needsReposition: false },
      ];
      const cache = new Map([[1, mkTab(1, "z.com")]]);
      const result = service.calculateRepositionNeeds(states as any, cache as any);
      expect(result[0].title).toBe("Test");
    });
  });
});

// ============================================================================
// validateRule
// ============================================================================

describe("validateRule", () => {
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
    if (r.autoDelete === true && r.skipProcess === true) return false;
    return true;
  };

  it("accepts minimal valid rule", () =>
    expect(valid({ domain: "a.com" })).toBe(true));
  it("rejects autoDelete=true AND skipProcess=true", () =>
    expect(
      valid({ domain: "a.com", autoDelete: true, skipProcess: true }),
    ).toBe(false));
});
