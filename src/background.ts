import startSyncStore from "./utils/startSyncStore.js";

chrome.action.onClicked.addListener(collapseDuplicateDomains);
chrome.tabs.onCreated.addListener(updateBadge);
chrome.tabs.onRemoved.addListener(updateBadge);
chrome.tabs.onUpdated.addListener(updateBadge);

// ─── Types ───────────────────────────────────────────────────────────────────

interface DomainMap {
  [domain: string]: { tabs: chrome.tabs.Tab[] };
}

interface Rule {
  id: string;
  domain: string;
  autoDelete: boolean;
  skipProcess: boolean;
  splitByPath: boolean | undefined;
  groupName: string | undefined;
}

interface RulesByDomain {
  [domain: string]: Rule;
}

interface GroupState {
  domain: string;
  tabIds: number[];
  groupId: number | null;
  needsReposition: boolean;
}

interface SyncStore {
  getState: () => Promise<{ rules: Rule[] }>;
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function getDomain(url: string | undefined): string {
  if (!url) return "other";
  try {
    return new URL(url).hostname;
  } catch {
    return "other";
  }
}

function extractTabIds(tabs: chrome.tabs.Tab[]): number[] {
  return tabs.map((t) => t.id).filter((id): id is number => id !== undefined);
}

function isGrouped(tab: chrome.tabs.Tab): boolean {
  return tab.groupId != null && tab.groupId !== -1;
}

// ─── Tab Queries ──────────────────────────────────────────────────────────────

async function getAllNonAppTabs(): Promise<chrome.tabs.Tab[]> {
  const [allTabs, windows] = await Promise.all([
    chrome.tabs.query({}),
    chrome.windows.getAll({ populate: false }),
  ]);
  const appWindowIds = new Set(
    windows.filter((w) => w.type === "app").map((w) => w.id),
  );
  return allTabs.filter(
    (tab) =>
      tab.url &&
      !tab.url.startsWith("chrome-extension://") &&
      !(tab.windowId && appWindowIds.has(tab.windowId)),
  );
}

async function getRelevantTabs(
  rulesByDomain: RulesByDomain,
): Promise<chrome.tabs.Tab[]> {
  const nonAppTabs = await getAllNonAppTabs();
  return nonAppTabs.filter((tab) => {
    const rule = rulesByDomain[getDomain(tab.url)];
    return rule?.skipProcess == null || rule.skipProcess === false;
  });
}

// ─── Badge ────────────────────────────────────────────────────────────────────

function countDuplicates(tabs: chrome.tabs.Tab[]): number {
  const seen: { [domain: string]: Set<string> } = {};
  let count = 0;
  for (const tab of tabs) {
    const domain = getDomain(tab.url);
    if (!seen[domain]) seen[domain] = new Set();
    if (tab.url && seen[domain].has(tab.url)) {
      count++;
    } else if (tab.url) {
      seen[domain].add(tab.url);
    }
  }
  return count;
}

async function updateBadge(): Promise<void> {
  const tabs = await getAllNonAppTabs();
  const count = countDuplicates(tabs);
  if (count > 0) {
    chrome.action.setBadgeText({ text: count.toString() });
    chrome.action.setBadgeBackgroundColor({ color: "#9688F1" });
  } else {
    chrome.action.setBadgeText({ text: "" });
  }
}

// ─── Dedup + Rules ────────────────────────────────────────────────────────────

async function deduplicateAllTabs(
  tabs: chrome.tabs.Tab[],
): Promise<chrome.tabs.Tab[]> {
  const seen = new Set<string>();
  const unique: chrome.tabs.Tab[] = [];
  const dupeIds: number[] = [];

  for (const tab of tabs) {
    if (tab.url && !seen.has(tab.url)) {
      seen.add(tab.url);
      unique.push(tab);
    } else if (tab.id) {
      dupeIds.push(tab.id);
    }
  }

  if (dupeIds.length > 0) await chrome.tabs.remove(dupeIds);
  return unique;
}

async function applyAutoDeleteRules(
  tabs: chrome.tabs.Tab[],
  rulesByDomain: RulesByDomain,
): Promise<chrome.tabs.Tab[]> {
  const toDelete: number[] = [];
  const remaining: chrome.tabs.Tab[] = [];

  for (const tab of tabs) {
    const rule = rulesByDomain[getDomain(tab.url)] ?? null;
    if (rule?.autoDelete && tab.id) {
      toDelete.push(tab.id);
    } else {
      remaining.push(tab);
    }
  }

  if (toDelete.length > 0) await chrome.tabs.remove(toDelete);
  return remaining;
}

function buildDomainMap(tabs: chrome.tabs.Tab[]): DomainMap {
  const map: DomainMap = {};
  for (const tab of tabs) {
    const domain = getDomain(tab.url);
    if (!map[domain]) map[domain] = { tabs: [] };
    map[domain].tabs.push(tab);
  }
  return map;
}

// ─── Grouping ─────────────────────────────────────────────────────────────────

async function getValidTabsForDomain(
  tabs: chrome.tabs.Tab[],
  domain: string,
  tabCache: Map<number, chrome.tabs.Tab>,
): Promise<chrome.tabs.Tab[]> {
  return extractTabIds(tabs)
    .map((id) => tabCache.get(id))
    .filter(
      (t): t is chrome.tabs.Tab =>
        t !== undefined && getDomain(t.url) === domain,
    );
}

async function buildGroupState(
  domainMap: DomainMap,
  tabCache: Map<number, chrome.tabs.Tab>,
): Promise<GroupState[]> {
  const states: GroupState[] = [];

  for (const [domain, { tabs }] of Object.entries(domainMap)) {
    if (tabs.length < 2) continue;

    const validTabs = await getValidTabsForDomain(tabs, domain, tabCache);
    if (validTabs.length < 2) continue;

    validTabs.sort((a, b) => (a.url && b.url ? a.url.localeCompare(b.url) : 0));

    states.push({
      domain,
      tabIds: extractTabIds(validTabs),
      groupId: validTabs.find(isGrouped)?.groupId ?? null,
      needsReposition: false,
    });
  }

  return states;
}

async function applyGroupState(
  state: GroupState,
  tabCache: Map<number, chrome.tabs.Tab>,
): Promise<GroupState> {
  if (state.tabIds.length < 2) {
    if (state.groupId !== null && state.tabIds.length > 0) {
      await chrome.tabs.ungroup(state.tabIds);
    }
    return state;
  }

  if (state.groupId === null) {
    const newGroupId = await chrome.tabs.group({ tabIds: state.tabIds });
    await chrome.tabGroups.update(newGroupId, {
      collapsed: false,
      title: state.domain,
    });
    return { ...state, groupId: newGroupId };
  }

  const wrongGroup = state.tabIds.filter((id) => {
    const tab = tabCache.get(id);
    return tab && tab.groupId !== state.groupId && isGrouped(tab);
  });

  if (wrongGroup.length > 0) await chrome.tabs.ungroup(wrongGroup);

  let resolvedGroupId = state.groupId;
  try {
    await chrome.tabs.group({ groupId: resolvedGroupId, tabIds: state.tabIds });
  } catch {
    resolvedGroupId = await chrome.tabs.group({ tabIds: state.tabIds });
    await chrome.tabGroups.update(resolvedGroupId, {
      collapsed: false,
      title: state.domain,
    });
  }

  await chrome.tabGroups.update(resolvedGroupId, {
    collapsed: false,
    title: state.domain,
  });
  return { ...state, groupId: resolvedGroupId };
}

export async function groupDomainTabs(
  domainMap: DomainMap,
  allTabs: chrome.tabs.Tab[],
): Promise<void> {
  const errors: Array<{ domain: string; error: Error }> = [];

  try {
    const tabCache = new Map(allTabs.map((t) => [t.id, t]));

    let groupStates: GroupState[] = [];
    for (const state of await buildGroupState(domainMap, tabCache)) {
      try {
        groupStates.push(await applyGroupState(state, tabCache));
      } catch (error) {
        errors.push({
          domain: state.domain,
          error: error instanceof Error ? error : new Error(String(error)),
        });
      }
    }

    const allGroupedTabIds = new Set(groupStates.flatMap((s) => s.tabIds));

    for (const [domain, { tabs }] of Object.entries(domainMap)) {
      if (tabs.length === 1) {
        const tab = tabs[0];
        if (tab?.id && isGrouped(tab) && !allGroupedTabIds.has(tab.id)) {
          await chrome.tabs.ungroup([tab.id]);
        }
      }
    }

    // P1: pass allCurrentTabs — no secondary fetch inside calculateRepositionNeeds

    const needsReposition = groupStates.filter((s) => s.needsReposition);
    if (needsReposition.length === 0) {
      if (errors.length > 0) console.warn("Grouping errors:", errors);
      return;
    }

    for (const state of groupStates) {
      if (state.tabIds.length > 0) await chrome.tabs.ungroup(state.tabIds);
    }

    let targetIndex = 0;
    for (const state of groupStates) {
      if (state.tabIds.length === 0) continue;
      await chrome.tabs.move(state.tabIds, { index: targetIndex });
      if (state.tabIds.length >= 2) {
        const newGroupId = await chrome.tabs.group({ tabIds: state.tabIds });
        await chrome.tabGroups.update(newGroupId, {
          collapsed: false,
          title: state.domain,
        });
      }
      targetIndex += state.tabIds.length;
    }
  } catch (error) {
    errors.push({
      domain: "global",
      error: error instanceof Error ? error : new Error(String(error)),
    });
  }

  if (errors.length > 0) console.warn("Grouping errors:", errors);
}

// ─── Entry Point ──────────────────────────────────────────────────────────────

let running = false;

async function collapseDuplicateDomains(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const store: SyncStore = await startSyncStore({ rules: [] });
    const { rules } = await store.getState();

    const rulesByDomain: RulesByDomain = rules.reduce(
      (acc: RulesByDomain, curr: Rule) => {
        if (curr.domain.length > 0) acc[curr.domain] = curr;
        return acc;
      },
      {},
    );

    let tabs = await getRelevantTabs(rulesByDomain);

    const windows = await chrome.windows.getAll();
    if (windows.length > 1) {
      const activeWindow = await chrome.windows.getCurrent();
      const tabsToMove = tabs.filter((t) => t.windowId !== activeWindow.id);
      if (tabsToMove.length > 0) {
        await chrome.tabs.move(extractTabIds(tabsToMove), {
          windowId: activeWindow.id,
          index: -1,
        });
      }
    }

    tabs = await getRelevantTabs(rulesByDomain);
    const uniqueTabs = await deduplicateAllTabs(tabs);
    const remainingTabs = await applyAutoDeleteRules(uniqueTabs, rulesByDomain);
    const finalTabs = await getRelevantTabs(rulesByDomain);
    await groupDomainTabs(buildDomainMap(remainingTabs), finalTabs);
  } catch (e) {
    console.warn(e);
  } finally {
    running = false;
  }
}
