import { describe, expect, it, vi, beforeEach } from "vitest";
import fc from "fast-check";

// ============================================================================
// MOCKS & SETUP - MUST BE AT TOP
// ============================================================================

const mockChrome = {
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
    getState: vi.fn().mockResolvedValue({ rules: [], grouping: {} })
  })
}));

import {
  TabGroupingService,
  ChromeTabAdapter,
} from "./background";

// Helper to make a tab
const mkTab = (id: number, url: string, groupId = -1, index = 0, windowId = 1): any => ({
  id,
  url,
  groupId,
  index,
  windowId,
});

// ============================================================================
// ARBITRARIES (Generators)
// ============================================================================

const domains = ["google.com", "bing.com", "nature.com", "github.com", "stackoverflow.com"];
const paths = ["search", "images", "articles", "repo", "wiki", "questions"];
const customGroupNames = ["My Project", "Work", "Research", "Urgent"];

const domainArb = fc.constantFrom(...domains);
const pathArb = fc.constantFrom(...paths);

const tabArb = fc.record({
  id: fc.integer({ min: 1, max: 10000 }),
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
  skipProcess: fc.constant(false),
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
            let gid = -1;
            if (rt.isGrouped) {
              gid = rt.isManualTitle ? manualGroupId++ : 100;
              if (rt.isManualTitle) {
                groupsMetadata.set(gid, { id: gid, title: "USER_CUSTOM_NAME" });
              } else {
                groupsMetadata.set(gid, { id: gid, title: rt.domain });
              }
            }
            tabs.push(mkTab(rt.id, `https://${rt.domain}/${rt.path}`, gid, i, rt.windowId));
          });

          const protectedTabMeta = service.identifyProtectedTabs(tabs, groupsMetadata, rulesByDomain);
          const groupMap = service.buildGroupMap(tabs, rulesByDomain, groupsMetadata, protectedTabMeta);
          const cache = new Map(tabs.map((t) => [t.id, t]));
          const states = service.buildGroupStates(groupMap, cache as any);

          const withReposition = service.calculateRepositionNeeds(states, cache as any);
          const plan = service.createGroupPlan(withReposition, cache as any);

          plan.states.forEach((ps) => {
            if (ps.isExternal) {
              expect(ps.currentlyGrouped).toHaveLength(0);
            }
          });
        }
      ),
      { numRuns: 100 }
    );
  });

  it("Invariant: Manual groups preserve their internal tab order", async () => {
    await fc.assert(
      fc.asyncProperty(
        // Tabs in a specific random order
        fc.array(tabArb.map(t => ({ ...t, isGrouped: true, isManualTitle: true })), { minLength: 3, maxLength: 10 }),
        async (rawTabs) => {
          const rulesByDomain: any = {};
          
          // 1. Initial State (Order is determined by rawTabs generation)
          const tabs = rawTabs.map((rt, i) => 
            mkTab(rt.id, `https://${rt.domain}/${rt.path}`, 101, i, 1)
          );
          const groupsMetadata = new Map([[101, { id: 101, title: "Manual Order" } as any]]);

          // 2. Build States
          const protectedTabMeta = service.identifyProtectedTabs(tabs, groupsMetadata, rulesByDomain);
          const groupMap = service.buildGroupMap(tabs, rulesByDomain, groupsMetadata, protectedTabMeta);
          const cache = new Map(tabs.map(t => [t.id, t]));
          const states = service.buildGroupStates(groupMap, cache as any);

          // 3. Verification: Tab IDs in the state MUST match the input order exactly
          const pState = states.find(s => s.title === "Manual Order");
          expect(pState).toBeDefined();
          const expectedIds = tabs.map(t => t.id);
          expect(pState!.tabIds).toEqual(expectedIds);
        }
      ),
      { numRuns: 50 }
    );
  });

  it("Invariant: Manual groups (including unnamed) are RE-BUNDLED after cross-window merge", async () => {
    await fc.assert(
      fc.asyncProperty(
        // Tabs in Window 2
        fc.array(tabArb.map(t => ({ ...t, windowId: 2, isGrouped: true, isManualTitle: true })), { minLength: 2, maxLength: 5 }),
        fc.boolean(), // Whether the title is empty (unnamed)
        async (rawTabs, isEmptyTitle) => {
          const rulesByDomain: any = {};
          const title = isEmptyTitle ? "" : "Persistence Group";
          
          // 1. Initial State (Window 2)
          const tabs = rawTabs.map((rt, i) => 
            mkTab(rt.id, `https://${rt.domain}/${rt.path}`, 101, i, 2)
          );
          const groupsMetadata = new Map([[101, { id: 101, title: title } as any]]);

          // 2. Identification (Before merge)
          const protectedTabMeta = service.identifyProtectedTabs(tabs, groupsMetadata, rulesByDomain);

          // 3. Simulate Merge (Move to Window 1, Ungroup)
          const mergedTabs = tabs.map(t => ({ ...t, windowId: 1, groupId: -1 }));

          // 4. Grouping Logic (On Window 1)
          const groupMap = service.buildGroupMap(mergedTabs, rulesByDomain, new Map(), protectedTabMeta);
          const cache = new Map(mergedTabs.map(t => [t.id, t]));
          const states = service.buildGroupStates(groupMap, cache as any);

          // 5. Verification: State identified as external/manual
          const pGroup = states.find(s => s.isExternal);
          expect(pGroup).toBeDefined();
          expect(pGroup!.title).toBe(title);
          expect(pGroup!.isExternal).toBe(true);
          
          // 6. ADAPTER VERIFICATION
          mockChrome.tabs.query.mockResolvedValue(mergedTabs);
          mockChrome.tabGroups.query.mockResolvedValue([]);

          const repositioned = service.calculateRepositionNeeds(states, cache as any);
          const plan = service.createGroupPlan(repositioned, cache as any);
          
          await adapter.executeGroupPlan(plan, cache as any, new Map());

          const groupCall = mockChrome.tabs.group.mock.calls.find(c => {
            const tabIds = c[0].tabIds as number[];
            const expectedIds = mergedTabs.map(t => t.id);
            return tabIds && expectedIds.every(id => tabIds.includes(id)) && tabIds.length === expectedIds.length;
          });
          expect(groupCall).toBeDefined();
          
          expect(mockChrome.tabGroups.update).toHaveBeenCalledWith(
            expect.any(Number), 
            expect.objectContaining({ title: title })
          );
        }
      ),
      { numRuns: 50 }
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
            mkTab(rt.id, `https://${rt.domain}/${rt.path}`, -1, i)
          );

          const groupMap = service.buildGroupMap(tabs, rulesByDomain);
          const cache = new Map(tabs.map((t) => [t.id, t]));
          const states = service.buildGroupStates(groupMap, cache as any);

          states.forEach((s) => {
            if (s.tabIds.length < 2) return; 

            const firstTab = cache.get(s.tabIds[0]);
            const domain = service.getDomain(firstTab?.url);
            const rule = rulesByDomain[domain];

            if (rule) {
              const base = rule.groupName || domain;
              const url = firstTab?.url;
              const pathSegments = url ? new URL(url).pathname.split("/").filter(Boolean) : [];
              const canSplit = rule.splitByPath && pathSegments.length >= rule.splitByPath;

              if (canSplit) {
                expect(s.title).toContain(" - ");
                expect(s.title.startsWith(base)).toBe(true);
              } else {
                expect(s.title).toBe(base);
              }
            } else {
              expect(s.title).toBe(domain);
            }
          });
        }
      ),
      { numRuns: 100 }
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
          const groupsMetadata = new Map([[101, { id: 101, title: "Custom Group" } as any]]);

          // 2. Identification
          const protectedTabMeta = service.identifyProtectedTabs(tabs, groupsMetadata, rulesByDomain);
          expect(protectedTabMeta.size).toBe(3);

          // 3. Mapping
          const groupMap = service.buildGroupMap(tabs, rulesByDomain, groupsMetadata, protectedTabMeta);
          const cache = new Map(tabs.map(t => [t.id, t]));
          const states = service.buildGroupStates(groupMap, cache as any);

          // 4. Verification: The state MUST contain exactly 3 tabs and be marked external
          const state = states.find(s => s.title === "Custom Group");
          expect(state).toBeDefined();
          expect(state!.tabIds).toHaveLength(3);
          expect(state!.isExternal).toBe(true);

          // 5. Plan Verification
          const repositioned = service.calculateRepositionNeeds(states, cache as any);
          const plan = service.createGroupPlan(repositioned, cache as any);
          
          // If it needs to move, it must move all 3 tabs together
          plan.states.forEach(ps => {
            if (ps.displayName === "Custom Group") {
              expect(ps.tabIds).toHaveLength(3);
              expect(ps.isExternal).toBe(true);
            }
          });
        }
      ),
      { numRuns: 50 }
    );
  });
});
