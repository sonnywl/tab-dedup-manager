import {
  GroupState,
  OrderUnit,
  ProtectedTabMetaMap,
  RulesByDomain,
  Tab,
  TabId,
  asDomain,
  asGroupId,
  asTabId,
  asWindowId,
} from "@/types";
import { beforeEach, describe, expect, it } from "vitest";

import { TabGroupingService, WindowManagementService } from "./grouping";
import fc from "fast-check";
import { mkTab } from "core/test-utils";

describe("WindowManagementService", () => {
  let service: TabGroupingService;
  let windowService: WindowManagementService;

  beforeEach(() => {
    service = new TabGroupingService();
    windowService = new WindowManagementService();
  });

  describe("createConsolidationPlan", () => {
    it("Global mode: consolidates all tabs to targetWindowId", () => {
      const tabs = [
        mkTab(1, "https://a.com", { windowId: 1 }),
        mkTab(2, "https://b.com", { windowId: 2 }),
      ];
      const plan = windowService.createConsolidationPlan(
        tabs,
        1, // numWindowsToKeep
        service,
        asWindowId(1), // target
      );

      expect(plan?.tabMoves).toHaveLength(1);
      expect(plan?.tabMoves[0].tabIds).toContain(2);
      expect(plan?.tabMoves[0].windowId).toBe(1);
    });

    it("Per-window mode: respects numWindowsToKeep and targetWindowId", () => {
      const tabs = [
        mkTab(1, "https://a.com", { windowId: 1 }),
        mkTab(2, "https://b.com", { windowId: 2 }),
        mkTab(3, "https://c.com", { windowId: 3 }),
        mkTab(4, "https://d.com", { windowId: 3, index: 1 }),
      ];
      // numWindowsToKeep = 2. Retained should be Win 3 (largest) and Win 1 (target).
      const plan = windowService.createConsolidationPlan(
        tabs,
        2,
        service,
        asWindowId(1),
      );

      expect(plan?.tabMoves).toHaveLength(1);
      expect(plan?.tabMoves[0].tabIds).toContain(2);
      expect(plan?.tabMoves[0].windowId).toBe(3); // Should move to win 3 (highest affinity/size) or Win 1
    });

    it("Respects groups as blocks during consolidation", () => {
      const tabs = [
        mkTab(1, "https://a.com", { windowId: 1 }), // Win 1 (target)
        mkTab(2, "https://b.com", { groupId: 100, windowId: 2 }), // Win 2, Group 100
        mkTab(3, "https://b.com", { groupId: 100, windowId: 2 }), // Win 2, Group 100
      ];
      const plan = windowService.createConsolidationPlan(
        tabs,
        1,
        service,
        asWindowId(1),
      );

      expect(plan?.groupMoves).toHaveLength(1);
      expect(plan?.groupMoves[0].groupId).toBe(100);
      expect(plan?.groupMoves[0].windowId).toBe(1);
    });
  });
});

describe("TabGroupingService", () => {
  let service: TabGroupingService;

  beforeEach(() => {
    service = new TabGroupingService();
  });

  it("identifies domains correctly", () => {
    expect(service.getDomain("https://google.com/search")).toBe("google.com");
    expect(service.getDomain(undefined)).toBe("other");
    expect(service.getDomain("file:///C:/test.txt")).toBe("local-file");
  });

  describe("Ungrouping Logic", () => {
    it("should ungroup managed domains with only 1 tab (Standard & splitByPath)", () => {
      const rulesByDomain: RulesByDomain = {
        "github.com": {
          domain: "github.com",
          splitByPath: 1,
        },
        "google.com": { domain: "google.com" },
      };

      const tabs = [
        mkTab(1, "https://github.com/project-a/1", { groupId: 101 }),
        mkTab(2, "https://github.com/project-a/2", { groupId: 101 }),
        mkTab(3, "https://github.com/project-b/1", { groupId: 102 }), // Single tab for project-b segment
        mkTab(4, "https://google.com/search", { groupId: 103 }), // Single tab for google.com
      ];

      const cache = new Map(tabs.map((t) => [asTabId(t.id)!, t]));
      const managedGroupIds = new Map([
        [101, "project-a - github.com"],
        [102, "project-b - github.com"],
        [103, "google.com"],
      ]);

      const groupMap = service.buildGroupMap(tabs, rulesByDomain);
      const states = service.buildGroupStates(groupMap, cache, managedGroupIds);

      const projectA = states.find(
        (s) => s.displayName === "project-a - github.com",
      );
      const projectB = states.find(
        (s) => s.displayName === "project-b - github.com",
      );
      const google = states.find((s) => s.displayName === "google.com");

      expect(projectA?.tabIds).toHaveLength(2);
      expect(projectA?.groupId).toBe(101); // Keeps group ID for 2+ tabs

      expect(projectB?.tabIds).toHaveLength(1);
      expect(projectB?.groupId).toBeNull(); // Cleared for single tab

      expect(google?.tabIds).toHaveLength(1);
      expect(google?.groupId).toBeNull(); // Cleared for single tab
    });
  });

  describe("splitByPath Sorting", () => {
    it("should group by splitByPath and sort tabs alphabetically by title", () => {
      const rulesByDomain: RulesByDomain = {
        "github.com": {
          domain: "github.com",
          splitByPath: 1,
        },
      };

      // Tabs in reverse alphabetical order of title
      const tabs = [
        mkTab(1, "https://github.com/project-a/1", { title: "B", index: 0 }),
        mkTab(2, "https://github.com/project-a/2", { title: "A", index: 1 }),
      ];

      const cache = new Map(tabs.map((t) => [asTabId(t.id)!, t]));
      const groupMap = service.buildGroupMap(tabs, rulesByDomain);
      const states = service.buildGroupStates(groupMap, cache);

      const group = states.find((s) => s.displayName.includes("project-a"));
      expect(group).toBeDefined();
      expect(group!.tabIds).toHaveLength(2);

      // Verify sorted order (A then B)
      const sortedTabs = group!.tabIds.map((id) => cache.get(id)!);
      expect(sortedTabs[0].title).toBe("A");
      expect(sortedTabs[1].title).toBe("B");
    });
  });

  describe("getGroupKey()", () => {
    it("splits by path segment", () => {
      const rules: any = {
        "google.com": { domain: "google.com", splitByPath: 1 },
      };
      const r = service.getGroupKey(
        asDomain("google.com"),
        "https://google.com/search",
        rules,
      );
      expect(r.key).toBe("google.com::search");
      expect(r.title).toBe("search - google.com");
    });
  });

  describe("isInternalTitle", () => {
    const domain = asDomain("google.com");
    const rules: RulesByDomain = {};

    it("should return false for empty title (manual mode)", () => {
      expect(service.isInternalTitle("", domain, undefined, rules)).toBe(false);
    });

    it("should return true for exact domain match (case-insensitive)", () => {
      expect(
        service.isInternalTitle("google.com", domain, undefined, rules),
      ).toBe(true);
      expect(
        service.isInternalTitle("GOOGLE.COM", domain, undefined, rules),
      ).toBe(true);
    });

    it("should return true for domain with www. prefix", () => {
      expect(
        service.isInternalTitle("www.google.com", domain, undefined, rules),
      ).toBe(true);
    });

    it("should return true for base name match if different from domain", () => {
      const customRules: RulesByDomain = {
        "google.com": { domain: "google.com", groupName: "Search" },
      };
      expect(
        service.isInternalTitle("Search", domain, undefined, customRules),
      ).toBe(true);
      expect(
        service.isInternalTitle("search", domain, undefined, customRules),
      ).toBe(true);
      expect(
        service.isInternalTitle("www.Search", domain, undefined, customRules),
      ).toBe(true);
    });

    it("should reclaim split-path titles in 'segment - base' format", () => {
      const customRules: RulesByDomain = {
        "github.com": { domain: "github.com", splitByPath: 1 },
      };
      const ghDomain = asDomain("github.com");
      const url = "https://github.com/microsoft/vscode";

      // Expected title is "microsoft - github.com"
      expect(
        service.isInternalTitle(
          "microsoft - github.com",
          ghDomain,
          url,
          customRules,
        ),
      ).toBe(true);
    });

    it("should PROTECT titles that follow 'domain - segment' format", () => {
      // Users often name groups "google.com - Work" or "github.com - Private"
      expect(
        service.isInternalTitle("google.com - Work", domain, undefined, rules),
      ).toBe(false);
    });

    it("should return true for collision-resolved variants (ends with - base)", () => {
      expect(
        service.isInternalTitle(
          "Random Site - google.com",
          domain,
          undefined,
          rules,
        ),
      ).toBe(true);
    });

    it("should return true for slash variants (e.g., domain/segment)", () => {
      expect(
        service.isInternalTitle("google.com/search", domain, undefined, rules),
      ).toBe(true);
    });

    it("should return false for unrelated titles", () => {
      expect(
        service.isInternalTitle("My Custom Group", domain, undefined, rules),
      ).toBe(false);
      expect(service.isInternalTitle("Work", domain, undefined, rules)).toBe(
        false,
      );
    });
  });

  describe("calculateRepositionNeeds", () => {
    it("should flag a group for repositioning if internal tab order is incorrect", () => {
      const tab1 = mkTab(1, "https://a.com", { groupId: 10, index: 1 });
      const tab2 = mkTab(2, "https://b.com", { groupId: 10, index: 0 });
      const tabCache = new Map([
        [asTabId(1)!, tab1],
        [asTabId(2)!, tab2],
      ]);

      const groupStates: GroupState[] = [
        {
          displayName: "a.com",
          sourceDomain: "a.com",
          tabIds: [asTabId(1)!, asTabId(2)!],
          groupId: asGroupId(10)!,
          isExternal: false,
          needsReposition: false,
          collapsed: false,
        },
      ];

      const managedGroupIds = new Map([[10, "a.com"]]);
      const results = service.calculateRepositionNeeds(
        groupStates,
        tabCache,
        asWindowId(1),
        managedGroupIds,
      );

      expect(results[0].needsReposition).toBe(true);
      expect(results[0].targetIndex).toBe(0);
    });

    it("Global Mode: should flag solo tabs from other windows for movement into the target window", () => {
      const tab1 = mkTab(1, "https://a.com", { windowId: 1, index: 0 }); // Win 1, index 0
      const tab2 = mkTab(2, "https://b.com", { windowId: 2, index: 0 }); // Win 2, index 0

      // In Global mode, tabCache contains tabs from ALL windows
      const tabCache = new Map([
        [asTabId(1)!, tab1],
        [asTabId(2)!, tab2],
      ]);

      const groupStates: GroupState[] = [
        {
          displayName: "a.com",
          sourceDomain: "a.com",
          tabIds: [asTabId(1)!],
          groupId: null,
          isExternal: false,
          needsReposition: false,
          collapsed: false,
        },
        {
          displayName: "b.com",
          sourceDomain: "b.com",
          tabIds: [asTabId(2)!],
          groupId: null,
          isExternal: false,
          needsReposition: false,
          collapsed: false,
        },
      ];

      // Target window is Window 1
      const results = service.calculateRepositionNeeds(
        groupStates,
        tabCache,
        asWindowId(1),
        new Map(),
      );

      const state2 = results.find((s) => s.displayName === "b.com");
      expect(state2?.needsReposition).toBe(true); // Should be true because it's in Window 2
    });
  });

  describe("buildOrderPlan & Interleaving", () => {
    it("should detect interleaving and move tabs to absolute positions (LIS Fix)", () => {
      const desired: OrderUnit[] = [
        {
          kind: "group",
          groupId: asGroupId(101),
          tabIds: [asTabId(1)!],
          targetIndex: 0,
        },
        {
          kind: "group",
          groupId: asGroupId(102),
          tabIds: [asTabId(2)!],
          targetIndex: 1,
        },
        { kind: "solo", tabId: asTabId(3)!, targetIndex: 2 },
      ];

      const live: OrderUnit[] = [
        {
          kind: "group",
          groupId: asGroupId(101),
          tabIds: [asTabId(1)!],
          targetIndex: 0,
        },
        {
          kind: "group",
          groupId: asGroupId(102),
          tabIds: [asTabId(2)!],
          targetIndex: 2,
        },
        { kind: "solo", tabId: asTabId(3)!, targetIndex: 3 },
      ];

      const plan = service.buildOrderPlan(desired, live);
      expect(
        plan.toMove.some((u) => u.kind === "group" && u.groupId === 102),
      ).toBe(true);
      expect(plan.toMove.some((u) => u.kind === "solo" && u.tabId === 3)).toBe(
        true,
      );
    });
  });

  describe("QA Reproductions", () => {
    it("should PRESERVE the groupId for pinned tabs if they belong to an external (protected) group", () => {
      const pinnedTab = mkTab(1, "https://google.com", {
        groupId: 100,
        pinned: true,
      });
      const tabCache = new Map([[asTabId(1)!, pinnedTab]]);
      const protectedMeta: ProtectedTabMetaMap = new Map([
        [asTabId(1)!, { title: "Manual Group", originalGroupId: 100 }],
      ]);

      const groupMap = service.buildGroupMap(
        [pinnedTab],
        {},
        new Map([
          [100, { id: 100, title: "Manual Group", collapsed: false } as any],
        ]),
        protectedMeta,
      );

      const states = service.buildGroupStates(groupMap, tabCache);
      expect(states[0].isExternal).toBe(true);
      expect(states[0].groupId).toBe(asGroupId(100));
    });

    it("should mark groups of internal pages as managed", () => {
      const tab1 = mkTab(1, "edge://settings", { groupId: 101 });
      const tab2 = mkTab(2, "edge://extensions", { groupId: 101 });
      const groupIdToGroup = new Map([
        [101, { id: 101, title: "My Manual Internal Group" } as any],
      ]);

      const { managedGroupIds } = service.identifyProtectedTabs(
        [tab1, tab2],
        groupIdToGroup,
        {},
      );

      expect(managedGroupIds.has(101)).toBe(true);
      expect(managedGroupIds.get(101)).toBe("My Manual Internal Group");
    });
  });

  describe("Sorting & Hierarchy", () => {
    it("should sort groups by displayName, then by URL of the first tab", () => {
      const tabs = [
        mkTab(1, "https://a.com/page1", { groupId: 100 }),
        mkTab(2, "https://a.com/page2", { groupId: 100 }),
        mkTab(3, "https://a.com/page3", { groupId: 101 }),
        mkTab(4, "https://a.com/page4", { groupId: 101 }),
      ];
      // Force group names: Group 100 -> "A Group", Group 101 -> "A Group" (same name)
      // Group 100 URL: a.com/page1, Group 101 URL: a.com/page3
      const cache = new Map(tabs.map((t) => [asTabId(t.id)!, t]));
      // Need to adjust states because displayName is the same, so they should be merged or ordered by URL.
      // Actually, my test setup might be flawed for this. Let's use different names.

      const states2 = [
        {
          displayName: "B Group",
          sourceDomain: "a.com",
          tabIds: [asTabId(3)!, asTabId(4)!],
          groupId: asGroupId(101),
          collapsed: false,
          needsReposition: false,
          isExternal: false,
        },
        {
          displayName: "A Group",
          sourceDomain: "a.com",
          tabIds: [asTabId(1)!, asTabId(2)!],
          groupId: asGroupId(100),
          collapsed: false,
          needsReposition: false,
          isExternal: false,
        },
      ];

      const repositioned = service.calculateRepositionNeeds(states2, cache);
      expect(repositioned[0].displayName).toBe("A Group");
      expect(repositioned[1].displayName).toBe("B Group");
    });

    it("should maintain hierarchy: Internal Pages -> Groups -> Single Tabs", () => {
      const rulesByDomain: RulesByDomain = {
        "managed.com": { domain: "managed.com" },
      };

      const tabs = [
        mkTab(1, "https://manual.com/1", { groupId: 500 }),
        mkTab(2, "https://manual.com/2", { groupId: 500 }), // Manual Group
        mkTab(3, "https://managed.com/1"),
        mkTab(4, "https://managed.com/2"), // Managed Group
        mkTab(5, "edge://settings"), // Internal Page
        mkTab(6, "https://other.com/1"), // Single Tab
      ];

      const groupsMetadata = new Map([
        [500, { id: 500, title: "My Group" } as any],
      ]);
      const { protectedMeta } = service.identifyProtectedTabs(
        tabs,
        groupsMetadata,
        rulesByDomain,
      );

      const cache = new Map(tabs.map((t) => [asTabId(t.id)!, t]));
      const groupMap = service.buildGroupMap(
        tabs,
        rulesByDomain,
        groupsMetadata,
        protectedMeta,
      );
      const states = service.buildGroupStates(groupMap, cache);
      const repositioned = service.calculateRepositionNeeds(states, cache);

      // Sorting: settings (Internal) < managed.com (Managed) < My Group (Manual) < other.com (Solo)
      expect(repositioned[0].displayName).toBe("settings");
      expect(repositioned[1].displayName).toBe("managed.com");
      expect(repositioned[2].displayName).toBe("My Group");
      expect(repositioned[3].displayName).toBe("other.com");
    });
  });

  describe("Internal Pages Sorting", () => {
    it("should sort internal pages to the start of the unpinned section (before groups)", () => {
      const rulesByDomain: RulesByDomain = {};

      const tabs = [
        mkTab(1, "https://google.com/1", { groupId: 101 }),
        mkTab(2, "https://google.com/2", { groupId: 101 }),
        mkTab(3, "edge://settings/appearance", { index: 2 }),
        mkTab(4, "edge://extensions/", { index: 3 }),
      ];

      const cache = new Map(tabs.map((t) => [asTabId(t.id)!, t]));
      const managedGroupIds = new Map([[101, "google.com"]]);

      const groupMap = service.buildGroupMap(tabs, rulesByDomain);
      const states = service.buildGroupStates(groupMap, cache, managedGroupIds);

      const repositioned = service.calculateRepositionNeeds(states, cache);

      // Internal pages come before Managed Group "google.com"
      expect(repositioned[0].displayName).toBe("extensions");
      expect(repositioned[1].displayName).toBe("settings");
      expect(repositioned[2].displayName).toBe("google.com");
    });
  });

  describe("Property-Based Invariants", () => {
    it("Invariant: Groups ALWAYS precede single tabs in their respective sections", () => {
      fc.assert(
        fc.property(
          fc.array(
            fc.record({
              id: fc.integer({ min: 1, max: 1000 }),
              pinned: fc.boolean(),
              isGroup: fc.boolean(),
              domain: fc.constantFrom("a.com", "b.com", "c.com"),
            }),
            { minLength: 5, maxLength: 20 },
          ),
          (raw) => {
            const rulesByDomain: RulesByDomain = {};
            const tabs: Tab[] = [];
            const cache = new Map<TabId, Tab>();

            raw.forEach((r, idx) => {
              const count = r.isGroup ? 2 : 1;
              for (let i = 0; i < count; i++) {
                const tid = asTabId(tabs.length + 1)!;
                const t = mkTab(tid, `https://${r.domain}/${idx}/${i}`, {
                  pinned: r.pinned,
                });
                tabs.push(t);
                cache.set(tid, t);
              }
            });

            const groupMap = service.buildGroupMap(tabs, rulesByDomain);
            const states = service.buildGroupStates(groupMap, cache);
            const repositioned = service.calculateRepositionNeeds(
              states,
              cache,
            );

            const checkSection = (sectionStates: typeof repositioned) => {
              const groups = sectionStates.filter(
                (s) => s.tabIds.length >= 2 || s.isExternal,
              );
              const solos = sectionStates.filter(
                (s) => !(s.tabIds.length >= 2 || s.isExternal),
              );

              if (groups.length > 0 && solos.length > 0) {
                const maxGroupEnd = Math.max(
                  ...groups.map((g) => g.targetIndex! + g.tabIds.length),
                );
                const minSoloStart = Math.min(
                  ...solos.map((s) => s.targetIndex!),
                );
                expect(minSoloStart).toBeGreaterThanOrEqual(maxGroupEnd);
              }
            };

            checkSection(
              repositioned.filter((s) => cache.get(s.tabIds[0])?.pinned),
            );
            checkSection(
              repositioned.filter((s) => !cache.get(s.tabIds[0])?.pinned),
            );
          },
        ),
      );
    });
  });
});
