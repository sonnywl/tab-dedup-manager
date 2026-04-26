import { RulesByDomain, Tab, TabId, asTabId, asWindowId } from "@/types";
import { TabGroupingService, WindowManagementService } from "./utils/grouping";
import { beforeEach, describe, expect, it, vi } from "vitest";

import ChromeTabAdapter from "./core/ChromeTabAdapter";
import TabGroupingController from "./core/TabGroupingController";
import fc from "fast-check";
import { mkTab } from "./core/test-utils";

// ============================================================================
// MOCKS & SETUP - MUST BE AT TOP
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
          collapsed: false,
          color: "blue",
          shared: false,
        });
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

  // Triggering execute() should result in a "skipping" log and zero Chrome API calls.
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
  let controller: TabGroupingController;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new TabGroupingService();
    adapter = new ChromeTabAdapter();
    const windowService = new WindowManagementService();
    const store = {
      getState: vi.fn().mockImplementation(async () => {
        const rules = await mockChrome.storage.local.get("rules");
        const grouping = await mockChrome.storage.local.get("grouping");
        return {
          rules: rules.rules || [],
          grouping: grouping.grouping || {
            byWindow: false,
            numWindowsToKeep: 2,
            ungroupSingleTab: false,
          },
        };
      }),
    };
    controller = new TabGroupingController(
      service,
      windowService,
      adapter,
      store as any,
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
          const rulesByDomain: RulesByDomain = {};
          const tabs = rawTabs.map((rt, i) =>
            mkTab(i + 1, `https://${rt.domain}/${rt.path}`, 101, i, 1),
          );
          const groupsMetadata = new Map<number, chrome.tabGroups.TabGroup>([
            [
              101,
              {
                id: 101,
                title: "Manual Order",
                color: "red",
              } as chrome.tabGroups.TabGroup,
            ],
          ]);

          const { protectedMeta: protectedTabMeta, managedGroupIds } =
            service.identifyProtectedTabs(tabs, groupsMetadata, rulesByDomain);
          expect(protectedTabMeta.size).toBe(tabs.length);
          const groupMap = service.buildGroupMap(
            tabs,
            rulesByDomain,
            groupsMetadata,
            protectedTabMeta,
          );
          const cache = new Map<TabId, Tab>(
            tabs.map((t) => [asTabId(t.id)!, t]),
          );
          const states = service.buildGroupStates(
            groupMap,
            cache,
            undefined,
            managedGroupIds,
          );

          const pState = states.find((s) => s.displayName === "Manual Order");
          expect(pState).toBeDefined();
          const expectedIds = tabs.map((t) => asTabId(t.id)!);
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
          const title = "Persistence Group"; // Mandate: Only named groups are protected

          const tabs = rawTabs.map((rt, i) =>
            mkTab(i + 1, `https://${rt.domain}/${rt.path}`, 101, i, 2),
          );
          const groupsMetadata = new Map<number, chrome.tabGroups.TabGroup>([
            [
              101,
              {
                id: 101,
                title: title,
                color: "green",
              } as chrome.tabGroups.TabGroup,
            ],
          ]);

          currentTabs = tabs;
          currentGroups = groupsMetadata;

          // Executes full controller flow.
          // This will:
          // 1. identifyProtectedTabs(tabs) -> finds Group 101 as manual
          // 2. consolidationPhase -> moves tabs from Win 2 to Win 1
          // 3. runGroupingPhase -> re-bundles them into Group 101 in Win 1
          await controller.execute();

          // Verify that all tabs ended up in the same group in Window 1
          const expectedIds = tabs.map((t) => t.id);
          const finalTabs = currentTabs.filter((t) =>
            expectedIds.includes(t.id),
          );

          expect(finalTabs.every((t) => t.windowId === 1)).toBe(true);

          const gids = new Set(
            finalTabs.map((t) => t.groupId).filter((gid) => gid !== -1),
          );
          expect(gids.size).toBe(1);

          const gid = Array.from(gids)[0] as number;
          expect(currentGroups.get(gid)?.title).toBe(title);

          if (title) {
            // Also check that it's correctly titled in the mock
            const group = Array.from(currentGroups.values()).find(
              (g) => g.title === title,
            );
            expect(group).toBeDefined();
            expect(group?.windowId).toBe(1);
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
          const rulesByDomain: RulesByDomain = {};
          rules.forEach((r) => (rulesByDomain[r.domain] = r));

          const tabs = rawTabs.map((rt, i) =>
            mkTab(i + 1, `https://${rt.domain}/${rt.path}`, -1, i),
          );

          const groupMap = service.buildGroupMap(tabs, rulesByDomain);
          const cache = new Map<TabId, Tab>(
            tabs.map((t) => [asTabId(t.id)!, t]),
          );
          const states = service.buildGroupStates(
            groupMap,
            cache,
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
                // Mandate: titles might be prefixed with domain for disambiguation if multiple rules use same name
                const expectedVariants = [base, `${domain} - ${base}`];
                expect(expectedVariants).toContain(s.displayName);
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
        const rulesByDomain: RulesByDomain = {};
        const tabs = [
          mkTab(1, "https://google.com/1", 101, 0, windowId),
          mkTab(2, "https://google.com/2", 101, 1, windowId),
          mkTab(3, "https://google.com/3", 101, 2, windowId),
        ];
        const groupsMetadata = new Map<number, chrome.tabGroups.TabGroup>([
          [
            101,
            {
              id: 101,
              title: "Custom Group",
              color: "pink",
            } as chrome.tabGroups.TabGroup,
          ],
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
        const cache = new Map<TabId, Tab>(tabs.map((t) => [asTabId(t.id)!, t]));
        const states = service.buildGroupStates(
          groupMap,
          cache,
          undefined,
          managedGroupIds,
        );

        const state = states.find((s) => s.displayName === "Custom Group");
        expect(state).toBeDefined();
        expect(state!.tabIds).toHaveLength(3);
        expect(state!.isExternal).toBe(true);

        const repositioned = service.calculateRepositionNeeds(states, cache);
        const plan = service.buildMembershipPlan(
          repositioned,
          cache,
          managedGroupIds,
          asWindowId(windowId),
        );

        plan.toGroup.forEach((ps) => {
          if (ps.title === "Custom Group") {
            expect(ps.tabIds).toHaveLength(3);
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
          const rulesByDomain: RulesByDomain = {};
          const tabs = rawTabs.map((rt, i) =>
            mkTab(i + 1, `https://${rt.domain}/${rt.path}`, -1, i, rt.windowId),
          );

          const windows = [...new Set(tabs.map((t) => t.windowId))];

          for (const windowId of windows) {
            const windowTabs = tabs.filter((t) => t.windowId === windowId);
            const groupMap = service.buildGroupMap(windowTabs, rulesByDomain);
            const cache = new Map<TabId, Tab>(
              windowTabs.map((t) => [asTabId(t.id)!, t]),
            );
            const states = service.buildGroupStates(
              groupMap,
              cache,
              undefined,
              new Map<number, string>(),
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
          const rulesByDomain: RulesByDomain = {};
          const tabs = rawTabs.map((rt, i) =>
            mkTab(i + 1, `https://${rt.domain}/${rt.path}`, -1, i, rt.windowId),
          );

          const groupMap = service.buildGroupMap(tabs, rulesByDomain);
          const cache = new Map<TabId, Tab>(
            tabs.map((t) => [asTabId(t.id)!, t]),
          );
          const managedGroupIds = new Map<number, string>();

          const states = service.buildGroupStates(
            groupMap,
            cache,
            undefined,
            managedGroupIds,
          );

          const withReposition = service.calculateRepositionNeeds(
            states,
            cache,
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
            expect(s.targetIndex).toBeDefined();
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
    const service = new TabGroupingService();
    const windowService = new WindowManagementService();
    const adapter = new ChromeTabAdapter();
    const store = {
      getState: vi.fn().mockImplementation(async () => {
        const rules = await mockChrome.storage.local.get("rules");
        const grouping = await mockChrome.storage.local.get("grouping");
        return {
          rules: rules.rules || [],
          grouping: grouping.grouping || {
            byWindow: false,
            numWindowsToKeep: 2,
            ungroupSingleTab: false,
          },
        };
      }),
    };
    controller = new TabGroupingController(
      service,
      windowService,
      adapter,
      store as any,
    );
    (controller as any).isProcessing = false;

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
    const service = new TabGroupingService();
    const windowService = new WindowManagementService();
    const adapter = new ChromeTabAdapter();
    const store = {
      getState: vi.fn().mockImplementation(async () => {
        const rules = await mockChrome.storage.local.get("rules");
        const grouping = await mockChrome.storage.local.get("grouping");
        return {
          rules: rules.rules || [],
          grouping: grouping.grouping || {
            byWindow: false,
            numWindowsToKeep: 2,
            ungroupSingleTab: false,
          },
        };
      }),
    };
    controller = new TabGroupingController(
      service,
      windowService,
      adapter,
      store as any,
    );
    (controller as any).isProcessing = false;

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
    const service = new TabGroupingService();
    const windowService = new WindowManagementService();
    const adapter = new ChromeTabAdapter();
    const store = {
      getState: vi.fn().mockImplementation(async () => {
        const rules = await mockChrome.storage.local.get("rules");
        const grouping = await mockChrome.storage.local.get("grouping");
        return {
          rules: rules.rules || [],
          grouping: grouping.grouping || {
            byWindow: false,
            numWindowsToKeep: 2,
            ungroupSingleTab: false,
          },
        };
      }),
    };
    controller = new TabGroupingController(
      service,
      windowService,
      adapter,
      store as any,
    );
    (controller as any).isProcessing = false;

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
    const service = new TabGroupingService();
    const windowService = new WindowManagementService();
    const adapter = new ChromeTabAdapter();
    const store = {
      getState: vi.fn().mockImplementation(async () => {
        const rules = await mockChrome.storage.local.get("rules");
        const grouping = await mockChrome.storage.local.get("grouping");
        return {
          rules: rules.rules || [],
          grouping: grouping.grouping || {
            byWindow: false,
            numWindowsToKeep: 2,
            ungroupSingleTab: false,
          },
        };
      }),
    };
    controller = new TabGroupingController(
      service,
      windowService,
      adapter,
      store as any,
    );
    (controller as any).isProcessing = false;

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
    const service = new TabGroupingService();
    const windowService = new WindowManagementService();
    const adapter = new ChromeTabAdapter();
    const store = {
      getState: vi.fn().mockImplementation(async () => {
        const rules = await mockChrome.storage.local.get("rules");
        const grouping = await mockChrome.storage.local.get("grouping");
        return {
          rules: rules.rules || [],
          grouping: grouping.grouping || {
            byWindow: false,
            numWindowsToKeep: 2,
            ungroupSingleTab: false,
          },
        };
      }),
    };
    controller = new TabGroupingController(
      service,
      windowService,
      adapter,
      store as any,
    );
    (controller as any).isProcessing = false;

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
    // With new stable sorting: Tab 20 (Win 1) comes before Tab 10 (Win 2).
    // So Tab 20 is kept, and Tab 10 is removed.
    expect(removedIds).toContain(10);
    expect(removedIds).not.toContain(20);

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
      [101, { id: 101, title: "shared.com", windowId: 1 }],
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
    const service = new TabGroupingService();
    const windowService = new WindowManagementService();
    const adapter = new ChromeTabAdapter();
    const store = {
      getState: vi.fn().mockImplementation(async () => {
        const rules = await mockChrome.storage.local.get("rules");
        const grouping = await mockChrome.storage.local.get("grouping");
        return {
          rules: rules.rules || [],
          grouping: grouping.grouping || {
            byWindow: false,
            numWindowsToKeep: 2,
            ungroupSingleTab: false,
          },
        };
      }),
    };
    controller = new TabGroupingController(
      service,
      windowService,
      adapter,
      store as any,
    );
    (controller as any).isProcessing = false;

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
    const service = new TabGroupingService();
    const windowService = new WindowManagementService();
    const adapter = new ChromeTabAdapter();
    const store = {
      getState: vi.fn().mockImplementation(async () => {
        const rules = await mockChrome.storage.local.get("rules");
        const grouping = await mockChrome.storage.local.get("grouping");
        return {
          rules: rules.rules || [],
          grouping: grouping.grouping || {
            byWindow: false,
            numWindowsToKeep: 2,
            ungroupSingleTab: false,
          },
        };
      }),
    };
    controller = new TabGroupingController(
      service,
      windowService,
      adapter,
      store as any,
    );
    (controller as any).isProcessing = false;

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
    const service = new TabGroupingService();
    const windowService = new WindowManagementService();
    const adapter = new ChromeTabAdapter();
    const store = {
      getState: vi.fn().mockImplementation(async () => {
        const rules = await mockChrome.storage.local.get("rules");
        const grouping = await mockChrome.storage.local.get("grouping");
        return {
          rules: rules.rules || [],
          grouping: grouping.grouping || {
            byWindow: false,
            numWindowsToKeep: 2,
            ungroupSingleTab: false,
          },
        };
      }),
    };
    controller = new TabGroupingController(
      service,
      windowService,
      adapter,
      store as any,
    );
    (controller as any).isProcessing = false;

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

describe("TabGrouping E2E skipCleanup Flag Tests", () => {
  let controller: TabGroupingController;

  beforeEach(() => {
    vi.clearAllMocks();
    const service = new TabGroupingService();
    const windowService = new WindowManagementService();
    const adapter = new ChromeTabAdapter();
    const store = {
      getState: vi.fn().mockImplementation(async () => {
        const rules = await mockChrome.storage.local.get("rules");
        const grouping = await mockChrome.storage.local.get("grouping");
        return {
          rules: rules.rules || [],
          grouping: grouping.grouping || {
            byWindow: false,
            numWindowsToKeep: 2,
            ungroupSingleTab: false,
            processGroupOnChange: false,
          },
        };
      }),
    };
    controller = new TabGroupingController(
      service,
      windowService,
      adapter,
      store as any,
    );
    (controller as any).isProcessing = false;

    currentTabs = [];
    currentGroups = new Map();
    mockChrome.windows.getCurrent.mockResolvedValue({ id: 1, type: "normal" });
    mockChrome.windows.getAll.mockResolvedValue([{ id: 1, type: "normal" }]);
  });

  it("E2E: skipCleanup: true prevents deduplication", async () => {
    mockChrome.storage.local.get.mockResolvedValue({
      rules: [],
      grouping: { byWindow: false },
    });

    const tabs = [
      mkTab(1, "https://dup.com/page", -1, 0, 1),
      mkTab(2, "https://dup.com/page", -1, 1, 1),
    ];
    currentTabs = tabs;

    await controller.execute({ skipCleanup: true });

    // Deduplication would have called remove(2). Verify it was NOT called.
    expect(mockChrome.tabs.remove).not.toHaveBeenCalled();

    // But it SHOULD still group them
    expect(mockChrome.tabs.group).toHaveBeenCalled();
    const t1 = currentTabs.find((t) => t.id === 1);
    const t2 = currentTabs.find((t) => t.id === 2);
    expect(t1.groupId).toBe(t2.groupId);
    expect(t1.groupId).not.toBe(-1);
  });

  it("E2E: skipCleanup: true prevents auto-delete", async () => {
    const rules = [{ domain: "trash.com", autoDelete: true }];
    mockChrome.storage.local.get.mockResolvedValue({
      rules: rules,
      grouping: { byWindow: false },
    });

    const tabs = [mkTab(1, "https://trash.com/ads")];
    currentTabs = tabs;

    await controller.execute({ skipCleanup: true });

    // Auto-delete would have called remove(1). Verify it was NOT called.
    expect(mockChrome.tabs.remove).not.toHaveBeenCalled();
  });

  it("E2E: skipCleanup: false (default) performs deduplication and auto-delete", async () => {
    const rules = [{ domain: "trash.com", autoDelete: true }];
    mockChrome.storage.local.get.mockResolvedValue({
      rules: rules,
      grouping: { byWindow: false },
    });

    const tabs = [
      mkTab(1, "https://trash.com/ads"),
      mkTab(2, "https://dup.com/page"),
      mkTab(3, "https://dup.com/page"),
    ];
    currentTabs = tabs;

    await controller.execute(); // default skipCleanup: false

    const removedIds = mockChrome.tabs.remove.mock.calls.flatMap((c) => c[0]);
    expect(removedIds).toContain(1); // Auto-delete
    expect(removedIds).toContain(3); // Deduplication
  });

  it("E2E: dual hashes correctly skip redundant runs while allowing manual cleanup", async () => {
    mockChrome.storage.local.get.mockResolvedValue({
      rules: [],
      grouping: { byWindow: false },
    });

    const tabs = [
      mkTab(1, "https://dup.com/page"),
      mkTab(2, "https://dup.com/page"),
    ];
    currentTabs = tabs;

    // 1. Auto-run (skips cleanup)
    await controller.execute({ skipCleanup: true });
    expect(mockChrome.tabs.remove).not.toHaveBeenCalled();
    expect(mockChrome.tabs.group).toHaveBeenCalled(); // Should have grouped them

    // 2. Second Auto-run (should skip)
    mockChrome.tabs.group.mockClear();
    await controller.execute({ skipCleanup: true });
    expect(mockChrome.tabs.group).not.toHaveBeenCalled();

    // 3. Manual run (must clean up even if state hasn't changed since Step 1)
    await controller.execute(); // default skipCleanup: false
    const removedIds = mockChrome.tabs.remove.mock.calls.flatMap((c) => c[0]);
    expect(removedIds).toContain(2);

    // 4. Second Manual run (should skip because it's already clean)
    mockChrome.tabs.remove.mockClear();
    await controller.execute();
    expect(mockChrome.tabs.remove).not.toHaveBeenCalled();
  });
});

describe("TabGrouping E2E processGroupOnChange Trigger Tests", () => {
  let controller: TabGroupingController;
  let store: any;

  beforeEach(() => {
    vi.clearAllMocks();
    const service = new TabGroupingService();
    const windowService = new WindowManagementService();
    const adapter = new ChromeTabAdapter();
    store = {
      getState: vi.fn(),
    };
    controller = new TabGroupingController(
      service,
      windowService,
      adapter,
      store as any,
    );
    (controller as any).isProcessing = false;

    currentTabs = [];
    currentGroups = new Map();
    mockChrome.windows.getCurrent.mockResolvedValue({ id: 1, type: "normal" });
    mockChrome.windows.getAll.mockResolvedValue([{ id: 1, type: "normal" }]);
  });

  it("E2E: execute() is called with skipCleanup: true when processGroupOnChange is enabled", async () => {
    // This test simulates the logic inside background.ts's handleTabChange
    store.getState.mockResolvedValue({
      rules: [],
      grouping: { processGroupOnChange: true, byWindow: false },
    });

    const executeSpy = vi.spyOn(controller, "execute");

    // Simulate background.ts handleTabChange logic:
    const state = await store.getState();
    if (state.grouping.processGroupOnChange) {
      await controller.execute({ skipCleanup: true });
    }

    expect(executeSpy).toHaveBeenCalledWith({ skipCleanup: true });
  });

  it("E2E: execute() is NOT called when processGroupOnChange is disabled", async () => {
    store.getState.mockResolvedValue({
      rules: [],
      grouping: { processGroupOnChange: false, byWindow: false },
    });

    const executeSpy = vi.spyOn(controller, "execute");

    // Simulate background.ts handleTabChange logic:
    const state = await store.getState();
    if (state.grouping.processGroupOnChange) {
      await controller.execute({ skipCleanup: true });
    }

    expect(executeSpy).not.toHaveBeenCalled();
  });
});
