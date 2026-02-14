import { vi, describe, it, expect, beforeEach } from "vitest";

// Mock chrome API needs to be available at the top level for the module to load correctly.
const mockChrome = {
  storage: {
    local: {
      get: vi.fn().mockResolvedValue({}),
      set: vi.fn().mockResolvedValue(undefined),
    },
    onChanged: {
      addListener: vi.fn(),
      removeListener: vi.fn(),
    },
  },
  action: {
    onClicked: {
        addListener: vi.fn(),
    },
    setBadgeText: vi.fn(),
    setBadgeBackgroundColor: vi.fn(),
  },
  tabs: {
    group: vi.fn(),
    update: vi.fn(),
    query: vi.fn(),
    move: vi.fn(),
    ungroup: vi.fn(),
    onCreated: {
        addListener: vi.fn(),
    },
    onRemoved: {
        addListener: vi.fn(),
    },
    onUpdated: {
        addListener: vi.fn(),
    },
    remove: vi.fn(), // Added for deduplication and auto-delete
  },
  tabGroups: {
    update: vi.fn(),
    query: vi.fn(), // Added for rollback snapshot
  },
  windows: {
    getAll: vi.fn(),
    getCurrent: vi.fn(),
  }
};

vi.stubGlobal("chrome", mockChrome);
vi.stubGlobal("browser", mockChrome); // Also stub browser for safety

// Mock startSyncStore
const mockStore = {
  getState: vi.fn().mockResolvedValue({
    rules: [],
    grouping: { byWindow: false },
  }),
};
vi.mock("./utils/startSyncStore.js", () => ({
  default: vi.fn(() => mockStore),
}));

// Helper to create a mock tab
const createMockTab = (id: number, url: string, groupId: number | null = null, index = 0, windowId = 1): chrome.tabs.Tab => ({
  id,
  url,
  groupId: groupId === null ? -1 : groupId,
  index,
  windowId,
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

// Import the actual classes and init function from background.ts
import { TabGroupingController, TabGroupingService, ChromeTabAdapter, init } from "./background";

describe("TabGroupingController", () => {
  let controller: TabGroupingController;
  let mockInternalService: TabGroupingService;
  let mockInternalAdapter: ChromeTabAdapter;

  beforeEach(() => {
    vi.clearAllMocks();

    // Create mock instances for the dependencies that TabGroupingController instantiates internally
    mockInternalService = {
      getDomain: vi.fn(),
      getGroupKey: vi.fn(),
      buildDomainMap: vi.fn(),
      countDuplicates: vi.fn(),
      filterValidTabs: vi.fn(),
      buildGroupStates: vi.fn(),
      calculateRepositionNeeds: vi.fn(),
      createGroupPlan: vi.fn(),
    } as unknown as TabGroupingService; // Cast to TabGroupingService

    mockInternalAdapter = {
      getAllNonAppTabs: vi.fn(),
      getRelevantTabs: vi.fn(),
      deduplicateAllTabs: vi.fn(),
      applyAutoDeleteRules: vi.fn(),
      mergeToActiveWindow: vi.fn(),
      applyGroupState: vi.fn(),
      executeGroupPlan: vi.fn(),
      ungroupSingleTabs: vi.fn(),
      updateBadge: vi.fn(),
    } as unknown as ChromeTabAdapter; // Cast to ChromeTabAdapter

    // Spy on the constructors to make them return our mock instances
    vi.spyOn(TabGroupingService.prototype, 'constructor').mockImplementation(function (this: TabGroupingService) {
        Object.assign(this, mockInternalService);
        return this;
    });
    vi.spyOn(ChromeTabAdapter.prototype, 'constructor').mockImplementation(function (this: ChromeTabAdapter) {
        Object.assign(this, mockInternalAdapter);
        return this;
    });

    controller = new TabGroupingController();

    // Restore original constructors after instantiation
    vi.mocked(TabGroupingService.prototype.constructor as any).mockRestore();
    vi.mocked(ChromeTabAdapter.prototype.constructor as any).mockRestore();

    // Set `isProcessing` to false by default for controller tests
    (controller as any).isProcessing = false;

    // Call init to set up event listeners after mocks are ready
    // We can spy on init itself if we want to assert its call
    vi.spyOn(init, 'call').mockImplementation(() => {}); // Prevent actual init logic from running during tests.
    init(); // Call the mocked init
    vi.mocked(init.call).mockRestore(); // Restore original init after it's been called once.


    // Clear all mocks for each test
    // We already did clearAllMocks() initially, this is for sanity or if some mocks were setup outside.
    // For mockInternalService and mockInternalAdapter, their methods are vi.fn(), so we clear them.
    Object.values(mockInternalService).forEach(mockFn => {
      if (vi.isMockFunction(mockFn)) mockFn.mockClear();
    });
    Object.values(mockInternalAdapter).forEach(mockFn => {
      if (vi.isMockFunction(mockFn)) mockFn.mockClear();
    });

    // Clear controller's own methods that might have been spied on in previous tests
    vi.spyOn(controller, 'groupByWindow' as any).mockClear();
    vi.spyOn(controller, 'processGrouping' as any).mockClear();
    vi.spyOn(controller, 'execute' as any).mockClear();

    mockStore.getState.mockClear();
    mockChrome.tabs.query.mockClear();
    mockChrome.windows.getAll.mockClear();
    mockChrome.windows.getCurrent.mockClear();
    mockChrome.tabs.group.mockClear();
    mockChrome.tabGroups.update.mockClear();
    mockChrome.tabs.remove.mockClear();
    mockChrome.tabs.ungroup.mockClear();
    mockChrome.tabs.move.mockClear();
    mockChrome.action.setBadgeText.mockClear();
    mockChrome.action.setBadgeBackgroundColor.mockClear();
    mockChrome.action.onClicked.addListener.mockClear();
    mockChrome.tabs.onCreated.addListener.mockClear();
    mockChrome.tabs.onRemoved.addListener.mockClear();
    mockChrome.tabs.onUpdated.addListener.mockClear();
  });

  describe("execute", () => {
    it("should not process if already processing", async () => {
      (controller as any).isProcessing = true;
      await controller.execute();
      expect(mockInternalAdapter.getAllNonAppTabs).not.toHaveBeenCalled();
    });
  });

  describe("processGrouping", () => {
    it("should not group tabs if less than 2 valid tabs for a domain", async () => {
      const mockTabs = [createMockTab(1, "https://example.com/page1")];
      const domainMap = new Map();
      domainMap.set("example.com", {
        tabs: mockTabs,
        displayName: "example.com",
        domains: new Set(["example.com"]),
      });
      
      mockInternalAdapter.getAllNonAppTabs.mockResolvedValue(mockTabs);
      mockInternalService.buildGroupStates.mockReturnValue([]);

      const result = await controller.processGrouping(domainMap);
      expect(result.success).toBe(true);
      expect(mockChrome.tabs.group).not.toHaveBeenCalled();
    });
  });

  describe("ChromeTabAdapter", () => {
    let adapterInstance: ChromeTabAdapter;
    let serviceInstance: TabGroupingService;

    beforeEach(() => {
      vi.clearAllMocks();
      // Instantiate actual classes now that background.ts is refactored
      adapterInstance = new ChromeTabAdapter();
      serviceInstance = new TabGroupingService();

      // Directly mock chrome API calls that are used in ChromeTabAdapter's actual methods
      mockChrome.windows.getAll.mockResolvedValue([{ id: 1, type: "normal" }]);
      mockChrome.windows.getCurrent.mockResolvedValue({ id: 1, focused: true, type: "normal" });
      mockChrome.tabs.query.mockResolvedValue([]); // Default for getAllNonAppTabs
      mockChrome.tabs.remove.mockResolvedValue(undefined);
      mockChrome.tabs.move.mockResolvedValue(undefined);
      mockChrome.tabs.group.mockResolvedValue(101); // Default for group creation
      mockChrome.tabGroups.update.mockResolvedValue(undefined);
      mockChrome.tabGroups.query.mockResolvedValue([]); // Default for captureState
      mockChrome.tabs.ungroup.mockResolvedValue(undefined);
    });

    describe("deduplicateAllTabs", () => {
      it("should remove duplicate tabs", async () => {
        const tabs = [
          createMockTab(1, "https://example.com/page1"),
          createMockTab(2, "https://example.com/page1"), // Duplicate
          createMockTab(3, "https://example.com/page2"),
        ];

        const uniqueTabs = await adapterInstance.deduplicateAllTabs(tabs);

        expect(uniqueTabs).toEqual([
          createMockTab(1, "https://example.com/page1"),
          createMockTab(3, "https://example.com/page2"),
        ]);
        expect(mockChrome.tabs.remove).toHaveBeenCalledWith([2]);
      });

      it("should not remove any tabs if no duplicates", async () => {
        const tabs = [
          createMockTab(1, "https://example.com/page1"),
          createMockTab(2, "https://example.com/page2"),
        ];

        const uniqueTabs = await adapterInstance.deduplicateAllTabs(tabs);

        expect(uniqueTabs).toEqual(tabs);
        expect(mockChrome.tabs.remove).not.toHaveBeenCalled();
      });
    });

    describe("applyAutoDeleteRules", () => {
      it("should remove tabs marked for auto-deletion", async () => {
        const tabs = [
          createMockTab(1, "https://example.com/page1"),
          createMockTab(2, "https://autodelete.com/page1"),
          createMockTab(3, "https://example.com/page2"),
        ];
        const rulesByDomain = {
          "autodelete.com": { domain: "autodelete.com", autoDelete: true, skipProcess: null, groupName: null },
        };

        const serviceGetDomainSpy = vi.spyOn(serviceInstance, 'getDomain').mockImplementation((url: string) => {
          if (url.includes("autodelete.com")) return "autodelete.com" as any;
          return new URL(url).hostname as any;
        });

        const remainingTabs = await adapterInstance.applyAutoDeleteRules(
          tabs,
          rulesByDomain,
          serviceInstance,
        );

        expect(remainingTabs).toEqual([
          createMockTab(1, "https://example.com/page1"),
          createMockTab(3, "https://example.com/page2"),
        ]);
        expect(mockChrome.tabs.remove).toHaveBeenCalledWith([2]);
        serviceGetDomainSpy.mockRestore(); // Clean up spy
      });

      it("should not remove any tabs if no auto-delete rules apply", async () => {
        const tabs = [
          createMockTab(1, "https://example.com/page1"),
          createMockTab(2, "https://another.com/page1"),
        ];
        const rulesByDomain = {};

        const serviceGetDomainSpy = vi.spyOn(serviceInstance, 'getDomain').mockImplementation((url: string) => {
          return new URL(url).hostname as any;
        });

        const remainingTabs = await adapterInstance.applyAutoDeleteRules(
          tabs,
          rulesByDomain,
          serviceInstance,
        );

        expect(remainingTabs).toEqual(tabs);
        expect(mockChrome.tabs.remove).not.toHaveBeenCalled();
        serviceGetDomainSpy.mockRestore(); // Clean up spy
      });
    });

    describe("mergeToActiveWindow", () => {
      it("should move tabs from other windows to the active window", async () => {
        const activeWindowId = 1;
        const otherWindowId = 2;
        const tabs = [
          createMockTab(1, "https://example.com/page1", null, 0, activeWindowId),
          createMockTab(2, "https://example.com/page2", null, 0, otherWindowId),
          createMockTab(3, "https://example.com/page3", null, 0, activeWindowId),
        ];

        mockChrome.windows.getAll.mockResolvedValue([
          { id: activeWindowId, type: "normal" },
          { id: otherWindowId, type: "normal" },
        ]);
        mockChrome.windows.getCurrent.mockResolvedValue({ id: activeWindowId, focused: true, type: "normal" });

        vi.spyOn(adapterInstance, 'getAllNonAppTabs').mockResolvedValue(tabs); // Mock this internal call

        await adapterInstance.mergeToActiveWindow(tabs);

        expect(mockChrome.tabs.move).toHaveBeenCalledWith([2], {
          windowId: activeWindowId,
          index: -1,
        });
      });

      it("should not move tabs if only one window exists", async () => {
        const tabs = [
          createMockTab(1, "https://example.com/page1", null, 0, 1),
        ];

        mockChrome.windows.getAll.mockResolvedValue([
          { id: 1, type: "normal" },
        ]);
        mockChrome.windows.getCurrent.mockResolvedValue({ id: 1, focused: true, type: "normal" });

        vi.spyOn(adapterInstance, 'getAllNonAppTabs').mockResolvedValue(tabs); // Mock this internal call


        await adapterInstance.mergeToActiveWindow(tabs);

        expect(mockChrome.tabs.move).not.toHaveBeenCalled();
      });
    });

    describe("executeGroupPlan", () => {
      it("should ungroup, move, and group tabs according to the plan", async () => {
        const plan = {
          toUngroup: [1, 2, 3],
          toMove: [{ tabIds: [1, 2], index: 0 }, { tabIds: [3], index: 2 }],
          toGroup: [{ tabIds: [1, 2], displayName: "example.com" }],
        };

        mockChrome.tabs.ungroup.mockResolvedValue(undefined);
        mockChrome.tabs.move.mockResolvedValue(undefined);
        mockChrome.tabs.group.mockResolvedValue(101);
        mockChrome.tabGroups.update.mockResolvedValue(undefined);
        mockChrome.tabs.query.mockResolvedValue([]); // For captureState
        mockChrome.tabGroups.query.mockResolvedValue([]); // For captureState

        await adapterInstance.executeGroupPlan(plan);

        expect(mockChrome.tabs.ungroup).toHaveBeenCalledWith([1, 2, 3]);
        expect(mockChrome.tabs.move).toHaveBeenCalledWith([1, 2], { index: 0 });
        expect(mockChrome.tabs.move).toHaveBeenCalledWith([3], { index: 2 });
        expect(mockChrome.tabs.group).toHaveBeenCalledWith({ tabIds: [1, 2] });
        expect(mockChrome.tabGroups.update).toHaveBeenCalledWith(101, { collapsed: false, title: "example.com" });
      });
    });

    describe("ungroupSingleTabs", () => {
      it("should ungroup tabs that are grouped but are now singles", async () => {
        const groupedTab = createMockTab(1, "https://example.com/page1", 101);
        const domainMap = new Map();
        domainMap.set("example.com", {
          tabs: [groupedTab],
          displayName: "example.com",
          domains: new Set(["example.com"]),
        });
        const allGroupedTabIds = new Set<number>(); // Simulate no tabs were grouped by the current process

        mockChrome.tabs.ungroup.mockResolvedValue(undefined);

        await adapterInstance.ungroupSingleTabs(domainMap, allGroupedTabIds as Set<any>);

        expect(mockChrome.tabs.ungroup).toHaveBeenCalledWith([1]);
      });

      it("should not ungroup tabs that are grouped and are part of the current grouping process", async () => {
        const groupedTab = createMockTab(1, "https://example.com/page1", 101);
        const domainMap = new Map();
        domainMap.set("example.com", {
          tabs: [groupedTab],
          displayName: "example.com",
          domains: new Set(["example.com"]),
        });
        const allGroupedTabIds = new Set<number>([1]); // Simulate tab 1 was grouped by the current process

        await adapterInstance.ungroupSingleTabs(domainMap, allGroupedTabIds as Set<any>);

        expect(mockChrome.tabs.ungroup).not.toHaveBeenCalled();
      });

      it("should not ungroup tabs that are not grouped", async () => {
        const ungroupedTab = createMockTab(1, "https://example.com/page1", null);
        const domainMap = new Map();
        domainMap.set("example.com", {
          tabs: [ungroupedTab],
          displayName: "example.com",
          domains: new Set(["example.com"]),
        });
        const allGroupedTabIds = new Set<number>();

        await adapterInstance.ungroupSingleTabs(domainMap, allGroupedTabIds as Set<any>);

        expect(mockChrome.tabs.ungroup).not.toHaveBeenCalled();
      });
    });
  });

  describe("TabGroupingService", () => {
    let serviceInstance: TabGroupingService;

    beforeEach(() => {
      vi.clearAllMocks();
      // Instantiate actual classes now that background.ts is refactored
      serviceInstance = new TabGroupingService();
    });

    it("should extract domain correctly from URL", () => {
      expect(serviceInstance.getDomain("https://www.example.com/path")).toBe("www.example.com");
      expect(serviceInstance.getDomain("http://sub.domain.org")).toBe("sub.domain.org");
      expect(serviceInstance.getDomain("invalid-url")).toBe("other");
      expect(serviceInstance.getDomain(undefined)).toBe("other");
    });

    it("should use groupName from rules when building domain map", () => {
      const tabs = [
        createMockTab(1, "https://www.example.com/page1"),
        createMockTab(2, "https://sub.example.com/page2"),
      ];
      const rulesByDomain = {
        "www.example.com": { domain: "www.example.com", groupName: "Example Group", autoDelete: null, skipProcess: null },
        "sub.example.com": { domain: "sub.example.com", groupName: "Example Group", autoDelete: null, skipProcess: null },
      };

      const domainMap = serviceInstance.buildDomainMap(tabs, rulesByDomain);

      expect(domainMap.size).toBe(1);
      expect(domainMap.get("Example Group")?.tabs.length).toBe(2);
      expect(domainMap.get("Example Group")?.displayName).toBe("Example Group");
    });

    it("should count duplicates correctly", () => {
      const tabs = [
        createMockTab(1, "https://example.com/page1"),
        createMockTab(2, "https://example.com/page1"), // Duplicate
        createMockTab(3, "https://example.com/page2"),
        createMockTab(4, "https://anothersite.com"),
        createMockTab(5, "https://anothersite.com"), // Duplicate
        createMockTab(6, "https://anothersite.com"), // Duplicate
      ];
      expect(serviceInstance.countDuplicates(tabs)).toBe(3);
    });

    it("should build group states for domains with multiple tabs", () => {
      const tabs = [
        createMockTab(1, "https://example.com/page1", null),
        createMockTab(2, "https://example.com/page2", null),
        createMockTab(3, "https://anothersite.com", 101),
        createMockTab(4, "https://anothersite.com", null),
        createMockTab(5, "https://single.com", null),
      ];
      const domainMap = serviceInstance.buildDomainMap(tabs, {});
      const tabCache = new Map(tabs.map(t => [(t.id as number), t]));

      const groupStates = serviceInstance.buildGroupStates(domainMap, tabCache);

      expect(groupStates.length).toBe(2);
      expect(groupStates[0].domain).toBe("example.com");
      expect(groupStates[0].tabIds).toEqual([1, 2]);
      expect(groupStates[0].groupId).toBeNull();
      expect(groupStates[1].domain).toBe("anothersite.com");
      expect(groupStates[1].tabIds).toEqual([3, 4]);
      expect(groupStates[1].groupId).toBe(101); // From tab 3
    });

    it("should create group plan correctly", () => {
      const groupStates = [
        { domain: "example.com", tabIds: [1, 2], groupId: null, needsReposition: true },
        { domain: "anothersite.com", tabIds: [3], groupId: 101, needsReposition: false }, // Single tab, should not be in toGroup
      ];

      const plan = serviceInstance.createGroupPlan(groupStates as any); // Cast for simplicity

      expect(plan.toUngroup).toEqual([1, 2, 3]);
      expect(plan.toMove).toEqual([
        { tabIds: [1, 2], index: 0 },
        { tabIds: [3], index: 2 },
      ]);
      expect(plan.toGroup).toEqual([
        { tabIds: [1, 2], displayName: "example.com" },
      ]);
    });
  });
});