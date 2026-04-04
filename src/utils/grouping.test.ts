import { describe, it, expect, beforeEach } from "vitest";
import { TabGroupingService } from "./grouping";
import { asDomain, asWindowId, RulesByDomain } from "../types";

describe("TabGroupingService.isInternalTitle", () => {
  let service: TabGroupingService;
  const domain = asDomain("google.com");
  const rules: RulesByDomain = {};

  beforeEach(() => {
    service = new TabGroupingService();
  });

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

  it("should return true for split-path variants (e.g., segment - base)", () => {
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
    expect(
      service.isInternalTitle(
        "MICROSOFT - GITHUB.COM",
        ghDomain,
        url,
        customRules,
      ),
    ).toBe(true);
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

  it("should return true for variants starting with domain/base (e.g., domain - segment)", () => {
    expect(
      service.isInternalTitle("google.com - Search", domain, undefined, rules),
    ).toBe(true);
    expect(
      service.isInternalTitle(
        "google.com - anything",
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

describe("TabGroupingService.calculateRepositionNeeds", () => {
  let service: TabGroupingService;

  beforeEach(() => {
    service = new TabGroupingService();
  });

  const mkTab = (
    id: number,
    url: string,
    groupId: number = -1,
    index: number = 0,
    windowId: number = 1,
  ): any => ({
    id,
    url,
    groupId,
    index,
    windowId,
    pinned: false,
  });

  it("should flag a group for repositioning if internal tab order is incorrect", () => {
    // Correct Order (by URL): a.com (ID: 1), b.com (ID: 2)
    // Current Live State: b.com is at index 0, a.com is at index 1
    const tab1 = mkTab(1, "https://a.com", 10, 1);
    const tab2 = mkTab(2, "https://b.com", 10, 0);
    const tabCache = new Map([
      [1, tab1],
      [2, tab2],
    ]);

    const groupStates: any[] = [
      {
        displayName: "a.com",
        sourceDomain: "a.com",
        tabIds: [1, 2], // Desired internal order: 1 then 2
        groupId: 10,
        isExternal: false,
      },
    ];

    const managedGroupIds = new Map([[10, "a.com"]]);
    const results = service.calculateRepositionNeeds(
      groupStates,
      tabCache as any,
      asWindowId(1),
      managedGroupIds,
    );

    expect(results[0].needsReposition).toBe(true);
    expect(results[0].targetIndex).toBe(0);
  });

  it("should NOT flag a group if order and position are correct", () => {
    const tab1 = mkTab(1, "https://a.com", 10, 0);
    const tab2 = mkTab(2, "https://b.com", 10, 1);
    const tabCache = new Map([
      [1, tab1],
      [2, tab2],
    ]);

    const groupStates: any[] = [
      {
        displayName: "a.com",
        sourceDomain: "a.com",
        tabIds: [1, 2],
        groupId: 10,
        isExternal: false,
      },
    ];

    const managedGroupIds = new Map([[10, "a.com"]]);
    const results = service.calculateRepositionNeeds(
      groupStates,
      tabCache as any,
      asWindowId(1),
      managedGroupIds,
    );

    expect(results[0].needsReposition).toBe(false);
    expect(results[0].targetIndex).toBe(0);
  });
});
