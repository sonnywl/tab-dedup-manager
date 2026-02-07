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
  },
  tabGroups: {
    update: vi.fn(),
  },
  windows: {
    getAll: vi.fn(),
    getCurrent: vi.fn(),
  }
};

vi.stubGlobal("chrome", mockChrome);
vi.stubGlobal("browser", mockChrome); // Also stub browser for safety

// Helper to create a mock tab
const createMockTab = (id: number, url: string, groupId: number | null = null, index = 0): chrome.tabs.Tab => ({
  id,
  url,
  groupId: groupId === null ? -1 : groupId,
  index,
  windowId: 1,
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

describe("groupDomainTabs", () => {
  let groupDomainTabs: any;
  let buildDomainToGroupMap: any;

  beforeEach(async () => {
    // Reset mocks before each test
    vi.clearAllMocks();
    
    // Dynamically import the module AFTER mocks are in place
    const backgroundModule = await import("./background");
    groupDomainTabs = backgroundModule.groupDomainTabs;
    buildDomainToGroupMap = backgroundModule.buildDomainToGroupMap;
  });

  it("should not group tabs if only one tab exists for a domain", async () => {
    const tabs = [createMockTab(1, "https://example.com/page1")];
    const domainMap = buildDomainToGroupMap({ "example.com": { tabs } });
    
    await groupDomainTabs(domainMap);

    expect(mockChrome.tabs.group).not.toHaveBeenCalled();
  });

  it("should create a new group for a domain with multiple ungrouped tabs", async () => {
    const tabs = [
      createMockTab(1, "https://example.com/page1", null),
      createMockTab(2, "https://example.com/page2", null),
    ];
    const domainMap = { "example.com": { tabs } };

    // Mock the group creation and subsequent query
    mockChrome.tabs.group.mockResolvedValue(101);
    mockChrome.tabs.query.mockResolvedValue(tabs.map(t => ({...t, groupId: 101, index: t.id-1 })));

    await groupDomainTabs(buildDomainToGroupMap(domainMap));

    // Check that a new group was created
    expect(mockChrome.tabs.group).toHaveBeenCalledWith({ tabIds: [1, 2] });
    
    // Check that the new group was updated
    expect(mockChrome.tabGroups.update).toHaveBeenCalledWith(101, {
      collapsed: false,
      title: "example.com",
    });

    // Check that tabs were moved in a single, sorted batch
    expect(mockChrome.tabs.move).toHaveBeenCalledTimes(1);
    expect(mockChrome.tabs.move).toHaveBeenCalledWith([1, 2], { index: 0 });
  });

  it("should add tabs to an existing group", async () => {
    const tabs = [
      createMockTab(1, "https://example.com/page1", 101),
      createMockTab(2, "https://example.com/page2", null), // This one is new
    ];
    const domainMap = { "example.com": { tabs } };
    
    mockChrome.tabs.query.mockResolvedValue(tabs.map(t => ({...t, groupId: 101, index: t.id-1 })));
    
    await groupDomainTabs(buildDomainToGroupMap(domainMap));

    // Should group the new tab into the existing group
    expect(mockChrome.tabs.group).toHaveBeenCalledWith({ groupId: 101, tabIds: [1, 2] });

    // Should not create a new group
    expect(mockChrome.tabs.group).not.toHaveBeenCalledWith({ tabIds: [1, 2] });

    // Should still update the group title
    expect(mockChrome.tabGroups.update).toHaveBeenCalledWith(101, {
      collapsed: false,
      title: "example.com",
    });
  });

  it("should handle group creation failure by creating a new group", async () => {
    const tabs = [
      createMockTab(1, "https://example.com/page1", 999), // Belongs to a non-existent group
      createMockTab(2, "https://example.com/page2", null),
    ];
    const domainMap = { "example.com": { tabs } };

    // First call to group (to add to group 999) fails
    mockChrome.tabs.group.mockImplementation(async (options) => {
        if (options.groupId === 999) {
            throw new Error("Group not found");
        }
        // Second call (to create a new group) succeeds
        return 102;
    });

    mockChrome.tabs.query.mockResolvedValue(tabs.map(t => ({...t, groupId: 102, index: t.id-1 })));

    await groupDomainTabs(buildDomainToGroupMap(domainMap));

    // First attempt to group into a non-existent group
    expect(mockChrome.tabs.group).toHaveBeenCalledWith({ groupId: 999, tabIds: [1, 2] });
    // Fallback to create a new group
    expect(mockChrome.tabs.group).toHaveBeenCalledWith({ tabIds: [1, 2] });
    expect(mockChrome.tabGroups.update).toHaveBeenCalledWith(102, {
      collapsed: false,
      title: "example.com",
    });
  });

  it("should ungroup tabs from an incorrect group and move them to the correct one", async () => {
      const tabs = [
          createMockTab(1, "https://example.com/page1", 101), // Correct group
          createMockTab(2, "https://example.com/page2", 202), // Incorrect group
      ];
      const domainMap = { "example.com": { tabs } };
      
      mockChrome.tabs.query.mockResolvedValue(tabs.map(t => ({...t, groupId: 101, index: t.id-1 })));
      
      await groupDomainTabs(buildDomainToGroupMap(domainMap));

      // Ungroup the incorrectly grouped tab
      expect(mockChrome.tabs.ungroup).toHaveBeenCalledWith([2]);

      // Group both tabs into the correct group
      expect(mockChrome.tabs.group).toHaveBeenCalledWith({ groupId: 101, tabIds: [1, 2] });
  });

});
