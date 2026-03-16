import { ChromeTabAdapter, TabGroupingController } from "./background";
import { TabGroupingService, asTabId, asWindowId } from "./utils/grouping";
import { beforeEach, describe, expect, it, vi } from "vitest";

import fc from "fast-check";
import { mkTab } from "./test-utils";

// ============================================================================
// MOCKS & SETUP - MUST BE AT TOP
// ============================================================================

let currentTabs: any[] = [];
let currentGroups = new Map<number, any>();

const mockChrome = {
  runtime: {
    getURL: vi.fn().mockReturnValue("chrome-extension://self-id/"),
  },
  storage: {
    local: { get: vi.fn(), set: vi.fn() },
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
      const group = currentGroups.get(gid) || { id: gid };
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
vi.stubGlobal("browser", mockChrome);

beforeEach(() => {
  vi.clearAllMocks();
  currentTabs = [];
  currentGroups = new Map();
});

// Mock the sync store utility
vi.mock("./utils/startSyncStore.js", () => ({
  default: vi.fn().mockResolvedValue({
    getState: vi
      .fn()
      .mockImplementation(() => mockChrome.storage.local.get("rules")),
  }),
}));

/**
 * Helper to assert that a second execution of the controller does nothing.
 * Standardizes the idempotency check across all E2E tests.
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
            const id = i + 1;
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

          plan.tabsToUngroup.forEach((tid) => {
            expect(protectedTabMeta.has(tid as any)).toBe(false);
          });

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
        fc.array(
          tabArb.map((t) => ({ ...t, isGrouped: true, isManualTitle: true })),
          { minLength: 3, maxLength: 10 },
        ),
        async (rawTabs) => {
          const rulesByDomain: any = {};
          const tabs = rawTabs.map((rt, i) =>
            mkTab(i + 1, `https://${rt.domain}/${rt.path}`, 101, i, 1),
          );
          const groupsMetadata = new Map([
            [101, { id: 101, title: "Manual Order", color: "red" } as any],
          ]);

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

          const pState = states.find((s) => s.displayName === "Manual Order");
          expect(pState).toBeDefined();
          const expectedIds = tabs.map((t) => t.id);
          expect(pState!.tabIds).toEqual(expectedIds);
        },
      ),
      { numRuns: 50 },
    );
  });

  it("Invariant: Manual groups (NAMED ONLY) are RE-BUNDLED after cross-window merge", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          tabArb.map((t) => ({
            ...t,
            windowId: 2,
            isGrouped: true,
            isManualTitle: true,
          })),
          { minLength: 2, maxLength: 5 },
        ),
        fc.boolean(),
        async (rawTabs, _byWindow) => {
          const rulesByDomain: any = {};
          const title = "Persistence Group"; // Mandate: Only named groups are protected

          const tabs = rawTabs.map((rt, i) =>
            mkTab(i + 1, `https://${rt.domain}/${rt.path}`, 101, i, 2),
          );
          const groupsMetadata = new Map([
            [101, { id: 101, title: title, color: "green" } as any],
          ]);

          const { protectedMeta: protectedTabMeta, managedGroupIds } =
            service.identifyProtectedTabs(tabs, groupsMetadata, rulesByDomain);

          const mergedTabs = tabs.map((t) => ({
            ...t,
            windowId: 1,
            groupId: -1,
          }));

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

          const pGroup = states.find((s) => s.isExternal);
          expect(pGroup).toBeDefined();
          expect(pGroup!.displayName).toBe(title);
          expect(pGroup!.isExternal).toBe(true);

          currentTabs = mergedTabs;
          currentGroups = new Map();

          const repositioned = service.calculateRepositionNeeds(
            states,
            cache as any,
          );
          const plan = service.createGroupPlan(
            repositioned,
            cache as any,
            managedGroupIds,
          );

          await adapter.executeGroupPlan(plan, rulesByDomain, 1, {
            tabs: mergedTabs,
            groups: [],
          });

          const groupCall = mockChrome.tabs.group.mock.calls.find((c) => {
            const options = c[0];
            const tabIds = Array.isArray(options.tabIds)
              ? options.tabIds
              : [options.tabIds];
            const expectedIds = mergedTabs.map((t) => t.id);
            return (
              tabIds &&
              expectedIds.every((id) => tabIds.includes(id as number)) &&
              tabIds.length === expectedIds.length
            );
          });

          expect(groupCall).toBeDefined();

          if (title) {
            expect(mockChrome.tabGroups.update).toHaveBeenCalledWith(
              expect.any(Number),
              expect.objectContaining({ title: title }),
            );
          }
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

          const tabs = rawTabs.map((rt, i) =>
            mkTab(i + 1, `https://${rt.domain}/${rt.path}`, -1, i),
          );

          const groupMap = service.buildGroupMap(tabs, rulesByDomain);
          const cache = new Map(tabs.map((t) => [t.id, t]));
          const states = service.buildGroupStates(
            groupMap,
            cache as any,
            undefined,
            new Map(),
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
                expect(s.displayName).toContain(" - ");
                expect(s.displayName.endsWith(` - ${base}`)).toBe(true);
              } else {
                expect(s.displayName).toBe(base);
              }
            } else {
              expect(s.displayName).toBe(domain);
            }
          });
        },
      ),
      { numRuns: 100 },
    );
  });

  it("Invariant: A 3-tab custom group ALWAYS retains its 3 tabs across execution pass", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 3 }), async (windowId) => {
        const rulesByDomain: any = {};
        const tabs = [
          mkTab(1, "https://google.com/1", 101, 0, windowId),
          mkTab(2, "https://google.com/2", 101, 1, windowId),
          mkTab(3, "https://google.com/3", 101, 2, windowId),
        ];
        const groupsMetadata = new Map([
          [101, { id: 101, title: "Custom Group", color: "pink" } as any],
        ]);

        const { protectedMeta: protectedTabMeta, managedGroupIds } =
          service.identifyProtectedTabs(tabs, groupsMetadata, rulesByDomain);
        expect(protectedTabMeta.size).toBe(3);

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

        const state = states.find((s) => s.displayName === "Custom Group");
        expect(state).toBeDefined();
        expect(state!.tabIds).toHaveLength(3);
        expect(state!.isExternal).toBe(true);

        const repositioned = service.calculateRepositionNeeds(
          states,
          cache as any,
        );
        const plan = service.createGroupPlan(
          repositioned,
          cache as any,
          managedGroupIds,
        );

        plan.states.forEach((ps) => {
          if (ps.displayName === "Custom Group") {
            expect(ps.tabIds).toHaveLength(3);
            expect(ps.isExternal).toBe(true);
          }
        });
      }),
      { numRuns: 50 },
    );
  });

  it("Invariant: When byWindow is true, groups remain isolated in their original windows", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(tabArb, { minLength: 10, maxLength: 30 }),
        async (rawTabs) => {
          const rulesByDomain: any = {};
          const tabs = rawTabs.map((rt, i) =>
            mkTab(i + 1, `https://${rt.domain}/${rt.path}`, -1, i, rt.windowId),
          );

          const windows = [...new Set(tabs.map((t) => t.windowId))];

          for (const windowId of windows) {
            const windowTabs = tabs.filter((t) => t.windowId === windowId);
            const groupMap = service.buildGroupMap(windowTabs, rulesByDomain);
            const cache = new Map(windowTabs.map((t) => [t.id, t]));
            const states = service.buildGroupStates(
              groupMap,
              cache as any,
              undefined,
              new Map(),
            );

            states.forEach((s) => {
              s.tabIds.forEach((tid) => {
                const tab = cache.get(tid);
                expect(tab?.windowId).toBe(windowId);
              });
            });
          }
        },
      ),
      { numRuns: 50 },
    );
  });

  it("Invariant: When byWindow is false, all groups are mapped to the active window", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(tabArb, { minLength: 10, maxLength: 30 }),
        fc.integer({ min: 1, max: 3 }),
        async (rawTabs, activeWindowId) => {
          const rulesByDomain: any = {};
          const tabs = rawTabs.map((rt, i) =>
            mkTab(i + 1, `https://${rt.domain}/${rt.path}`, -1, i, rt.windowId),
          );

          const groupMap = service.buildGroupMap(tabs, rulesByDomain);
          const cache = new Map(tabs.map((t) => [t.id, t]));
          const managedGroupIds = new Map();

          const states = service.buildGroupStates(
            groupMap,
            cache as any,
            undefined,
            managedGroupIds,
          );

          const withReposition = service.calculateRepositionNeeds(
            states,
            cache as any,
            asWindowId(activeWindowId),
          );

          const plan = service.createGroupPlan(
            withReposition,
            cache as any,
            managedGroupIds,
            asWindowId(activeWindowId),
          );

          withReposition.forEach((s) => {
            const stateTabs = s.tabIds.map((tid) => cache.get(tid));
            const hasCrossWindowTab = stateTabs.some(
              (t) => t?.windowId !== activeWindowId,
            );

            if (hasCrossWindowTab) {
              expect(s.needsReposition).toBe(true);
            }
          });

          plan.states.forEach((ps) => {
            expect(ps.targetIndex).toBeDefined();
          });

          const plannedTabIds = new Set(
            withReposition
              .filter((s) => s.tabIds.length >= 2)
              .flatMap((s) => s.tabIds),
          );

          const domainCounts = new Map<string, number>();
          tabs.forEach((t) => {
            const d = service.getDomain(t.url);
            domainCounts.set(d, (domainCounts.get(d) || 0) + 1);
          });

          tabs.forEach((t) => {
            const d = service.getDomain(t.url);
            if ((domainCounts.get(d) || 0) >= 2) {
              expect(plannedTabIds.has(asTabId(t.id)!)).toBe(true);
            }
          });
        },
      ),
      { numRuns: 50 },
    );
  });
});

describe("TabGrouping E2E SplitPath Integration Tests", () => {
  let controller: TabGroupingController;

  beforeEach(() => {
    vi.clearAllMocks();
    controller = new TabGroupingController();
    (controller as any).isProcessing = false;
    (controller as any).lastStateHash = null;

    currentTabs = [];
    currentGroups = new Map();
    mockChrome.windows.getCurrent.mockResolvedValue({ id: 1, type: "normal" });
    mockChrome.windows.getAll.mockResolvedValue([{ id: 1, type: "normal" }]);
  });

  it("E2E: splitByPath correctly groups tabs by path segment", async () => {
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

    currentTabs = tabs;
    currentGroups = new Map();

    await controller.execute();

    const groupCalls = mockChrome.tabs.group.mock.calls;
    expect(groupCalls.length).toBeGreaterThanOrEqual(2);

    const projectAGroup = groupCalls.find((call) => call[0].tabIds.includes(1));
    expect(projectAGroup).toBeDefined();

    const projectBGroup = groupCalls.find(
      (call) => call[0].tabIds.includes(3) && call[0].tabIds.includes(4),
    );
    expect(projectBGroup).toBeDefined();

    const updateCalls = mockChrome.tabGroups.update.mock.calls;
    expect(updateCalls).toContainEqual([
      expect.any(Number),
      expect.objectContaining({ title: "project-a - github.com" }),
    ]);
    expect(updateCalls).toContainEqual([
      expect.any(Number),
      expect.objectContaining({ title: "project-b - github.com" }),
    ]);

    await assertIdempotent(controller);
  });
});

describe("TabGrouping E2E SplitPath Comprehensive Integration Tests", () => {
  let controller: TabGroupingController;

  beforeEach(() => {
    vi.clearAllMocks();
    controller = new TabGroupingController();
    (controller as any).isProcessing = false;
    (controller as any).lastStateHash = null;

    currentTabs = [];
    currentGroups = new Map();
    mockChrome.windows.getCurrent.mockResolvedValue({ id: 1, type: "normal" });
    mockChrome.windows.getAll.mockResolvedValue([{ id: 1, type: "normal" }]);
  });

  it("E2E: splitByPath correctly groups tabs by root domain and path segments", async () => {
    const rules = [{ domain: "bing.com", splitByPath: 1, autoDelete: false }];
    mockChrome.storage.local.get.mockResolvedValue({
      rules: rules,
      grouping: { byWindow: false },
    });

    const tabs = [
      mkTab(1, "https://bing.com"),
      mkTab(2, "https://bing.com/images"),
      mkTab(3, "https://bing.com/search?q=test"),
      mkTab(4, "https://bing.com/images/thumbnails"),
    ];
    currentTabs = tabs;
    currentGroups = new Map();

    await controller.execute();

    const groupCalls = mockChrome.tabs.group.mock.calls;
    expect(groupCalls.length).toBeGreaterThanOrEqual(1);

    const rootGroup = groupCalls.find((call) => call[0].tabIds.includes(1));
    expect(rootGroup).toBeUndefined();
    expect(mockChrome.tabGroups.update).not.toContainEqual([
      expect.any(Number),
      expect.objectContaining({ title: "bing.com" }),
    ]);

    const imagesGroup = groupCalls.find((call) => call[0].tabIds.includes(2));
    expect(imagesGroup).toBeDefined();
    expect(mockChrome.tabGroups.update.mock.calls).toContainEqual([
      expect.any(Number),
      expect.objectContaining({ title: "images - bing.com" }),
    ]);

    const searchGroup = groupCalls.find((call) => call[0].tabIds.includes(3));
    expect(searchGroup).toBeUndefined();
    expect(mockChrome.tabGroups.update).not.toContainEqual([
      expect.any(Number),
      expect.objectContaining({ title: "images - bing.com" }),
    ]);

    await assertIdempotent(controller);
  });
});

describe("TabGrouping E2E Window Consolidation Integration Tests", () => {
  let controller: TabGroupingController;

  beforeEach(() => {
    vi.clearAllMocks();
    controller = new TabGroupingController();
    (controller as any).isProcessing = false;
    (controller as any).lastStateHash = null;

    currentTabs = [];
    currentGroups = new Map();
    mockChrome.windows.getCurrent.mockResolvedValue({ id: 1, type: "normal" });
    mockChrome.windows.getAll.mockResolvedValue([{ id: 1, type: "normal" }]);
  });

  it("E2E: numWindowsToKeep correctly consolidates excess windows", async () => {
    mockChrome.storage.local.get.mockResolvedValue({
      rules: [],
      grouping: { byWindow: true, numWindowsToKeep: 2 },
    });

    const tabs = [
      mkTab(1, "https://a.com/1", -1, 0, 1),
      mkTab(2, "https://a.com/2", -1, 1, 1),
      mkTab(3, "https://b.com/1", -1, 0, 2),
      mkTab(4, "https://b.com/2", -1, 1, 2),
      mkTab(5, "https://c.com/1", -1, 0, 3),
      mkTab(6, "https://c.com/2", -1, 1, 3),
    ];

    currentTabs = tabs;
    currentGroups = new Map();
    mockChrome.windows.getAll.mockResolvedValue([
      { id: 1, type: "normal" },
      { id: 2, type: "normal" },
      { id: 3, type: "normal" },
    ]);
    mockChrome.windows.getCurrent.mockResolvedValue({ id: 1, type: "normal" });

    await controller.execute();

    const moveCalls = mockChrome.tabs.move.mock.calls;
    const movedTab5 = moveCalls.find(
      (call) =>
        call[0] === 5 || (Array.isArray(call[0]) && call[0].includes(5)),
    );
    const movedTab6 = moveCalls.find(
      (call) =>
        call[0] === 6 || (Array.isArray(call[0]) && call[0].includes(6)),
    );

    expect(movedTab5).toBeDefined();
    expect(movedTab6).toBeDefined();
    expect([1, 2]).toContain(movedTab5![1].windowId);
    expect([1, 2]).toContain(movedTab6![1].windowId);

    await assertIdempotent(controller);
  });

  it("E2E: numWindowsToKeep correctly moves managed groups as a block via tabGroups.move", async () => {
    const rules = [{ domain: "google.com", autoDelete: false }];
    mockChrome.storage.local.get.mockResolvedValue({
      rules: rules,
      grouping: { byWindow: true, numWindowsToKeep: 1 },
    });

    const tabs = [
      mkTab(1, "https://a.com/1", -1, 0, 1),
      mkTab(4, "https://a.com/2", -1, 1, 1),
      mkTab(5, "https://a.com/3", -1, 2, 1),
      mkTab(2, "https://google.com/1", 101, 0, 2),
      mkTab(3, "https://google.com/2", 101, 1, 2),
    ];

    currentTabs = tabs;
    currentGroups = new Map([
      [101, { id: 101, title: "google.com", windowId: 2 }],
    ]);
    mockChrome.windows.getAll.mockResolvedValue([
      { id: 1, type: "normal" },
      { id: 2, type: "normal" },
    ]);
    mockChrome.windows.getCurrent.mockResolvedValue({ id: 1, type: "normal" });

    await controller.execute();

    expect(mockChrome.tabGroups.move).toHaveBeenCalledWith(
      101,
      expect.objectContaining({ windowId: 1 }),
    );

    const moveCalls = mockChrome.tabs.move.mock.calls;
    const individualMove2 = moveCalls.find(
      (call) =>
        call[0] === 2 || (Array.isArray(call[0]) && call[0].includes(2)),
    );
    const individualMove3 = moveCalls.find(
      (call) =>
        call[0] === 3 || (Array.isArray(call[0]) && call[0].includes(3)),
    );

    expect(individualMove2).toBeUndefined();
    expect(individualMove3).toBeUndefined();
  });
});

describe("TabGrouping E2E Auto-Delete Integration Tests", () => {
  let controller: TabGroupingController;

  beforeEach(() => {
    vi.clearAllMocks();
    controller = new TabGroupingController();
    (controller as any).isProcessing = false;
    (controller as any).lastStateHash = null;

    currentTabs = [];
    currentGroups = new Map();
    mockChrome.windows.getCurrent.mockResolvedValue({ id: 1, type: "normal" });
    mockChrome.windows.getAll.mockResolvedValue([{ id: 1, type: "normal" }]);
  });

  it("E2E: autoDelete rule correctly closes tabs session-wide before grouping", async () => {
    const rules = [
      { domain: "trash.com", autoDelete: true },
      { domain: "keep.com", autoDelete: false },
    ];
    mockChrome.storage.local.get.mockResolvedValue({
      rules: rules,
      grouping: { byWindow: false },
    });

    const tabs = [
      mkTab(1, "https://trash.com/ads"),
      mkTab(2, "https://keep.com/important"),
      mkTab(3, "https://trash.com/tracker"),
    ];

    currentTabs = tabs;
    currentGroups = new Map();

    await controller.execute();

    const removeCalls = mockChrome.tabs.remove.mock.calls;
    const removedIds = removeCalls.flatMap((call) => call[0]);

    expect(removedIds).toContain(1);
    expect(removedIds).toContain(3);
    expect(removedIds).not.toContain(2);

    expect(mockChrome.tabs.group).not.toHaveBeenCalled();

    await assertIdempotent(controller);
  });
});

describe("TabGrouping E2E Deduplication Integration Tests", () => {
  let controller: TabGroupingController;

  beforeEach(() => {
    vi.clearAllMocks();
    controller = new TabGroupingController();
    (controller as any).isProcessing = false;
    (controller as any).lastStateHash = null;

    currentTabs = [];
    currentGroups = new Map();
    mockChrome.windows.getCurrent.mockResolvedValue({ id: 1, type: "normal" });
    mockChrome.windows.getAll.mockResolvedValue([{ id: 1, type: "normal" }]);
  });

  it("E2E: global deduplication closes duplicate URLs session-wide, including inside manual groups", async () => {
    mockChrome.storage.local.get.mockResolvedValue({
      rules: [],
      grouping: { byWindow: false },
    });

    const tabs = [
      mkTab(1, "https://shared.com/page", 101, 0, 1),
      mkTab(2, "https://unique.com/page", -1, 1, 1),
      mkTab(3, "https://shared.com/page", -1, 0, 2),
    ];

    currentTabs = tabs;
    currentGroups = new Map([
      [101, { id: 101, title: "My Manual Group", windowId: 1 }],
    ]);

    await controller.execute();

    const removeCalls = mockChrome.tabs.remove.mock.calls;
    const removedIds = removeCalls.flatMap((call) => call[0]);

    expect(removedIds).toContain(3);
    expect(removedIds).not.toContain(1);
    expect(removedIds).not.toContain(2);

    await assertIdempotent(controller);
  });

  it("E2E: deduplication prefers the earliest instance (lowest ID/index) regardless of window", async () => {
    mockChrome.storage.local.get.mockResolvedValue({
      rules: [],
      grouping: { byWindow: false },
    });

    const tabs = [
      mkTab(10, "https://dup.com", -1, 0, 2),
      mkTab(20, "https://dup.com", -1, 0, 1),
    ];

    currentTabs = tabs;
    currentGroups = new Map();

    await controller.execute();

    const removedIds = mockChrome.tabs.remove.mock.calls.flatMap((c) => c[0]);
    expect(removedIds).toContain(20);
    expect(removedIds).not.toContain(10);

    await assertIdempotent(controller);
  });

  it("E2E: global single-tab ungrouping immediately ungroups 1-tab groups if enabled", async () => {
    mockChrome.storage.local.get.mockResolvedValue({
      rules: [],
      grouping: { byWindow: false, ungroupSingleTab: true },
    });

    const tabs = [
      mkTab(1, "https://shared.com/page", 101, 0, 1), // Only tab in group 101
      mkTab(2, "https://unique.com/page", -1, 1, 1),
    ];

    currentTabs = tabs;
    currentGroups = new Map([
      [101, { id: 101, title: "My Manual Group", windowId: 1 }],
    ]);

    await controller.execute();

    // Tab 1 should now have groupId -1
    const tab1 = currentTabs.find((t) => t.id === 1);
    expect(tab1?.groupId).toBe(-1);
    expect(mockChrome.tabs.ungroup).toHaveBeenCalledWith(1);

    await assertIdempotent(controller);
  });

  it("E2E: global single-tab ungrouping skips 1-tab groups if disabled", async () => {
    mockChrome.storage.local.get.mockResolvedValue({
      rules: [],
      grouping: { byWindow: false, ungroupSingleTab: false },
    });

    const tabs = [
      mkTab(1, "https://shared.com/page", 101, 0, 1), // Only tab in group 101
      mkTab(2, "https://unique.com/page", -1, 1, 1),
    ];

    currentTabs = tabs;
    currentGroups = new Map([
      [101, { id: 101, title: "My Manual Group", windowId: 1 }],
    ]);

    await controller.execute();

    // Tab 1 should still have groupId 101
    const tab1 = currentTabs.find((t) => t.id === 1);
    expect(tab1?.groupId).toBe(101);
    expect(mockChrome.tabs.ungroup).not.toHaveBeenCalled();

    await assertIdempotent(controller);
  });
});

describe("TabGrouping E2E Mixed Grouping & Scavenging Integration Tests", () => {
  let controller: TabGroupingController;

  beforeEach(() => {
    vi.clearAllMocks();
    controller = new TabGroupingController();
    (controller as any).isProcessing = false;
    (controller as any).lastStateHash = null;

    currentTabs = [];
    currentGroups = new Map();
    mockChrome.windows.getCurrent.mockResolvedValue({ id: 1, type: "normal" });
    mockChrome.windows.getAll.mockResolvedValue([{ id: 1, type: "normal" }]);
  });

  it("E2E: mixed group handles intruders (evicts them) and remains stable", async () => {
    const rules = [
      { domain: "google.com", autoDelete: false },
      { domain: "bing.com", autoDelete: false },
    ];
    mockChrome.storage.local.get.mockResolvedValue({
      rules: rules,
      grouping: { byWindow: false },
    });

    // Group 100: [Google 1, Google 2, Bing 3 (Intruder)]
    // Group 200: [Bing 4] (Single tab group)
    const tabs = [
      mkTab(1, "https://google.com/1", 100, 0, 1),
      mkTab(2, "https://google.com/2", 100, 1, 1),
      mkTab(3, "https://bing.com/1", 100, 2, 1), // Intruder
      mkTab(4, "https://bing.com/2", 200, 3, 1), // Single tab group
      mkTab(5, "https://yahoo.com/1", -1, 4, 1), // Unsorted tab
    ];

    currentTabs = tabs;
    currentGroups = new Map();
    currentGroups.set(100, { id: 100, title: "google.com", windowId: 1 });
    currentGroups.set(200, { id: 200, title: "bing.com", windowId: 1 });

    // Trigger 1: Execute
    await controller.execute();

    // Verify after 1st execution:
    // Tab 1 & 2 are in a group (likely 100)
    const t1 = currentTabs.find((t) => t.id === 1);
    const t2 = currentTabs.find((t) => t.id === 2);
    expect(t1.groupId).toBe(t2.groupId);
    expect(t1.groupId).not.toBe(-1);

    // Tab 3 & 4 should now be in the same group (Bing)
    const t3 = currentTabs.find((t) => t.id === 3);
    const t4 = currentTabs.find((t) => t.id === 4);
    expect(t3.groupId).toBe(t4.groupId);
    expect(t3.groupId).not.toBe(t1.groupId);
    expect(t3.groupId).not.toBe(-1);

    // Tab 5 stays unsorted (-1)
    const t5 = currentTabs.find((t) => t.id === 5);
    expect(t5.groupId).toBe(-1);

    await assertIdempotent(controller);
  });

  it("E2E: single managed group tab is ungrouped immediately", async () => {
    const rules = [{ domain: "google.com", autoDelete: false }];
    mockChrome.storage.local.get.mockResolvedValue({
      rules: rules,
      grouping: { byWindow: false },
    });

    const tabs = [
      mkTab(1, "https://google.com/1", 100, 0, 1), // Managed group with only 1 tab
      mkTab(2, "https://yahoo.com/1", -1, 1, 1),
    ];

    currentTabs = tabs;
    currentGroups = new Map();
    currentGroups.set(100, { id: 100, title: "google.com", windowId: 1 });

    await controller.execute();

    const t1 = currentTabs.find((t) => t.id === 1);
    expect(t1.groupId).toBe(-1);
    expect(mockChrome.tabs.ungroup).toHaveBeenCalled();

    await assertIdempotent(controller);
  });
});

describe("TabGrouping E2E Localhost & Ports Tests", () => {
  let controller: TabGroupingController;

  beforeEach(() => {
    vi.clearAllMocks();
    controller = new TabGroupingController();
    (controller as any).isProcessing = false;
    (controller as any).lastStateHash = null;

    currentTabs = [];
    currentGroups = new Map();
    mockChrome.windows.getCurrent.mockResolvedValue({ id: 1, type: "normal" });
    mockChrome.windows.getAll.mockResolvedValue([{ id: 1, type: "normal" }]);
  });

  it("E2E: localhost with different ports are grouped separately (uses host)", async () => {
    mockChrome.storage.local.get.mockResolvedValue({
      rules: [],
      grouping: { byWindow: false },
    });

    const tabs = [
      mkTab(1, "http://localhost:8000/1", -1, 0, 1),
      mkTab(2, "http://localhost:8000/2", -1, 1, 1),
      mkTab(3, "http://localhost:8529/1", -1, 2, 1),
      mkTab(4, "http://localhost:8529/2", -1, 3, 1),
    ];
    currentTabs = tabs;
    currentGroups = new Map();

    await controller.execute();

    // Verify they are in separate groups
    const t1 = currentTabs.find((t) => t.id === 1);
    const t3 = currentTabs.find((t) => t.id === 3);

    expect(t1.groupId).not.toBe(-1);
    expect(t3.groupId).not.toBe(-1);
    expect(t1.groupId).not.toBe(t3.groupId);

    // Verify group titles include ports
    const group1 = currentGroups.get(t1.groupId);
    const group2 = currentGroups.get(t3.groupId);
    expect(group1?.title).toBe("localhost:8000");
    expect(group2?.title).toBe("localhost:8529");

    await assertIdempotent(controller);
  });
});

describe("TabGrouping E2E Title Management Tests", () => {
  let controller: TabGroupingController;

  beforeEach(() => {
    vi.clearAllMocks();
    controller = new TabGroupingController();
    (controller as any).isProcessing = false;
    (controller as any).lastStateHash = null;

    currentTabs = [];
    currentGroups = new Map();
    mockChrome.windows.getCurrent.mockResolvedValue({ id: 1, type: "normal" });
    mockChrome.windows.getAll.mockResolvedValue([{ id: 1, type: "normal" }]);
  });

  it("E2E: Newly created groups have titles visible after ONE click", async () => {
    mockChrome.storage.local.get.mockResolvedValue({
      rules: [],
      grouping: { byWindow: false },
    });

    // Sets up 2 loose tabs.
    const tabs = [
      mkTab(1, "https://google.com/1"),
      mkTab(2, "https://google.com/2"),
    ];
    currentTabs = tabs;
    currentGroups = new Map();

    // Executes grouping.
    await controller.execute();

    // Verifies mockChrome.tabGroups.update was called with the correct title.
    expect(mockChrome.tabGroups.update).toHaveBeenCalledWith(
      expect.any(Number),
      expect.objectContaining({ title: "google.com" }),
    );
  });
});
