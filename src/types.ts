// ============================================================================
// SHARED TYPES
// ============================================================================

export type Domain = string & { readonly __brand: "Domain" };
export type TabId = number & { readonly __brand: "TabId" };
export type GroupId = number & { readonly __brand: "GroupId" };
export type WindowId = number & { readonly __brand: "WindowId" };

export interface Rule {
  id?: string;
  domain: string;
  autoDelete?: boolean | null | undefined;
  groupName?: string | null | undefined;
  splitByPath?: number | null | undefined;
}

export interface RulesByDomain {
  [domain: string]: Rule;
}

export interface GroupingConfig {
  byWindow: boolean;
  numWindowsToKeep?: number | null | undefined;
  ungroupSingleTab?: boolean | null | undefined;
}

export interface SyncStoreState {
  rules: Rule[];
  grouping: GroupingConfig;
}

export type Tab = chrome.tabs.Tab;

export interface GroupMapEntry {
  readonly tabs: Tab[];
  readonly displayName: string;
  readonly domains: ReadonlySet<Domain>;
  readonly isExternal?: boolean;
  readonly groupId?: GroupId | null;
  readonly collapsed?: boolean;
}

export type GroupMap = Map<string, GroupMapEntry>;

export interface GroupState {
  readonly displayName: string;
  readonly sourceDomain: string;
  readonly tabIds: readonly TabId[];
  readonly groupId: GroupId | null;
  readonly collapsed: boolean;
  readonly needsReposition: boolean;
  readonly needsTitleUpdate?: boolean;
  readonly isExternal?: boolean;
  readonly targetIndex?: number;
}

export interface MembershipPlan {
  toUngroup: TabId[];
  toGroup: {
    tabIds: TabId[];
    groupId: GroupId | null;
    title: string;
    collapsed: boolean;
  }[];
  targetWindowId: WindowId;
}

export type OrderUnit =
  | { kind: "group"; groupId: GroupId; tabIds: TabId[]; targetIndex: number }
  | { kind: "solo"; tabId: TabId; targetIndex: number };

export interface OrderPlan {
  desired: OrderUnit[];
  toMove: OrderUnit[];
}

export interface ProtectedTabMeta {
  readonly title: string;
  readonly originalGroupId: number;
}

export type ProtectedTabMetaMap = Map<TabId, ProtectedTabMeta>;

export interface ConsolidationPlan {
  readonly groupMoves: ReadonlyArray<{ groupId: number; windowId: WindowId }>;
  readonly tabMoves: ReadonlyArray<{ tabIds: number[]; windowId: WindowId }>;
}

export interface BrowserState {
  allTabs: Tab[];
  groupIdToGroup: Map<number, chrome.tabGroups.TabGroup>;
}

export interface SyncStore {
  getState: () => Promise<SyncStoreState>;
}

export type Result<T, E> =
  | { success: true; value: T }
  | { success: false; error: E };

// ============================================================================
// TYPE GUARDS & UTILS
// ============================================================================

export function isDefined<T>(v: T | undefined | null): v is T {
  return v !== undefined && v !== null;
}

export function asTabId(id: number | undefined): TabId | undefined {
  return id as TabId | undefined;
}
export function asGroupId(id: number): GroupId {
  return id as GroupId;
}
export function asWindowId(id: number): WindowId {
  return id as WindowId;
}
export function asDomain(s: string): Domain {
  return s as Domain;
}

export function extractTabIds(tabs: Tab[]): TabId[] {
  return tabs.map((t) => asTabId(t.id)).filter(isDefined);
}

export function isGrouped(tab: Tab): boolean {
  return tab.groupId != null && tab.groupId !== -1;
}

export function isInternalTab(tab: Tab): boolean {
  if (!tab.url) return false;
  const internalProtocols = ["chrome:", "about:", "edge:", "brave:"];
  return internalProtocols.some((p) => tab.url!.startsWith(p));
}

export function validateRule(r: unknown): r is Rule {
  if (typeof r !== "object" || r === null) return false;
  const rule = r as Record<string, unknown>;
  if (typeof rule.domain !== "string" || rule.domain.length === 0) return false;

  if (rule.autoDelete != null && typeof rule.autoDelete !== "boolean")
    return false;
  if (rule.groupName != null && typeof rule.groupName !== "string")
    return false;
  if (
    rule.splitByPath != null &&
    (typeof rule.splitByPath !== "number" || rule.splitByPath < 1)
  )
    return false;

  return true;
}
