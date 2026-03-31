import { describe, it, expect, beforeEach } from "vitest";
import { TabGroupingService } from "./grouping";
import { asDomain, RulesByDomain } from "../types";

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
    expect(service.isInternalTitle("google.com", domain, undefined, rules)).toBe(true);
    expect(service.isInternalTitle("GOOGLE.COM", domain, undefined, rules)).toBe(true);
  });

  it("should return true for domain with www. prefix", () => {
    expect(service.isInternalTitle("www.google.com", domain, undefined, rules)).toBe(true);
  });

  it("should return true for base name match if different from domain", () => {
    const customRules: RulesByDomain = {
      "google.com": { domain: "google.com", groupName: "Search" }
    };
    expect(service.isInternalTitle("Search", domain, undefined, customRules)).toBe(true);
    expect(service.isInternalTitle("search", domain, undefined, customRules)).toBe(true);
    expect(service.isInternalTitle("www.Search", domain, undefined, customRules)).toBe(true);
  });

  it("should return true for split-path variants (e.g., segment - base)", () => {
    const customRules: RulesByDomain = {
      "github.com": { domain: "github.com", splitByPath: 1 }
    };
    const ghDomain = asDomain("github.com");
    const url = "https://github.com/microsoft/vscode";
    
    // Expected title is "microsoft - github.com"
    expect(service.isInternalTitle("microsoft - github.com", ghDomain, url, customRules)).toBe(true);
    expect(service.isInternalTitle("MICROSOFT - GITHUB.COM", ghDomain, url, customRules)).toBe(true);
  });

  it("should return true for collision-resolved variants (ends with - base)", () => {
    expect(service.isInternalTitle("Random Site - google.com", domain, undefined, rules)).toBe(true);
  });

  it("should return true for variants starting with domain/base (e.g., domain - segment)", () => {
    expect(service.isInternalTitle("google.com - Search", domain, undefined, rules)).toBe(true);
    expect(service.isInternalTitle("google.com - anything", domain, undefined, rules)).toBe(true);
  });

  it("should return true for slash variants (e.g., domain/segment)", () => {
    expect(service.isInternalTitle("google.com/search", domain, undefined, rules)).toBe(true);
  });

  it("should return false for unrelated titles", () => {
    expect(service.isInternalTitle("My Custom Group", domain, undefined, rules)).toBe(false);
    expect(service.isInternalTitle("Work", domain, undefined, rules)).toBe(false);
  });
});
