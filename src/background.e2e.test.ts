import {
  ChromeTabAdapter,
  TabGroupingController,
  TabGroupingService,
  WindowManagementService,
} from "./background";
import { beforeEach, describe, expect, it, vi } from "vitest";

import fc from "fast-check";

// ============================================================================
// MOCKS & SETUP - MUST BE AT TOP
// ============================================================================

const mockChrome = {
  runtime: {
    getURL: vi.fn().mockReturnValue("chrome-extension://self-id/"),
  },
  storage: {
    local: { get: vi.fn(), set: vi.fn() },
    onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
  },
  tabs: {
    group: vi.fn().mockResolvedValue(1000),
    ungroup: vi.fn(),
    move: vi.fn(),
    query: vi.fn(),
    remove: vi.fn(),
  },
  tabGroups: { update: vi.fn(), query: vi.fn() },
  windows: { getAll: vi.fn(), getCurrent: vi.fn() },
};

vi.stubGlobal("chrome", mockChrome);
vi.stubGlobal("browser", mockChrome);

// Mock the sync store utility
vi.mock("./utils/startSyncStore.js", () => ({
  default: vi.fn().mockResolvedValue({
    getState: vi
      .fn()
      .mockImplementation(() => mockChrome.storage.local.get("rules")),
  }),
}));

// Helper to make a tab
const mkTab = (
  id: number,
  url: string,
  groupId = -1,
  index = 0,
  windowId = 1,
): any => ({
  id,
  url,
  groupId,
  index,
  windowId,
});

// ============================================================================
// ARBITRARIES (Generators)
// ============================================================================

const domains = [
  "google.com",
  "bing.com",
  "nature.com",
  "github.com",
  "stackoverflow.com",
];
const paths = ["search", "images", "articles", "repo", "wiki", "questions"];
const customGroupNames = ["My Project", "Work", "Research", "Urgent"];

const domainArb = fc.constantFrom(...domains);
const pathArb = fc.constantFrom(...paths);

const tabArb = fc.record({
  domain: domainArb,
  path: pathArb,
  isGrouped: fc.boolean(),
  isManualTitle: fc.boolean(),
  windowId: fc.integer({ min: 1, max: 3 }),
});

const ruleArb = fc.record({
  domain: domainArb,
  groupName: fc.option(fc.constantFrom(...customGroupNames), { nil: null }),
  splitByPath: fc.option(fc.integer({ min: 1, max: 2 }), { nil: null }),
  autoDelete: fc.constant(false),
});

// ============================================================================
// PROPERTIES
// ============================================================================

describe("TabGrouping E2E Property-Based Tests (fast-check)", () => {
  let service: TabGroupingService;
  let adapter: ChromeTabAdapter;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new TabGroupingService();
    adapter = new ChromeTabAdapter();
  });

  it("Invariant: Manual groups are moved atomically (No functional changes)", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(tabArb, { minLength: 5, maxLength: 30 }),
        fc.array(ruleArb, { maxLength: 5 }),
        async (rawTabs, rules) => {
          const rulesByDomain: any = {};
          rules.forEach((r) => (rulesByDomain[r.domain] = r));

          const tabs: any[] = [];
          const groupsMetadata = new Map<number, any>();
          let manualGroupId = 500;

          rawTabs.forEach((rt, i) => {
            const id = i + 1; // Unique ID
            let gid = -1;
            if (rt.isGrouped) {
              gid = rt.isManualTitle ? manualGroupId++ : 100;
              if (rt.isManualTitle) {
                groupsMetadata.set(gid, {
                  id: gid,
                  title: "USER_CUSTOM_NAME",
                  color: "blue",
                });
              } else {
                groupsMetadata.set(gid, { id: gid, title: rt.domain });
              }
            }
            tabs.push(
              mkTab(id, `https://${rt.domain}/${rt.path}`, gid, i, rt.windowId),
            );
          });

          const { protectedMeta: protectedTabMeta, managedGroupIds } =
            service.identifyProtectedTabs(tabs, groupsMetadata, rulesByDomain);
          const groupMap = service.buildGroupMap(
            tabs,
            rulesByDomain,
            groupsMetadata,
            protectedTabMeta,
          );
          const cache = new Map(tabs.map((t) => [t.id, t]));
          const states = service.buildGroupStates(
            groupMap,
            cache as any,
            undefined,
            managedGroupIds,
          );

          const withReposition = service.calculateRepositionNeeds(
            states,
            cache as any,
          );
          const plan = service.createGroupPlan(
            withReposition,
            cache as any,
            managedGroupIds,
          );

          // Invariant Check: Protected tabs must NEVER be in tabsToUngroup
          plan.tabsToUngroup.forEach((tid) => {
            expect(protectedTabMeta.has(tid as any)).toBe(false);
          });

          // Invariant Check: Manual groups must move all their tabs together
          plan.states.forEach((ps) => {
            if (ps.isExternal) {
              const meta = Array.from(protectedTabMeta.values()).find(
                (m) => m.title === ps.displayName,
              );
              if (meta) {
                const expectedCount = tabs.filter(
                  (t) => t.groupId === meta.originalGroupId,
                ).length;
                expect(ps.tabIds).toHaveLength(expectedCount);
              }
            }
          });
        },
      ),
      { numRuns: 100 },
    );
  });

  it("Invariant: Manual groups preserve their internal tab order", async () => {
    await fc.assert(
      fc.asyncProperty(
        // Tabs in a specific random order
        fc.array(
          tabArb.map((t) => ({ ...t, isGrouped: true, isManualTitle: true })),
          { minLength: 3, maxLength: 10 },
        ),
        async (rawTabs) => {
          const rulesByDomain: any = {};

          // 1. Initial State (Order is determined by rawTabs generation)
          const tabs = rawTabs.map((rt, i) =>
            mkTab(i + 1, `https://${rt.domain}/${rt.path}`, 101, i, 1),
          );
          const groupsMetadata = new Map([
            [101, { id: 101, title: "Manual Order", color: "red" } as any],
          ]);

          // 2. Build States
          const { protectedMeta: protectedTabMeta, managedGroupIds } =
            service.identifyProtectedTabs(tabs, groupsMetadata, rulesByDomain);
          const groupMap = service.buildGroupMap(
            tabs,
            rulesByDomain,
            groupsMetadata,
            protectedTabMeta,
          );
          const cache = new Map(tabs.map((t) => [t.id, t]));
          const states = service.buildGroupStates(
            groupMap,
            cache as any,
            undefined,
            managedGroupIds,
          );

          // 3. Verification: Tab IDs in the state MUST match the input order exactly
          const pState = states.find((s) => s.title === "Manual Order");
          expect(pState).toBeDefined();
          const expectedIds = tabs.map((t) => t.id);
          expect(pState!.tabIds).toEqual(expectedIds);
        },
      ),
      { numRuns: 50 },
    );
  });

  it("Invariant: Manual groups (including unnamed) are RE-BUNDLED after cross-window merge", async () => {
    await fc.assert(
      fc.asyncProperty(
        // Tabs in Window 2
        fc.array(
          tabArb.map((t) => ({
            ...t,
            windowId: 2,
            isGrouped: true,
            isManualTitle: true,
          })),
          { minLength: 2, maxLength: 5 },
        ),
        fc.boolean(), // Whether the title is empty (unnamed)
        async (rawTabs, isEmptyTitle) => {
          const rulesByDomain: any = {};
          const title = isEmptyTitle ? "" : "Persistence Group";

          // 1. Initial State (Window 2)
          const tabs = rawTabs.map((rt, i) =>
            mkTab(i + 1, `https://${rt.domain}/${rt.path}`, 101, i, 2),
          );
          const groupsMetadata = new Map([
            [101, { id: 101, title: title, color: "green" } as any],
          ]);

          // 2. Identification (Before merge)
          const { protectedMeta: protectedTabMeta, managedGroupIds } =
            service.identifyProtectedTabs(tabs, groupsMetadata, rulesByDomain);

          // 3. Simulate Merge (Move to Window 1, Ungroup)
          const mergedTabs = tabs.map((t) => ({
            ...t,
            windowId: 1,
            groupId: -1,
          }));

          // 4. Grouping Logic (On Window 1)
          const groupMap = service.buildGroupMap(
            mergedTabs,
            rulesByDomain,
            new Map(),
            protectedTabMeta,
          );
          const cache = new Map(mergedTabs.map((t) => [t.id, t]));
          const states = service.buildGroupStates(
            groupMap,
            cache as any,
            undefined,
            managedGroupIds,
          );

          // 5. Verification: State identified as external/manual
          const pGroup = states.find((s) => s.isExternal);
          expect(pGroup).toBeDefined();
          expect(pGroup!.title).toBe(title);
          expect(pGroup!.isExternal).toBe(true);

          // 6. ADAPTER VERIFICATION
          mockChrome.tabs.query.mockResolvedValue(mergedTabs);
          mockChrome.tabGroups.query.mockResolvedValue([]);

          const repositioned = service.calculateRepositionNeeds(
            states,
            cache as any,
          );
          const plan = service.createGroupPlan(
            repositioned,
            cache as any,
            managedGroupIds,
          );

          await adapter.executeGroupPlan(plan, cache as any, new Map());

          const groupCall = mockChrome.tabs.group.mock.calls.find((c) => {
            const tabIds = c[0].tabIds as number[];
            const expectedIds = mergedTabs.map((t) => t.id);
            return (
              tabIds &&
              expectedIds.every((id) => tabIds.includes(id)) &&
              tabIds.length === expectedIds.length
            );
          });
          expect(groupCall).toBeDefined();

          expect(mockChrome.tabGroups.update).toHaveBeenCalledWith(
            expect.any(Number),
            expect.objectContaining({ title: title }),
          );
        },
      ),
      { numRuns: 50 },
    );
  }, 30000);

  it("Invariant: Managed group titles follow rules or domain defaults", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(tabArb, { minLength: 2, maxLength: 15 }),
        fc.array(ruleArb, { minLength: 1, maxLength: 5 }),
        async (rawTabs, rules) => {
          const rulesByDomain: any = {};
          rules.forEach((r) => (rulesByDomain[r.domain] = r));

          // Use un-grouped tabs to verify generation logic
          const tabs = rawTabs.map((rt, i) =>
            mkTab(i + 1, `https://${rt.domain}/${rt.path}`, -1, i),
          );

          const groupMap = service.buildGroupMap(tabs, rulesByDomain);
          const cache = new Map(tabs.map((t) => [t.id, t]));
          const states = service.buildGroupStates(
            groupMap,
            cache as any,
            undefined,
            new Map(), // No managed groups yet as they were all ungrouped
          );

          states.forEach((s) => {
            if (s.tabIds.length < 2) return;

            const firstTab = cache.get(s.tabIds[0]);
            const domain = service.getDomain(firstTab?.url);
            const rule = rulesByDomain[domain];

            if (rule) {
              const base = rule.groupName || domain;
              const url = firstTab?.url;
              const pathSegments = url
                ? new URL(url).pathname.split("/").filter(Boolean)
                : [];
              const canSplit =
                rule.splitByPath && pathSegments.length >= rule.splitByPath;

              if (canSplit) {
                expect(s.title).toContain(" - ");
                expect(s.title.endsWith(` - ${base}`)).toBe(true);
              } else {
                expect(s.title).toBe(base);
              }
            } else {
              expect(s.title).toBe(domain);
            }
          });
        },
      ),
      { numRuns: 100 },
    );
  });

  it("Invariant: A 3-tab custom group ALWAYS retains its 3 tabs across execution pass", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 3 }), // Window ID
        async (windowId) => {
          const rulesByDomain: any = {};

          // 1. Setup: 3 tabs in a manual group
          const tabs = [
            mkTab(1, "https://google.com/1", 101, 0, windowId),
            mkTab(2, "https://google.com/2", 101, 1, windowId),
            mkTab(3, "https://google.com/3", 101, 2, windowId),
          ];
          const groupsMetadata = new Map([
            [101, { id: 101, title: "Custom Group", color: "pink" } as any],
          ]);

          // 2. Identification
          const { protectedMeta: protectedTabMeta, managedGroupIds } =
            service.identifyProtectedTabs(tabs, groupsMetadata, rulesByDomain);
          expect(protectedTabMeta.size).toBe(3);

          // 3. Mapping
          const groupMap = service.buildGroupMap(
            tabs,
            rulesByDomain,
            groupsMetadata,
            protectedTabMeta,
          );
          const cache = new Map(tabs.map((t) => [t.id, t]));
          const states = service.buildGroupStates(
            groupMap,
            cache as any,
            undefined,
            managedGroupIds,
          );

          // 4. Verification: The state MUST contain exactly 3 tabs and be marked external
          const state = states.find((s) => s.title === "Custom Group");
          expect(state).toBeDefined();
          expect(state!.tabIds).toHaveLength(3);
          expect(state!.isExternal).toBe(true);

          // 5. Plan Verification
          const repositioned = service.calculateRepositionNeeds(
            states,
            cache as any,
          );
          const plan = service.createGroupPlan(
            repositioned,
            cache as any,
            managedGroupIds,
          );

          // If it needs to move, it must move all 3 tabs together
          plan.states.forEach((ps) => {
            if (ps.displayName === "Custom Group") {
              expect(ps.tabIds).toHaveLength(3);
              expect(ps.isExternal).toBe(true);
            }
          });
        },
      ),
      { numRuns: 50 },
    );
  });
});

describe("TabGrouping E2E SplitPath Integration Tests", () => {
  let service: TabGroupingService;
  let adapter: ChromeTabAdapter;
  let controller: TabGroupingController;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new TabGroupingService();
    adapter = new ChromeTabAdapter();
    controller = new TabGroupingController();
    (controller as any).service = service;
    (controller as any).adapter = adapter;
    (controller as any).windowService = new WindowManagementService(); // Mock if needed
    (controller as any).isProcessing = false;
    (controller as any).lastStateHash = null;

    mockChrome.tabs.query.mockResolvedValue([]);
    mockChrome.tabGroups.query.mockResolvedValue([]);
    mockChrome.windows.getCurrent.mockResolvedValue({ id: 1, type: "normal" });
    mockChrome.windows.getAll.mockResolvedValue([{ id: 1, type: "normal" }]);
  });

  it("E2E: splitByPath correctly groups tabs by path segment", async () => {
    // Setup: Tabs from the same domain but different paths, and a rule to split by path
    const rules = [{ domain: "github.com", splitByPath: 1, autoDelete: false }];
    mockChrome.storage.local.get.mockResolvedValue({
      rules: rules,
      grouping: { byWindow: false },
    });

    const tabs = [
      mkTab(1, "https://github.com/project-a/file1"),
      mkTab(2, "https://github.com/project-a/file2"),
      mkTab(3, "https://github.com/project-b/file1"),
      mkTab(4, "https://github.com/project-b/file2"),
    ];

    mockChrome.tabs.query.mockResolvedValue(tabs); // Initial tabs query
    mockChrome.tabs.group.mockImplementation((options) => {
      // Simulate Chrome creating a new group ID
      return Promise.resolve(Math.floor(Math.random() * 1000) + 1);
    });
    mockChrome.tabGroups.update.mockResolvedValue({}); // Group update calls

    await controller.execute();

    // Expectations:
    // 1. Two main groups should be formed: "project-a - github.com" and "project-b - github.com"
    // 2. Each created group should contain the correct tabs.
    const groupCalls = mockChrome.tabs.group.mock.calls;
    // Each group is created in applyGroupState, and potentially moved/re-grouped in executeGroupPlan.
    // So we expect 2 calls per group (2*2 = 4)
    expect(groupCalls.length).toBeGreaterThanOrEqual(2);

    const projectAGroup = groupCalls.find((call) => call[0].tabIds.includes(1));
    expect(projectAGroup).toBeDefined();

    const projectBGroup = groupCalls.find(
      (call) => call[0].tabIds.includes(3) && call[0].tabIds.includes(4),
    );
    expect(projectBGroup).toBeDefined();

    // Verify group titles were updated correctly for the created groups
    const updateCalls = mockChrome.tabGroups.update.mock.calls;
    expect(updateCalls).toContainEqual([
      expect.any(Number),
      expect.objectContaining({ title: "project-a - github.com" }),
    ]);
    expect(updateCalls).toContainEqual([
      expect.any(Number),
      expect.objectContaining({ title: "project-b - github.com" }),
    ]);
  });
});

describe("TabGrouping E2E SplitPath Comprehensive Integration Tests", () => {
  let service: TabGroupingService;
  let adapter: ChromeTabAdapter;
  let controller: TabGroupingController;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new TabGroupingService();
    adapter = new ChromeTabAdapter();
    controller = new TabGroupingController();
    (controller as any).service = service;
    (controller as any).adapter = adapter;
    (controller as any).windowService = new WindowManagementService();
    (controller as any).isProcessing = false;
    (controller as any).lastStateHash = null;

    mockChrome.tabs.query.mockResolvedValue([]);
    mockChrome.tabGroups.query.mockResolvedValue([]);
    mockChrome.windows.getCurrent.mockResolvedValue({ id: 1, type: "normal" });
    mockChrome.windows.getAll.mockResolvedValue([{ id: 1, type: "normal" }]);
  });

  it("E2E: splitByPath correctly groups tabs by root domain and path segments", async () => {
    // Setup: Tabs from bing.com with root, images, and search paths
    const rules = [{ domain: "bing.com", splitByPath: 1, autoDelete: false }];
    mockChrome.storage.local.get.mockResolvedValue({
      rules: rules,
      grouping: { byWindow: false },
    });

    const tabs = [
      mkTab(1, "https://bing.com"),
      mkTab(2, "https://bing.com/images"),
      mkTab(3, "https://bing.com/search?q=test"),
      mkTab(4, "https://bing.com/images/thumbnails"), // Should still go to 'images' group (first segment)
    ];
    mockChrome.tabs.query.mockResolvedValue(tabs);
    mockChrome.tabs.group.mockImplementation((options) => {
      return Promise.resolve(Math.floor(Math.random() * 1000) + 1);
    });
    mockChrome.tabGroups.update.mockResolvedValue({});

    await controller.execute();

    // Expectations:
    // 1. Only the "images - bing.com" group should be formed (it has 2 tabs).
    // 2. "bing.com" and "search - bing.com" groups (single tabs) should NOT be formed per "1 tab -> ungroup" rule.
    const groupCalls = mockChrome.tabs.group.mock.calls;
    // expect 2 calls (applyGroupState and executeGroupPlan)
    expect(groupCalls.length).toBeGreaterThanOrEqual(1);

    // Verify "bing.com" group (root path) should not be created
    const rootGroup = groupCalls.find((call) => {
      const tabIds = call[0].tabIds;
      return tabIds.includes(1);
    });
    expect(rootGroup).toBeUndefined();
    expect(mockChrome.tabGroups.update).not.toContainEqual([
      expect.any(Number),
      expect.objectContaining({ title: "bing.com" }),
    ]);

    // Verify "images - bing.com" group
    const imagesGroup = groupCalls.find((call) => call[0].tabIds.includes(2));
    expect(imagesGroup).toBeDefined();
    expect(mockChrome.tabGroups.update.mock.calls).toContainEqual([
      expect.any(Number),
      expect.objectContaining({ title: "images - bing.com" }),
    ]);

    // Verify "search - bing.com" group should not be created
    const searchGroup = groupCalls.find((call) => call[0].tabIds.includes(3));
    expect(searchGroup).toBeUndefined();
    expect(mockChrome.tabGroups.update).not.toContainEqual([
      expect.any(Number),
      expect.objectContaining({ title: "search - bing.com" }),
    ]);
  });
});
