import * as crypto from "node:crypto";

import { SyncStore, SyncStoreState } from "@/types";
import {
  TabGroupingService,
  WindowManagementService,
  isInternalTab,
} from "utils/grouping";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { currentGroups, currentTabs, mkTab, mockChrome } from "./test-utils";

import ChromeTabAdapter from "./ChromeTabAdapter";
import TabGroupingController from "./TabGroupingController";
import fc from "fast-check";

// ============================================================================
// ARBITRARIES
// ============================================================================

const domains = ["google.com", "github.com", "stackoverflow.com"];
const paths = ["/search", "/mail", "/docs", "/repo"];
const tabArb = fc.record({
  domain: fc.constantFrom(...domains),
  path: fc.constantFrom(...paths),
  pinned: fc.boolean(),
  windowId: fc.integer({ min: 1, max: 2 }),
});

describe("TabGroupingController Stability & Invariants (Snapshot-Based)", () => {
  let service: TabGroupingService;
  let windowService: WindowManagementService;
  let mockStore: SyncStore;

  beforeEach(() => {
    if (typeof globalThis.crypto === "undefined")
      (globalThis as any).crypto = crypto;
    service = new TabGroupingService();
    windowService = new WindowManagementService();
    mockStore = { getState: vi.fn() };

    // Reset global chrome mock
    vi.stubGlobal("chrome", mockChrome);

    // Clear global simulation state
    currentTabs.length = 0;
    currentGroups.clear();
  });

  it("Invariant: Pinned tabs and internal pages always come first", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(tabArb, { minLength: 5, maxLength: 20 }),
        async (rawTabs) => {
          // Setup tabs in the mock simulation
          currentTabs.push(
            ...rawTabs.map((t, i) =>
              mkTab(
                i + 1,
                `https://${t.domain}${t.path}`,
                -1,
                i,
                t.windowId,
                t.pinned,
              ),
            ),
          );

          vi.mocked(mockStore.getState).mockResolvedValue({
            rules: [],
            grouping: { byWindow: true },
          });

          const adapter = new ChromeTabAdapter();
          const controller = new TabGroupingController(
            service,
            windowService,
            adapter,
            mockStore,
          );
          await controller.execute();

          const tabs = await adapter.getNormalTabs();
          const windows = [...new Set(tabs.map((t) => t.windowId))];

          for (const wid of windows) {
            const wTabs = tabs
              .filter((t) => t.windowId === wid)
              .sort((a, b) => a.index - b.index);
            const pinIdxs = wTabs.filter((t) => t.pinned).map((t) => t.index);
            const internalIdxs = wTabs
              .filter((t) => isInternalTab(t))
              .map((t) => t.index);

            const lastPin = pinIdxs.length > 0 ? Math.max(...pinIdxs) : -1;
            internalIdxs.forEach((idx) => expect(idx).toBeGreaterThan(lastPin));
          }

          currentTabs.length = 0;
          currentGroups.clear();
        },
      ),
      { numRuns: 20 },
    );
  }, 60000);

  it("Invariant: splitByPath rules correctly group tabs by sub-path", async () => {
    const domain = "github.com";
    currentTabs.push(
      mkTab(1, `https://${domain}/project-a/file1`, -1, 0, 1),
      mkTab(2, `https://${domain}/project-a/file2`, -1, 1, 1),
      mkTab(3, `https://${domain}/project-b/file1`, -1, 2, 1),
    );

    vi.mocked(mockStore.getState).mockResolvedValue({
      rules: [
        {
          id: crypto.randomUUID(),
          domain: domain,
          splitByPath: 1,
          autoDelete: false,
        },
      ],
      grouping: { byWindow: false },
    });

    const adapter = new ChromeTabAdapter();
    const controller = new TabGroupingController(
      service,
      windowService,
      adapter,
      mockStore,
    );
    await controller.execute();

    const resolvedTabs = await adapter.getNormalTabs();
    const finalGroups = await adapter.getGroups();

    const projectAGroup = finalGroups.find((g) =>
      (g.title ?? "").includes("project-a"),
    );
    const projectBTab = resolvedTabs.find((t) => t.id === 3);

    expect(projectAGroup).toBeDefined();
    expect(resolvedTabs.find((t) => t.id === 1)?.groupId).toBe(
      projectAGroup!.id,
    );
    expect(resolvedTabs.find((t) => t.id === 2)?.groupId).toBe(
      projectAGroup!.id,
    );
    // Threshold rule: 1 tab should NOT be grouped
    expect(projectBTab?.groupId).toBe(-1);
  }, 60000);
});
