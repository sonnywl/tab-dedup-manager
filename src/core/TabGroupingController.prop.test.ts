import {
  ConsolidationPlan,
  MembershipPlan,
  OrderPlan,
  Result,
  RulesByDomain,
  SyncStore,
  SyncStoreState,
  Tab,
  TabId,
  WindowId,
  asTabId,
} from "../types";
import { TabGroupingService, WindowManagementService } from "../utils/grouping";
import { beforeEach, describe, expect, it, vi } from "vitest";

import ChromeTabAdapter from "./ChromeTabAdapter";
import TabGroupingController from "./TabGroupingController";
import fc from "fast-check";
import { mkTab } from "./test-utils";

// ============================================================================
// MOCK ADAPTER
// ============================================================================

class MockAdapter extends ChromeTabAdapter {
  public tabs: Tab[] = [];
  public groups: chrome.tabGroups.TabGroup[] = [];
  public currentWindowId: number = 1;

  constructor() {
    super();
  }

  async getNormalTabs(): Promise<Tab[]> {
    return [...this.tabs].sort((a, b) => {
      if (a.windowId !== b.windowId)
        return (a.windowId || 0) - (b.windowId || 0);
      return a.index - b.index;
    });
  }

  async getGroups(): Promise<chrome.tabGroups.TabGroup[]> {
    return [...this.groups];
  }

  async removeTabs(tabIds: TabId[]): Promise<void> {
    this.tabs = this.tabs.filter((t) => !tabIds.includes(asTabId(t.id)!));
    this.reindexAll();
  }

  private reindexAll() {
    const windows = [...new Set(this.tabs.map((t) => t.windowId))];
    for (const wid of windows) {
      if (wid === undefined) continue;
      const wTabs = this.tabs
        .filter((t) => t.windowId === wid)
        .sort((a, b) => a.index - b.index);
      wTabs.forEach((t, i) => (t.index = i));
    }
  }

  async moveTab(id: number, windowId: number, targetIndex: number) {
    const tab = this.tabs.find((t) => t.id === id);
    if (!tab) return;

    this.tabs = this.tabs.filter((t) => t.id !== id);
    const sameWindow = this.tabs
      .filter((t) => t.windowId === windowId)
      .sort((a, b) => a.index - b.index);

    const actualIdx =
      targetIndex === -1
        ? sameWindow.length
        : Math.min(targetIndex, sameWindow.length);
    sameWindow.splice(actualIdx, 0, tab);

    tab.windowId = windowId;
    sameWindow.forEach((t, i) => (t.index = i));
    this.tabs = [
      ...this.tabs.filter((t) => t.windowId !== windowId),
      ...sameWindow,
    ];
  }

  async getCurrentWindow(): Promise<chrome.windows.Window> {
    return {
      id: this.currentWindowId,
      type: "normal",
    } as chrome.windows.Window;
  }

  async getAllNormalWindows(): Promise<chrome.windows.Window[]> {
    const windowIds = [...new Set(this.tabs.map((t) => t.windowId))];
    if (windowIds.length === 0) windowIds.push(this.currentWindowId);
    return windowIds.map(
      (id) => ({ id, type: "normal" }) as chrome.windows.Window,
    );
  }

  async executeMembershipPlan(
    plan: MembershipPlan,
  ): Promise<Result<void, Error>> {
    for (const tid of plan.toUngroup) {
      const t = this.tabs.find((x) => x.id === tid);
      if (t) t.groupId = -1;
    }
    for (const entry of plan.toGroup) {
      let gid = entry.groupId;
      if (gid === null) {
        gid =
          Math.max(
            0,
            ...this.groups.map((g) => g.id),
            ...this.tabs.map((t) => t.groupId || 0),
          ) + 1;
        this.groups.push({
          id: gid,
          title: entry.title || "",
          collapsed: entry.collapsed || false,
          windowId: plan.targetWindowId,
          color: "grey",
        } as chrome.tabGroups.TabGroup);
      } else {
        const g = this.groups.find((x) => x.id === gid);
        if (g) {
          g.title = entry.title;
          g.collapsed = entry.collapsed;
          g.windowId = plan.targetWindowId;
        }
      }
      for (const tid of entry.tabIds) {
        const t = this.tabs.find((x) => x.id === tid);
        if (t) {
          t.groupId = gid;
          t.windowId = plan.targetWindowId;
        }
      }
    }
    this.reindexAll();
    return { success: true, value: undefined };
  }

  async executeOrderPlan(
    plan: OrderPlan,
    windowId: WindowId,
  ): Promise<Result<void, Error>> {
    for (const unit of plan.desired) {
      const isToMove = plan.toMove.some((mu) => {
        if (unit.kind === "group" && mu.kind === "group")
          return unit.groupId === mu.groupId;
        if (unit.kind === "solo" && mu.kind === "solo")
          return unit.tabId === mu.tabId;
        return false;
      });

      if (isToMove) {
        if (unit.kind === "solo") {
          await this.moveTab(unit.tabId, windowId, unit.targetIndex);
        } else {
          const gTabs = this.tabs
            .filter((t) => t.groupId === unit.groupId)
            .sort((a, b) => a.index - b.index);
          let currentTarget = unit.targetIndex;
          for (const t of gTabs) {
            await this.moveTab(t.id!, windowId, currentTarget++);
            t.groupId = unit.groupId;
          }
          const g = this.groups.find((x) => x.id === unit.groupId);
          if (g) g.windowId = windowId;
        }
      }
    }
    this.reindexAll();
    return { success: true, value: undefined };
  }

  async executeConsolidationPlan(
    plan: ConsolidationPlan,
  ): Promise<Result<void, Error>> {
    for (const gm of plan.groupMoves) {
      const gTabs = this.tabs.filter((t) => t.groupId === gm.groupId);
      for (const t of gTabs) {
        await this.moveTab(t.id!, gm.windowId, -1);
        t.groupId = gm.groupId;
      }
      const g = this.groups.find((x) => x.id === gm.groupId);
      if (g) g.windowId = gm.windowId;
    }
    for (const tm of plan.tabMoves) {
      for (const tid of tm.tabIds) {
        await this.moveTab(tid, tm.windowId, -1);
      }
    }
    this.reindexAll();
    return { success: true, value: undefined };
  }

  async applyInternalPageMoves(
    moves: { tabId: TabId; targetIndex: number }[],
  ): Promise<void> {
    for (const move of moves) {
      const tab = this.tabs.find((t) => t.id === move.tabId);
      if (tab && tab.windowId !== undefined) {
        await this.moveTab(move.tabId, tab.windowId, move.targetIndex);
      }
    }
    this.reindexAll();
  }

  async ungroupSingleTabGroups(
    tabs: Tab[],
    service: TabGroupingService,
    rules: RulesByDomain,
  ): Promise<void> {
    const counts = new Map<number, number>();
    for (const t of this.tabs) {
      if (t.groupId !== -1 && t.groupId !== undefined)
        counts.set(t.groupId!, (counts.get(t.groupId!) || 0) + 1);
    }
    for (const t of this.tabs) {
      if (
        t.groupId !== -1 &&
        t.groupId !== undefined &&
        counts.get(t.groupId!) === 1
      ) {
        t.groupId = -1;
      }
    }
    this.reindexAll();
  }

  async updateBadge(text: string, color?: string): Promise<void> {}
}

// ============================================================================
// ARBITRARIES (Generators)
// ============================================================================

const domains = [
  "google.com",
  "bing.com",
  "nature.com",
  "github.com",
  "stackoverflow.com",
  "apple.com",
  "microsoft.com",
];
const paths = [
  "/search",
  "/mail",
  "/docs",
  "/issues",
  "/repo",
  "/q",
  "/tags",
  "/blog",
  "/store",
];
const internalUrls = [
  "chrome://settings",
  "chrome://extensions",
  "chrome://history",
];
const customGroupNames = ["My Project", "Work", "Research", "Urgent"];

const domainArb = fc.constantFrom(...domains);
const pathArb = fc.constantFrom(...paths);

const tabArb = fc.record({
  domain: domainArb,
  path: pathArb,
  isGrouped: fc.boolean(),
  isManualTitle: fc.boolean(),
  windowId: fc.integer({ min: 1, max: 3 }),
  pinned: fc.boolean(),
  isDuplicate: fc.boolean(),
  pathCasing: fc.oneof(
    fc.constant("lower"),
    fc.constant("upper"),
    fc.constant("mixed"),
  ),
});

const ruleArb = fc.record({
  domain: domainArb,
  groupName: fc.option(fc.constantFrom(...customGroupNames), { nil: null }),
  splitByPath: fc.option(fc.integer({ min: 1, max: 2 }), { nil: null }),
  autoDelete: fc.constant(false),
});

// ============================================================================
// PROPERTY-BASED TESTS
// ============================================================================

describe("TabGroupingController Stability & Invariants (Property-Based)", () => {
  let service: TabGroupingService;
  let windowService: WindowManagementService;
  let adapter: MockAdapter;
  let mockStore: SyncStore<SyncStoreState>;

  beforeEach(() => {
    service = new TabGroupingService();
    windowService = new WindowManagementService();
    adapter = new MockAdapter();
    mockStore = {
      getState: vi.fn(),
    };
  });

  it("should achieve a stable state in one execution with complex sub-paths and mixed casing", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          windows: fc.array(
            fc.record({
              tabs: fc.array(
                fc.record({
                  domain: fc.constantFrom(...domains),
                  path: fc.constantFrom(...paths),
                  pinned: fc.boolean(),
                  isDuplicate: fc.boolean(),
                  pathCasing: fc.oneof(
                    fc.constant("lower"),
                    fc.constant("upper"),
                    fc.constant("mixed"),
                  ),
                }),
                { minLength: 10, maxLength: 25 },
              ),
              internalTabs: fc.array(
                fc.record({
                  url: fc.constantFrom(...internalUrls),
                }),
                { minLength: 1, maxLength: 3 },
              ),
              manualGroups: fc.array(
                fc.record({
                  title: fc.string({ minLength: 3, maxLength: 10 }),
                  numTabs: fc.integer({ min: 2, max: 4 }),
                }),
                { minLength: 0, maxLength: 2 },
              ),
            }),
            { minLength: 1, maxLength: 3 },
          ),
          config: fc.record({
            byWindow: fc.boolean(),
            numWindowsToKeep: fc.integer({ min: 1, max: 2 }),
            ungroupSingleTab: fc.boolean(),
          }),
          splitByPathValue: fc.integer({ min: 1, max: 2 }),
        }),
        async ({ windows, config, splitByPathValue }) => {
          adapter.tabs = [];
          adapter.groups = [];
          adapter.currentWindowId = 1;
          let nextTabId = 1;
          let nextGroupId = 500;

          windows.forEach((win, winIdx) => {
            const windowId = winIdx + 1;
            win.manualGroups.forEach((mg) => {
              const gid = nextGroupId++;
              adapter.groups.push({
                id: gid,
                title: mg.title,
                windowId,
                collapsed: false,
                color: "grey" as const,
              } as chrome.tabGroups.TabGroup);
              for (let i = 0; i < mg.numTabs; i++) {
                adapter.tabs.push(
                  mkTab(
                    nextTabId++,
                    "https://user-manual.com/page",
                    gid,
                    i,
                    windowId,
                  ),
                );
              }
            });

            win.tabs.forEach((t) => {
              let p = t.path;
              if (t.pathCasing === "upper") p = p.toUpperCase();
              else if (t.pathCasing === "mixed")
                p = p.charAt(0).toUpperCase() + p.slice(1).toLowerCase();

              const fullUrl = `https://${t.domain}${p}`;
              adapter.tabs.push(
                mkTab(nextTabId++, fullUrl, null, 0, windowId, t.pinned),
              );
              if (t.isDuplicate) {
                adapter.tabs.push(
                  mkTab(nextTabId++, fullUrl, null, 0, windowId, t.pinned),
                );
              }
            });
            win.internalTabs.forEach((t) => {
              adapter.tabs.push(
                mkTab(nextTabId++, t.url, null, 0, windowId, false),
              );
            });
          });

          adapter.tabs.sort(() => Math.random() - 0.5);
          adapter.tabs.forEach((t, i) => (t.index = i));

          const rules = domains.map((d) => ({
            id: crypto.randomUUID(),
            domain: d,
            title: d,
            autoDelete: false,
            splitByPath: splitByPathValue,
          }));

          vi.mocked(mockStore.getState).mockResolvedValue({
            rules,
            grouping: config,
          });

          const controller = new TabGroupingController(
            service,
            windowService,
            adapter,
            mockStore,
          );

          await controller.execute();
          const state1 = await adapter.getNormalTabs();
          const groups1 = await adapter.getGroups();
          const hash1 = service.hashState(
            state1,
            new Map(groups1.map((g) => [g.id, g])),
          );

          await controller.execute();
          const state2 = await adapter.getNormalTabs();
          const groups2 = await adapter.getGroups();
          const hash2 = service.hashState(
            state2,
            new Map(groups2.map((g) => [g.id, g])),
          );
          await controller.execute();
          const state3 = await adapter.getNormalTabs();
          const groups3 = await adapter.getGroups();
          const hash3 = service.hashState(
            state3,
            new Map(groups3.map((g) => [g.id, g])),
          );

          if (hash1 !== hash2) {
            console.log("HASH MISMATCH DETECTED!");
            console.log("Config:", config, "splitByPath:", splitByPathValue);
            groups1.forEach((g1) => {
              const g2 = groups2.find((x) => x.id === g1.id);
              if (g2 && g1.title !== g2.title) {
                console.log(
                  `Group ${g1.id} title changed: from "${g1.title}" to "${g2.title}"`,
                );
              }
            });
          }

          expect(hash2).toBe(hash1);
          expect(hash3).toBe(hash2);
        },
      ),
      { numRuns: 50 },
    );
  }, 30000);

  it("Invariant: Manual groups preserve their internal tab order", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          tabArb.map((t) => ({ ...t, isGrouped: true, isManualTitle: true })),
          { minLength: 3, maxLength: 10 },
        ),
        async (rawTabs) => {
          adapter.tabs = rawTabs.map((rt, i) =>
            mkTab(i + 1, `https://${rt.domain}/${rt.path}`, 101, i, 1),
          );
          adapter.groups = [
            {
              id: 101,
              title: "Manual Order",
              color: "red",
              windowId: 1,
              collapsed: false,
            } as chrome.tabGroups.TabGroup,
          ];

          vi.mocked(mockStore.getState).mockResolvedValue({
            rules: [],
            grouping: { byWindow: false },
          });

          const controller = new TabGroupingController(
            service,
            windowService,
            adapter,
            mockStore,
          );
          await controller.execute();

          const finalTabs = await adapter.getNormalTabs();
          const gTabs = finalTabs.filter((t) => t.groupId === 101);
          const expectedIds = adapter.tabs.map((t) => t.id);
          expect(gTabs.map((t) => t.id)).toEqual(expectedIds);
        },
      ),
      { numRuns: 50 },
    );
  });

  it("Invariant: Managed group titles follow rules or domain defaults", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(tabArb, { minLength: 2, maxLength: 15 }),
        fc.array(ruleArb, { minLength: 1, maxLength: 5 }),
        async (rawTabs, rules) => {
          const rulesByDomain: RulesByDomain = {};
          rules.forEach((r) => {
            if (r.domain) rulesByDomain[service.normalizeDomain(r.domain)] = r;
          });

          adapter.tabs = rawTabs.map((rt, i) =>
            mkTab(i + 1, `https://${rt.domain}/${rt.path}`, -1, i, 1),
          );
          adapter.groups = [];

          vi.mocked(mockStore.getState).mockResolvedValue({
            rules,
            grouping: { byWindow: false },
          });

          const controller = new TabGroupingController(
            service,
            windowService,
            adapter,
            mockStore,
          );
          await controller.execute();

          const finalTabs = await adapter.getNormalTabs();
          const finalGroups = await adapter.getGroups();
          const groupMap = new Map(finalGroups.map((g) => [g.id, g]));

          finalTabs.forEach((t) => {
            if (t.groupId === -1) return;
            const group = groupMap.get(t.groupId);
            if (!group) return;

            const domain = service.getDomain(t.url);
            const rule = rulesByDomain[domain];

            if (rule) {
              const base = rule.groupName || domain;
              const url = t.url;
              const pathSegments = url
                ? new URL(url).pathname.split("/").filter(Boolean)
                : [];
              const canSplit =
                rule.splitByPath && pathSegments.length >= rule.splitByPath;

              if (canSplit) {
                expect(group.title).toContain(" - ");
                expect(group.title.endsWith(` - ${base}`)).toBe(true);
              } else {
                const expectedVariants = [base, `${domain} - ${base}`];
                expect(expectedVariants).toContain(group.title);
              }
            } else {
              expect(group.title).toBe(domain);
            }
          });
        },
      ),
      { numRuns: 50 },
    );
  });

  it("Invariant: A 3-tab custom group ALWAYS retains its 3 tabs across execution pass", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 3 }), async (windowId) => {
        adapter.tabs = [
          mkTab(1, "https://google.com/1", 101, 0, windowId),
          mkTab(2, "https://google.com/2", 101, 1, windowId),
          mkTab(3, "https://google.com/3", 101, 2, windowId),
        ];
        adapter.groups = [
          {
            id: 101,
            title: "Custom Group",
            color: "pink",
            windowId,
            collapsed: false,
          } as chrome.tabGroups.TabGroup,
        ];

        vi.mocked(mockStore.getState).mockResolvedValue({
          rules: [],
          grouping: { byWindow: true, numWindowsToKeep: 2 },
        });

        const controller = new TabGroupingController(
          service,
          windowService,
          adapter,
          mockStore,
        );
        await controller.execute();

        const finalTabs = await adapter.getNormalTabs();
        const gTabs = finalTabs.filter((t) => t.groupId === 101);
        expect(gTabs).toHaveLength(3);
      }),
      { numRuns: 50 },
    );
  });

  it("Invariant: When byWindow is true, groups remain isolated in their original windows", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(tabArb, { minLength: 10, maxLength: 30 }),
        async (rawTabs) => {
          adapter.tabs = rawTabs.map((rt, i) =>
            mkTab(i + 1, `https://${rt.domain}/${rt.path}`, -1, i, rt.windowId),
          );
          adapter.groups = [];

          vi.mocked(mockStore.getState).mockResolvedValue({
            rules: [],
            grouping: { byWindow: true, numWindowsToKeep: 3 },
          });

          const controller = new TabGroupingController(
            service,
            windowService,
            adapter,
            mockStore,
          );
          await controller.execute();

          const finalTabs = await adapter.getNormalTabs();
          const groupsByWindow = new Map<number, Set<number>>();

          finalTabs.forEach((t) => {
            if (t.groupId === -1) return;
            if (!groupsByWindow.has(t.windowId))
              groupsByWindow.set(t.windowId, new Set());
            groupsByWindow.get(t.windowId)!.add(t.groupId);
          });

          // Check that no group ID exists in multiple windows
          const allGroups = Array.from(groupsByWindow.values());
          for (let i = 0; i < allGroups.length; i++) {
            for (let j = i + 1; j < allGroups.length; j++) {
              const intersection = new Set(
                [...allGroups[i]].filter((x) => allGroups[j].has(x)),
              );
              expect(intersection.size).toBe(0);
            }
          }
        },
      ),
      { numRuns: 50 },
    );
  });
});
