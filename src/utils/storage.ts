export interface Rule {
  id?: string;
  domain: string;
  autoDelete?: boolean | null | undefined;
  groupName?: string | null | undefined;
  splitByPath?: number | null | undefined;
}

export interface GroupingConfig {
  byWindow: boolean;
  numWindowsToKeep?: number | null | undefined;
}

export interface SyncStoreState {
  rules: Rule[];
  grouping: GroupingConfig;
}

/**
 * Validates a rule object.
 * Standardizes behavior between background and options UI.
 */
export function validateRule(rule: any): rule is Rule {
  if (typeof rule !== "object" || rule === null) return false;
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
