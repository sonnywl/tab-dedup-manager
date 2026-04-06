import {
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

import { TabGroupingService } from "./grouping";
import fc from "fast-check";
import { mkTab } from "../core/test-utils";

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
        mkTab(1, "https://github.com/project-a/1", 101),
        mkTab(2, "https://github.com/project-a/2", 101),
        mkTab(3, "https://github.com/project-b/1", 102), // Single tab for project-b segment
        mkTab(4, "https://google.com/search", 103), // Single tab for google.com
      ];

      const cache = new Map(tabs.map((t) => [asTabId(t.id)!, t]));
      const managedGroupIds = new Map([
        [101, "project-a - github.com"],
        [102, "project-b - github.com"],
        [103, "google.com"],
      ]);

      const groupMap = service.buildGroupMap(tabs, rulesByDomain);
      const states = service.buildGroupStates(
        groupMap,
        cache,
        new Map(),
        managedGroupIds,
      );

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

    it("should return true for empty title (scavenge mode)", () => {
      expect(service.isInternalTitle("", domain, undefined, rules)).toBe(true);
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
      const tab1 = mkTab(1, "https://a.com", 10, 1);
      const tab2 = mkTab(2, "https://b.com", 10, 0);
      const tabCache = new Map([
        [asTabId(1)!, tab1],
        [asTabId(2)!, tab2],
      ]);

      const groupStates: any[] = [
        {
          displayName: "a.com",
          sourceDomain: "a.com",
          tabIds: [asTabId(1)!, asTabId(2)!],
          groupId: 10,
          isExternal: false,
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
      const pinnedTab = mkTab(1, "https://google.com", 100, 0, 1, true);
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

    it("should INHERIT the groupId from an unnamed group to allow renaming instead of recreating", () => {
      const tab = mkTab(1, "https://google.com", 500);
      const groupIdToGroup = new Map([
        [500, { id: 500, title: "", collapsed: false } as any],
      ]);

      const groupMap = service.buildGroupMap([tab], {}, groupIdToGroup);
      const entry = groupMap.get("unpinned::google.com");
      expect(entry?.groupId).toBe(asGroupId(500));
    });
  });

  describe("Sorting & Hierarchy", () => {
    it("should sort splitByPath groups alphabetically by segment name", () => {
      const rulesByDomain: RulesByDomain = {
        "example.com": { domain: "example.com", splitByPath: 1 },
      };
      const tabs = [
        mkTab(1, "https://example.com/z/1"),
        mkTab(2, "https://example.com/z/2"),
        mkTab(3, "https://example.com/a/1"),
        mkTab(4, "https://example.com/a/2"),
      ];
      const cache = new Map(tabs.map((t) => [asTabId(t.id)!, t]));
      const groupMap = service.buildGroupMap(tabs, rulesByDomain);
      const states = service.buildGroupStates(groupMap, cache);
      const repositioned = service.calculateRepositionNeeds(states, cache);

      expect(repositioned[0].displayName).toBe("a - example.com");
      expect(repositioned[1].displayName).toBe("z - example.com");
    });

    it("should maintain hierarchy: Internal Pages -> Groups -> Single Tabs", () => {
      const rulesByDomain: RulesByDomain = {
        "managed.com": { domain: "managed.com" },
      };

      const tabs = [
        mkTab(1, "https://manual.com/1", 500),
        mkTab(2, "https://manual.com/2", 500), // Manual Group
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

      // Sorting: settings (Internal) < managed.com (M) < My Group (M) < other.com (Solo)
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
        mkTab(1, "https://google.com/1", 101),
        mkTab(2, "https://google.com/2", 101),
        mkTab(3, "edge://settings/appearance", -1, 2),
        mkTab(4, "edge://extensions/", -1, 3),
      ];

      const cache = new Map(tabs.map((t) => [asTabId(t.id)!, t]));
      const managedGroupIds = new Map([[101, "google.com"]]);

      const groupMap = service.buildGroupMap(tabs, rulesByDomain);
      const states = service.buildGroupStates(
        groupMap,
        cache,
        new Map(),
        managedGroupIds,
      );

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
                const t = mkTab(
                  tid,
                  `https://${r.domain}/${idx}/${i}`,
                  -1,
                  0,
                  1,
                  r.pinned,
                );
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
