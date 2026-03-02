export interface Rule {
  id?: string;
  domain: string;
  autoDelete?: boolean | null | undefined;
  skipProcess?: boolean | null | undefined;
  groupName?: string | null | undefined;
  splitByPath?: number | null | undefined;
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
  if (rule.skipProcess != null && typeof rule.skipProcess !== "boolean")
    return false;
  if (rule.groupName != null && typeof rule.groupName !== "string")
    return false;
  if (
    rule.splitByPath != null &&
    (typeof rule.splitByPath !== "number" || rule.splitByPath < 1)
  )
    return false;

  // autoDelete and skipProcess are mutually exclusive
  if (rule.autoDelete === true && rule.skipProcess === true) {
    return false;
  }

  return true;
}
