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
    group: vi.fn(),
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
} from "./background";

// Helper to make a tab
const mkTab = (id: number, url: string, groupId = -1, index = 0): any => ({
  id,
  url,
  groupId,
  index,
  windowId: 1,
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

  beforeEach(() => {
    vi.clearAllMocks();
    service = new TabGroupingService();
  });

  it("Invariant: Manual groups are moved atomically (No ungrouping/functional modification)", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(tabArb, { minLength: 5, maxLength: 30 }),
        fc.array(ruleArb, { maxLength: 5 }),
        async (rawTabs, rules) => {
          const rulesByDomain: any = {};
          rules.forEach((r) => (rulesByDomain[r.domain] = r));

          // 1. Construct initial state with mixed managed and manual groups
          const tabs: any[] = [];
          const groupsMetadata = new Map<number, any>();
          let manualGroupId = 500;

          rawTabs.forEach((rt, i) => {
            let gid = -1;
            if (rt.isGrouped) {
              // Derive group type
              gid = rt.isManualTitle ? manualGroupId++ : 100;
              if (rt.isManualTitle) {
                // This title is manual because it doesn't match any internal patterns
                groupsMetadata.set(gid, { id: gid, title: "USER_CUSTOM_NAME" });
              } else {
                // This title is internal (matches the domain)
                groupsMetadata.set(gid, { id: gid, title: rt.domain });
              }
            }
            tabs.push(mkTab(rt.id, `https://${rt.domain}/${rt.path}`, gid, i));
          });

          // 2. Identify Protected Tab IDs
          const protectedTabIds = service.identifyProtectedTabs(
            tabs,
            groupsMetadata,
            rulesByDomain,
          );

          // 3. Build Map & States
          const groupMap = service.buildGroupMap(
            tabs,
            rulesByDomain,
            groupsMetadata,
            protectedTabIds,
          );
          const cache = new Map(tabs.map((t) => [t.id, t]));
          const states = service.buildGroupStates(groupMap, cache as any);

          // 4. Verification: External status must correctly identify manual groups
          states.forEach((s) => {
            if (s.isExternal) {
              // All tabs in an external state MUST be in the protected set
              s.tabIds.forEach((tid) => {
                expect(protectedTabIds.has(tid)).toBe(true);
              });
            }
          });

          // 5. Plan Verification: Atomic Movement Guarantee
          const withReposition = service.calculateRepositionNeeds(states, cache as any);
          const plan = service.createGroupPlan(withReposition, cache as any);

          plan.states.forEach((ps) => {
            if (ps.isExternal) {
              /**
               * CRITICAL INVARIANT: 
               * currentlyGrouped must be empty for external groups.
               * This ensures executeGroupPlan skips the 'ungroup' stage,
               * preventing the loss of the manual Group ID and title.
               */
              expect(ps.currentlyGrouped).toHaveLength(0);
            }
          });
        }
      ),
      { numRuns: 100 }
    );
  });

  it("Invariant: Managed group titles strictly follow rules or domain defaults", async () => {
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
            if (s.tabIds.length < 2) return; // Only verify titles for actual groups

            const firstTab = cache.get(s.tabIds[0]);
            const domain = service.getDomain(firstTab?.url);
            const rule = rulesByDomain[domain];

            if (rule) {
              const base = rule.groupName || domain;
              const url = firstTab?.url;
              const pathSegments = url ? new URL(url).pathname.split("/").filter(Boolean) : [];
              const canSplit = rule.splitByPath && pathSegments.length >= rule.splitByPath;

              if (canSplit) {
                // Pattern: "base - segment"
                expect(s.title).toContain(" - ");
                expect(s.title.startsWith(base)).toBe(true);
              } else {
                // Fallback to base
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
});
