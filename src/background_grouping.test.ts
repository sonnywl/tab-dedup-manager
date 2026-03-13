import {
  RulesByDomain,
  Tab,
  TabGroupingService,
  TabId,
  asTabId,
} from "./utils/grouping";
import { beforeEach, describe, expect, it } from "vitest";

import fc from "fast-check";
import { mkTab } from "./test-utils";

describe("TabGroupingService - Comprehensive Logic Tests", () => {
  let service: TabGroupingService;

  beforeEach(() => {
    service = new TabGroupingService();
  });

  describe("Ungrouping Logic", () => {
    it("should ungroup managed domains with only 1 tab (Standard & splitByPath)", () => {
      const rulesByDomain: RulesByDomain = {
        "github.com": {
          domain: "github.com",
          splitByPath: 1,
          autoDelete: false,
        },
        "google.com": { domain: "google.com", autoDelete: false },
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

  describe("Sorting & Hierarchy", () => {
    it("should sort splitByPath groups alphabetically by segment name", () => {
      const rulesByDomain: RulesByDomain = {
        "example.com": {
          domain: "example.com",
          splitByPath: 1,
          autoDelete: false,
        },
      };

      const tabs = [
        mkTab(1, "https://example.com/z/1"),
        mkTab(2, "https://example.com/z/2"),
        mkTab(3, "https://example.com/a/1"),
        mkTab(4, "https://example.com/a/2"),
        mkTab(5, "https://example.com/m/1"),
        mkTab(6, "https://example.com/m/2"),
      ];

      const cache = new Map(tabs.map((t) => [asTabId(t.id)!, t]));
      const groupMap = service.buildGroupMap(tabs, rulesByDomain);
      const states = service.buildGroupStates(
        groupMap,
        cache,
        new Map(),
        new Map(),
      );
      const repositioned = service.calculateRepositionNeeds(states, cache);

      expect(repositioned[0].displayName).toBe("a - example.com");
      expect(repositioned[1].displayName).toBe("m - example.com");
      expect(repositioned[2].displayName).toBe("z - example.com");
    });

    it("should enforce hierarchy: Manual Groups -> Managed Groups -> Single Tabs", () => {
      const rulesByDomain: RulesByDomain = {
        "managed.com": { domain: "managed.com", autoDelete: false },
      };

      const tabs = [
        mkTab(1, "https://manual.com/1", 500),
        mkTab(2, "https://manual.com/2", 500), // Manual Group
        mkTab(3, "https://managed.com/1"),
        mkTab(4, "https://managed.com/2"), // Managed Group
        mkTab(5, "https://other.com/1"), // Single Tab
      ];

      const groupsMetadata = new Map([
        [500, { id: 500, title: "My Group" } as chrome.tabGroups.TabGroup],
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
      const states = service.buildGroupStates(
        groupMap,
        cache,
        new Map(),
        new Map(),
      );
      const repositioned = service.calculateRepositionNeeds(states, cache);

      // New sorting logic interleaves Manual and Managed groups by Title/URL.
      // "managed.com" < "My Group" (alphabetical)
      expect(repositioned[0].displayName).toBe("managed.com"); // Managed
      expect(repositioned[1].displayName).toBe("My Group"); // Manual
      expect(repositioned[2].displayName).toBe("other.com"); // Single Tab
    });

    it("should maintain independent hierarchies in Pinned and Unpinned sections", () => {
      const rulesByDomain: RulesByDomain = {
        "a.com": { domain: "a.com", autoDelete: false },
        "b.com": { domain: "b.com", autoDelete: false },
      };

      const tabs = [
        mkTab(1, "https://a.com/1", -1, 0, 1, true),
        mkTab(2, "https://a.com/2", -1, 1, 1, true), // Pinned Group
        mkTab(3, "https://b.com/1", -1, 2, 1, true), // Pinned Tab
        mkTab(4, "https://a.com/3", -1, 3, 1, false),
        mkTab(5, "https://a.com/4", -1, 4, 1, false), // Unpinned Group
        mkTab(6, "https://b.com/2", -1, 5, 1, false), // Unpinned Tab
      ];

      const cache = new Map(tabs.map((t) => [asTabId(t.id)!, t]));
      const groupMap = service.buildGroupMap(tabs, rulesByDomain);
      const states = service.buildGroupStates(
        groupMap,
        cache,
        new Map(),
        new Map(),
      );
      const repositioned = service.calculateRepositionNeeds(states, cache);

      // Indices:
      // 0-1: Pinned Group (a.com)
      // 2: Pinned Tab (b.com)
      // 3-4: Unpinned Group (a.com)
      // 5: Unpinned Tab (b.com)
      expect(
        repositioned.find(
          (s) => s.displayName === "a.com" && s.tabIds.includes(asTabId(1)!),
        )!.targetIndex,
      ).toBe(0);
      expect(
        repositioned.find(
          (s) => s.displayName === "b.com" && s.tabIds.includes(asTabId(3)!),
        )!.targetIndex,
      ).toBe(2);
      expect(
        repositioned.find(
          (s) => s.displayName === "a.com" && s.tabIds.includes(asTabId(4)!),
        )!.targetIndex,
      ).toBe(3);
      expect(
        repositioned.find(
          (s) => s.displayName === "b.com" && s.tabIds.includes(asTabId(6)!),
        )!.targetIndex,
      ).toBe(5);
    });
  });

  describe("Property-Based Invariants", () => {
    it("Invariant: Groups (Visual) ALWAYS precede single tabs in their respective sections", () => {
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

            // To simulate groups, if isGroup is true, we add 2 tabs for that domain
            raw.forEach((r) => {
              const count = r.isGroup ? 2 : 1;
              for (let i = 0; i < count; i++) {
                const tid = asTabId(tabs.length + 1)!;
                const t = mkTab(
                  tid,
                  `https://${r.domain}/${i}`,
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
            const states = service.buildGroupStates(
              groupMap,
              cache,
              new Map(),
              new Map(),
            );
            const repositioned = service.calculateRepositionNeeds(
              states,
              cache,
            );

            const checkSection = (sectionStates: typeof repositioned) => {
              const groupIndices = sectionStates
                .filter((s) => s.tabIds.length >= 2 || s.isExternal)
                .map((s) => s.targetIndex!);
              const tabIndices = sectionStates
                .filter((s) => !(s.tabIds.length >= 2 || s.isExternal))
                .map((s) => s.targetIndex!);

              if (groupIndices.length > 0 && tabIndices.length > 0) {
                const minTabIdx = Math.min(...tabIndices);
                const maxGroupIdx = Math.max(...groupIndices);
                // Since targetIndex is the START of the group, we need to ensure minTabIdx >= maxGroupIdx + length
                const lastGroup = sectionStates
                  .filter((s) => s.tabIds.length >= 2 || s.isExternal)
                  .sort((a, b) => b.targetIndex! - a.targetIndex!)[0];
                expect(minTabIdx).toBeGreaterThanOrEqual(
                  lastGroup.targetIndex! + lastGroup.tabIds.length,
                );
              }
            };

            const pinned = repositioned.filter(
              (s) => cache.get(s.tabIds[0])?.pinned,
            );
            const unpinned = repositioned.filter(
              (s) => !cache.get(s.tabIds[0])?.pinned,
            );

            checkSection(pinned);
            checkSection(unpinned);
          },
        ),
      );
    });

    it("Invariant: Manual groups are recognized as external and preserve their title", () => {
      fc.assert(
        fc.property(
          fc.string({ minLength: 1 }),
          fc.integer({ min: 1, max: 1000 }),
          (title, gid) => {
            const rulesByDomain: RulesByDomain = {};
            const tabs = [
              mkTab(1, "https://random.com/1", gid),
              mkTab(2, "https://random.com/2", gid),
            ];
            const groupsMetadata = new Map([
              [gid, { id: gid, title } as chrome.tabGroups.TabGroup],
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
            const states = service.buildGroupStates(
              groupMap,
              cache,
              new Map(),
              new Map(),
            );

            const manual = states.find((s) => s.isExternal);
            expect(manual).toBeDefined();
            expect(manual?.displayName).toBe(title);
          },
        ),
      );
    });
  });
});
