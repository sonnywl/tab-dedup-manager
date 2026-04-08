import {
  ConsolidationPlan,
  MembershipPlan,
  OrderPlan,
  Result,
  RulesByDomain,
  Tab,
  TabId,
  WindowId,
  asTabId,
  isDefined,
  isInternalTab,
} from "@/types";

import { TabGroupingService } from "utils/grouping";

// ============================================================================
// UTILITIES
// ============================================================================

export function debounce<T extends (...args: any[]) => any>(
  fn: T,
  delay: number,
) {
  let t: ReturnType<typeof setTimeout> | undefined;
  return (...args: Parameters<T>) => {
    if (t) clearTimeout(t);
    t = setTimeout(() => fn(...args), delay);
  };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function retry<T>(
  fn: () => Promise<T>,
  maxAttempts = 3,
  delayMs = 100,
  isRetriable: (err: Error) => boolean = () => true,
): Promise<Result<T, Error>> {
  let lastError: unknown;
  for (let i = 1; i <= maxAttempts; i++) {
    try {
      return { success: true, value: await fn() };
    } catch (err) {
      lastError = err;
      const error =
        err instanceof Error ? err : new Error(String(err || "Retry failed"));
      if (i < maxAttempts && isRetriable(error)) {
        console.warn(
          `[Retry] Attempt ${i}/${maxAttempts} failed, retrying in ${delayMs * i}ms...`,
        );
        await new Promise((r) => setTimeout(r, delayMs * i));
      } else {
        break;
      }
    }
  }
  const finalError =
    lastError instanceof Error
      ? lastError
      : new Error(String(lastError || "Retry failed"));
  console.error(
    `[Retry] All ${maxAttempts} attempts failed or non-retriable. Final error:`,
    finalError.message,
    finalError.stack,
  );
  return { success: false, error: finalError };
}

async function bestEffortRollback(snapshotTabs: Tab[]): Promise<void> {
  console.warn("Rolling back (best-effort ungroup only)...");
  try {
    const current = new Map(
      (await chrome.tabs.query({})).map((t) => [t.id, t]),
    );
    for (const snap of snapshotTabs) {
      if (!snap.id) continue;
      const cur = current.get(snap.id);
      if (cur && snap.groupId !== cur.groupId && snap.groupId === -1)
        await chrome.tabs.ungroup([snap.id]).catch(() => {});
    }
  } catch (err) {
    console.error("Rollback failed:", err);
  }
}

/**
 * Higher-order utility to run an async operation with retry,
 * automatic rollback on failure, and success delay.
 */
export async function runAtomicOperation<T>(
  operation: () => Promise<T>,
  snapshotTabs: Tab[],
  delayMs: number,
): Promise<T> {
  const res = await retry(operation);
  if (res.success === false) {
    console.error(
      "Atomic operation failed, triggering rollback. Error:",
      res.error.message,
      res.error.stack,
    );
    await bestEffortRollback(snapshotTabs);
    throw res.error;
  }
  await sleep(delayMs);
  return res.value;
}

function validateTab(tab: unknown): tab is Tab {
  return (
    typeof tab === "object" &&
    tab !== null &&
    "id" in tab &&
    (tab.id === undefined || typeof tab.id === "number") &&
    "url" in tab &&
    (tab.url === undefined || typeof tab.url === "string")
  );
}

// ============================================================================
// INFRASTRUCTURE LAYER
// ============================================================================

export default class ChromeTabAdapter {
  private readonly MAX_BATCH = 100;
  private readonly RATE_DELAY = 50;

  /**
   * Provides a window for the browser to settle its internal tab state (indices, group memberships)
   * before the next phase of the grouping pipeline.
   */
  async settle(): Promise<void> {
    await sleep(150);
  }

  async getNormalTabs(): Promise<Tab[]> {
    const result = await retry(async () => {
      const tabs = await chrome.tabs.query({ windowType: "normal" });
      const selfBase = chrome.runtime.getURL(""); // e.g. chrome-extension://[id]/

      return tabs.filter((t) => {
        if (!validateTab(t) || !t.url) return false;

        // Exclude the extension's OWN internal pages (options/popup)
        if (t.url.startsWith(selfBase)) return false;

        // Mandate: DO NOT exclude system/browser internal pages anymore.
        // We want to manage their sorting (to the front).
        return true;
      });
    });
    if (result.success === false) {
      console.error("Failed to get tabs:", result.error);
      return [];
    }
    return result.value;
  }

  async deduplicateAllTabs(tabs: Tab[]): Promise<Tab[]> {
    const seen = new Set<string>();
    const unique: Tab[] = [];
    const dupes: TabId[] = [];

    for (const tab of tabs) {
      if (tab.url && !seen.has(tab.url)) {
        seen.add(tab.url);
        unique.push(tab);
      } else if (tab.id) {
        dupes.push(asTabId(tab.id)!);
      } else {
        unique.push(tab);
      }
    }

    for (const batch of this.batch(dupes)) {
      const r = await retry(async () => {
        await chrome.tabs.remove(batch as number[]);
      });
      if (r.success === false)
        console.warn("Failed to remove duplicates:", r.error);
      await sleep(this.RATE_DELAY);
    }

    return unique;
  }

  async cleanupTabsByRules(
    tabs: Tab[],
    rulesByDomain: RulesByDomain,
    service: TabGroupingService,
  ): Promise<Tab[]> {
    const toDelete: TabId[] = [];
    const remaining: Tab[] = [];

    for (const tab of tabs) {
      const domain = service.getDomain(tab.url);
      const rule = rulesByDomain[domain];

      if (rule?.autoDelete && tab.id) {
        toDelete.push(asTabId(tab.id)!);
      } else {
        remaining.push(tab);
      }
    }

    for (const batch of this.batch(toDelete)) {
      const r = await retry(async () => {
        await chrome.tabs.remove(batch as number[]);
      });
      if (r.success === false) console.warn("Failed to auto-delete:", r.error);
      await sleep(this.RATE_DELAY);
    }

    return remaining;
  }

  async moveInternalTabsToStart(tabs: Tab[]): Promise<Tab[]> {
    const windowMap = new Map<number, Tab[]>();
    for (const tab of tabs) {
      if (tab.windowId === undefined) continue;
      if (!windowMap.has(tab.windowId)) windowMap.set(tab.windowId, []);
      windowMap.get(tab.windowId)!.push(tab);
    }

    for (const [_, wTabs] of windowMap.entries()) {
      const internalUnpinned = wTabs.filter(
        (t) => isInternalTab(t) && !t.pinned,
      );
      if (internalUnpinned.length === 0) continue;

      // Stable sort by URL
      internalUnpinned.sort((a, b) => (a.url || "").localeCompare(b.url || ""));

      // Target starting index: after all pinned tabs in this window
      const pinnedCount = wTabs.filter((t) => t.pinned).length;
      let targetIndex = pinnedCount;

      for (const tab of internalUnpinned) {
        if (tab.id && tab.index !== targetIndex) {
          const r = await retry(() =>
            chrome.tabs.move(tab.id as number, { index: targetIndex }),
          );
          if (r.success) {
            // Update local index to reflect move for subsequent iterations
            tab.index = targetIndex;
          }
          await sleep(this.RATE_DELAY);
        }
        targetIndex++;
      }
    }

    return tabs;
  }

  async ungroupSingleTabGroups(
    tabs: Tab[],
    service: TabGroupingService,
    rulesByDomain: RulesByDomain,
  ): Promise<void> {
    const groupCounts = new Map<number, number>();
    const groupIds = new Set<number>();
    for (const tab of tabs) {
      if (tab.groupId !== -1 && tab.groupId !== undefined) {
        groupCounts.set(tab.groupId, (groupCounts.get(tab.groupId) || 0) + 1);
        groupIds.add(tab.groupId);
      }
    }

    const groups = await chrome.tabGroups.query({});
    const groupIdToGroup = new Map(groups.map((g) => [g.id, g]));

    const { managedGroupIds } = service.identifyProtectedTabs(
      tabs,
      groupIdToGroup,
      rulesByDomain,
    );

    const toUngroup: number[] = [];
    for (const tab of tabs) {
      if (tab.id && tab.groupId !== -1 && tab.groupId !== undefined) {
        if (
          groupCounts.get(tab.groupId) === 1 &&
          managedGroupIds.has(tab.groupId)
        ) {
          toUngroup.push(tab.id);
        }
      }
    }

    for (const batch of this.batch(toUngroup)) {
      if (batch.length === 0) continue;
      await retry(async () => {
        await chrome.tabs.ungroup(
          batch.length === 1 ? batch[0] : (batch as [number, ...number[]]),
        );
      });
      await sleep(this.RATE_DELAY);
    }
  }

  private async toResult<T>(
    operation: () => Promise<T>,
  ): Promise<Result<T, Error>> {
    try {
      return { success: true, value: await operation() };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err : new Error(String(err)),
      };
    }
  }

  async executeConsolidationPlan(
    plan: ConsolidationPlan,
    snapshotTabs: Tab[],
  ): Promise<Result<void, Error>> {
    return this.toResult(async () => {
      // 1. Move Groups
      for (const gm of plan.groupMoves) {
        await runAtomicOperation(
          () =>
            chrome.tabGroups.move(gm.groupId, {
              windowId: gm.windowId,
              index: -1,
            }),
          snapshotTabs,
          this.RATE_DELAY,
        );
      }

      // 2. Move Individual Tabs
      for (const tm of plan.tabMoves) {
        await runAtomicOperation(
          () =>
            chrome.tabs.move(tm.tabIds, { windowId: tm.windowId, index: -1 }),
          snapshotTabs,
          this.RATE_DELAY,
        );
      }
    });
  }

  async executeMembershipPlan(
    plan: MembershipPlan,
    snapshotTabs: Tab[],
  ): Promise<Result<void, Error>> {
    return this.toResult(async () => {
      // 1. Ungroup first
      if (plan.toUngroup.length > 0) {
        for (const batch of this.batch(plan.toUngroup)) {
          await runAtomicOperation(
            async () => {
              await chrome.tabs.ungroup(
                batch.length === 1
                  ? (batch[0] as number)
                  : (batch as unknown as [number, ...number[]]),
              );
            },
            snapshotTabs,
            this.RATE_DELAY,
          );
        }
      }

      // 2. Group & Title
      for (const entry of plan.toGroup) {
        // Ensure all tabs are in the target window BEFORE grouping
        const needsMove = entry.tabIds
          .map((id) => snapshotTabs.find((t) => asTabId(t.id) === id))
          .filter(isDefined)
          .filter((t) => t.windowId !== plan.targetWindowId);

        if (needsMove.length > 0) {
          await runAtomicOperation(
            () =>
              chrome.tabs.move(
                needsMove.map((t) => t.id!),
                { windowId: plan.targetWindowId, index: -1 },
              ),
            snapshotTabs,
            this.RATE_DELAY,
          );
        }

        await runAtomicOperation(
          async () => {
            const options: chrome.tabs.GroupOptions = {
              tabIds:
                entry.tabIds.length === 1
                  ? (entry.tabIds[0] as number)
                  : (entry.tabIds as unknown as [number, ...number[]]),
            };
            if (entry.groupId !== null) {
              options.groupId = entry.groupId as number;
            }
            const gid = await chrome.tabs.group(options);

            const updateData: chrome.tabGroups.UpdateProperties = {
              collapsed: entry.collapsed,
            };
            if (entry.title) updateData.title = entry.title;

            await chrome.tabGroups.update(gid, updateData);
          },
          snapshotTabs,
          this.RATE_DELAY,
        );
      }
    });
  }

  async executeOrderPlan(
    plan: OrderPlan,
    targetWindowId: WindowId,
    snapshotTabs: Tab[],
  ): Promise<Result<void, Error>> {
    return this.toResult(async () => {
      for (const unit of plan.desired) {
        const isToMove = plan.toMove.some((mu) => {
          if (unit.kind === "group" && mu.kind === "group")
            return unit.groupId === mu.groupId;
          if (unit.kind === "solo" && mu.kind === "solo")
            return unit.tabId === mu.tabId;
          return false;
        });

        if (isToMove) {
          await runAtomicOperation(
            async () => {
              if (unit.kind === "group") {
                await chrome.tabGroups.move(unit.groupId as number, {
                  windowId: targetWindowId,
                  index: unit.targetIndex,
                });
              } else {
                await chrome.tabs.move(unit.tabId as number, {
                  windowId: targetWindowId,
                  index: unit.targetIndex,
                });
              }
            },
            snapshotTabs,
            this.RATE_DELAY,
          );
        }
      }
    });
  }

  async updateBadge(count: number): Promise<void> {
    try {
      if (count > 0) {
        chrome.action.setBadgeText({ text: count.toString() });
        chrome.action.setBadgeBackgroundColor({ color: "#9688F1" });
      } else {
        chrome.action.setBadgeText({ text: "" });
      }
    } catch (err) {
      console.warn("Failed to update badge:", err);
    }
  }

  private batch<T>(arr: readonly T[]): T[][] {
    const out: T[][] = [];
    for (let i = 0; i < arr.length; i += this.MAX_BATCH)
      out.push(arr.slice(i, i + this.MAX_BATCH) as T[]);
    return out;
  }
}
