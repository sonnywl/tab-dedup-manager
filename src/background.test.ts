import {
  ChromeTabAdapter,
  TabGroupingController,
  TabGroupingService,
  WindowManagementService,
} from "./background";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ============================================================================
// SHARED MOCKS
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
  windows: { getAll: vi.fn(), getCurrent: vi.fn() },
};

vi.stubGlobal("chrome", mockChrome);

const mockStore = {
  getState: vi.fn().mockResolvedValue({
    rules: [],
    grouping: { byWindow: false },
  }),
};
vi.mock("./utils/startSyncStore.js", () => ({ default: () => mockStore }));

// ============================================================================
// HELPERS
// ============================================================================

const createMockTab = (
  id: number,
  url: string,
  groupId: number | null = null,
  index = 0,
  windowId = 1,
): chrome.tabs.Tab => {
  const fullUrl = url.startsWith("http") ? url : `https://${url}`;
  return {
    id,
    url: fullUrl,
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
// TESTS
// ============================================================================

describe("TabGrouping Application Layer", () => {
  let controller: TabGroupingController;
  let mockService: Record<keyof TabGroupingService, any>;
  let mockAdapter: Record<keyof ChromeTabAdapter, any>;

  beforeEach(() => {
    vi.clearAllMocks();
    (TabGroupingController as any).isProcessing = false;

    // Setup internal mocks
    mockService = {
      getDomain: vi.fn((url) => {
        try {
          return new URL(url).hostname;
        } catch {
          return "other";
        }
      }),
      getGroupKey: vi.fn(),
      buildDomainMap: vi.fn(),
      countDuplicates: vi.fn(),
      filterValidTabs: vi.fn(),
      buildGroupStates: vi.fn(),
      calculateRepositionNeeds: vi.fn(),
      createGroupPlan: vi.fn(),
    };
    mockAdapter = {
      getNormalTabs: vi.fn(),
      getRelevantTabs: vi.fn(),
      deduplicateAllTabs: vi.fn(),
      applyAutoDeleteRules: vi.fn(),
      mergeToActiveWindow: vi.fn(),
      applyGroupState: vi.fn(),
      executeGroupPlan: vi.fn(),
      ungroupSingleTabs: vi.fn(),
      moveTabsToWindow: vi.fn(),
      getGroupsInWindow: vi.fn().mockResolvedValue([]),
      updateBadge: vi.fn(),
    };

    vi.spyOn(TabGroupingService.prototype, "constructor").mockImplementation(
      function (this: TabGroupingService) {
        Object.assign(this, mockService);
        return this;
      },
    );
    vi.spyOn(ChromeTabAdapter.prototype, "constructor").mockImplementation(
      function (this: ChromeTabAdapter) {
        Object.assign(this, mockAdapter);
        // Important: ensure internal references also point to our mocks
        return this;
      },
    );

    controller = new TabGroupingController();
    // Manual override to be absolutely sure
    (controller as any).adapter = mockAdapter;
    (controller as any).service = mockService;

    vi.restoreAllMocks(); // Restore constructors, keep mocks
  });

  describe("execute()", () => {
    it("should prevent concurrent processing", async () => {
      (TabGroupingController as any).isProcessing = true;
      await controller.execute();
      expect(mockAdapter.getNormalTabs).not.toHaveBeenCalled();
    });

    it("should process only top windows and merge others when numWindowsToKeep is set", async () => {
      mockStore.getState.mockResolvedValue({
        rules: [],
        grouping: { byWindow: true, numWindowsToKeep: 1 },
      });

      const tabs = [
        createMockTab(1, "a.com", null, 0, 1),
        createMockTab(2, "a.com", null, 1, 1),
        createMockTab(3, "b.com", null, 0, 2),
      ];

      mockAdapter.getNormalTabs.mockResolvedValue(tabs);
      mockAdapter.getRelevantTabs.mockResolvedValue(tabs);
      mockAdapter.deduplicateAllTabs.mockResolvedValue(tabs);
      mockAdapter.applyAutoDeleteRules.mockResolvedValue(tabs);

      mockService.buildDomainMap.mockReturnValue(new Map());

      const processSpy = vi
        .spyOn(controller, "processGrouping")
        .mockResolvedValue({ success: true, value: undefined });

      // We need to NOT mock groupByWindow to allow actual logic to find 2 windows
      // OR mock it to return 2 windows.
      // The current controller uses 'this.groupByWindow' so we can spy on it.
      const groupBySpy = vi
        .spyOn(controller, "groupByWindow")
        .mockResolvedValue(
          new Map([
            [1 as any, [tabs[0], tabs[1]]],
            [2 as any, [tabs[2]]],
          ]),
        );

      await controller.execute();

      expect(processSpy).toHaveBeenCalledTimes(1);
      expect(mockAdapter.moveTabsToWindow).toHaveBeenCalled();
    });
  });
});

describe("ChromeTabAdapter Infrastructure Layer", () => {
  let adapter: ChromeTabAdapter;

  beforeEach(() => {
    vi.clearAllMocks();
    adapter = new ChromeTabAdapter();
    mockChrome.windows.getAll.mockResolvedValue([{ id: 1, type: "normal" }]);
    mockChrome.windows.getCurrent.mockResolvedValue({ id: 1, type: "normal" });
  });

  it("should query only normal windows in getNormalTabs", async () => {
    mockChrome.tabs.query.mockResolvedValue([]);
    await adapter.getNormalTabs();
    expect(mockChrome.tabs.query).toHaveBeenCalledWith({
      windowType: "normal",
    });
  });

  it("should merge tabs only to normal windows", async () => {
    const tabs = [createMockTab(1, "a.com", null, 0, 2)];
    mockChrome.windows.getAll.mockResolvedValue([
      { id: 1, type: "normal" },
      { id: 2, type: "normal" },
    ]);

    await adapter.mergeToActiveWindow(tabs);
    expect(mockChrome.tabs.move).toHaveBeenCalledWith(
      [1],
      expect.objectContaining({ windowId: 1 }),
    );
  });

  it("should deduplicate tabs based on URL", async () => {
    const tabs = [createMockTab(1, "u1"), createMockTab(2, "u1")];
    const unique = await adapter.deduplicateAllTabs(tabs);
    expect(unique.length).toBe(1);
    expect(mockChrome.tabs.remove).toHaveBeenCalledWith([2]);
  });
});

describe("TabGroupingService Domain Layer", () => {
  let service: TabGroupingService;

  beforeEach(() => {
    service = new TabGroupingService();
  });

  it("should correctly identify domains", () => {
    expect(service.getDomain("https://google.com/search")).toBe("google.com");
    expect(service.getDomain("invalid")).toBe("other");
  });

  it("should sort groups alphabetically by URL", () => {
    const groupStates: any[] = [
      { domain: "z.com", tabIds: [1], needsReposition: false },
      { domain: "a.com", tabIds: [2], needsReposition: false },
    ];
    const cache = new Map<number, chrome.tabs.Tab>([
      [1, createMockTab(1, "z.com")],
      [2, createMockTab(2, "a.com")],
    ]);

    const result = service.calculateRepositionNeeds(
      groupStates as any,
      cache as any,
    );
    expect(result[0].domain).toBe("a.com");
    expect(result[1].domain).toBe("z.com");
  });
});

describe("WindowManagementService Domain Layer", () => {
  let windowService: WindowManagementService;
  let groupingService: TabGroupingService;

  beforeEach(() => {
    windowService = new WindowManagementService();
    groupingService = new TabGroupingService();
  });

  it("should merge tabs to the window with the most matching domains", () => {
    const retainedWindows = new Map<number, chrome.tabs.Tab[]>([
      [
        1,
        [
          createMockTab(1, "https://google.com"),
          createMockTab(2, "https://google.com"),
        ],
      ],
      [2, [createMockTab(3, "https://yahoo.com")]],
    ]);
    const excessTabs = [
      createMockTab(4, "https://google.com"),
      createMockTab(5, "https://yahoo.com"),
      createMockTab(6, "https://bing.com"), // No match, should go to largest (Window 1)
    ];

    const plan = windowService.calculateMergePlan(
      retainedWindows as any,
      excessTabs,
      groupingService,
    );

    expect(plan.get(1)).toContain(4); // google.com match
    expect(plan.get(2)).toContain(5); // yahoo.com match
    expect(plan.get(1)).toContain(6); // default to largest
  });
});
