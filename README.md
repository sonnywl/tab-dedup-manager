# Tab Dedup Manager

### Features

- **Automated Tab Deduplication**: Automatically identifies and closes duplicate tabs with the same URL, streamlining your browsing experience.
- **Domain-Based Tab Grouping**: Organizes your open tabs by their domain, making it easier to navigate and manage related content.
- **PWA Exclusion**: Skips Progressive Web Apps (PWAs) from deduplication and grouping, ensuring your essential application-like tabs remain undisturbed.
- **Per-Domain Customization**: A dedicated options page allows you to fine-tune deduplication and grouping behaviors for specific domains, giving you granular control.

# Tab Grouping Rules

## Requirements

| Rule                | Behavior                                                                  |
| ------------------- | ------------------------------------------------------------------------- |
| Group threshold     | 2+ tabs with same groupName → group, 1 tab → ungroup, stay in place       |
| Group title         | `rule.groupName` if set, otherwise domain name                            |
| Sort order          | Groups alphabetical by displayName → ungrouped tabs (unmodified position) |
| Exclusions          | Skip PWA windows, extension pages                                         |
| Multi-domain groups | Multiple domains with same groupName → single group                       |

## Flow

```
Filter tabs (exclude PWAs) → Deduplicate → Auto-delete → Build domain map
  ↓
Group by rule.groupName or domain (track allowed domains per group)
  ↓
Build state (only groups with 2+ tabs, validate domains, sort URLs)
  ↓
Apply state (create/reuse groups, verify domain membership)
  ↓
Ungroup orphaned singles
  ↓
Calculate reposition needs (groups only)
  ↓
Conditional reposition (skip if already positioned correctly)
```

## Rule-based Grouping

```typescript
{domain: "api.github.com", groupName: "GitHub"}
{domain: "www.github.com", groupName: "GitHub"}
{domain: "github.com", groupName: "GitHub"}
→ All grouped as "GitHub"

{domain: "bitbucket.org", groupName: null}
→ Grouped as "bitbucket.org"
```

## Window Modes

| Mode              | Behavior                                        |
| ----------------- | ----------------------------------------------- |
| `byWindow: false` | Merge all tabs to active window, group globally |
| `byWindow: true`  | Group tabs independently per window             |

## State Components

| Function                   | Input                   | Output                                              | Side Effects     |
| -------------------------- | ----------------------- | --------------------------------------------------- | ---------------- |
| `buildDomainMap`           | Tabs, rules             | DomainMap (groupKey → {tabs, displayName, domains}) | None             |
| `buildGroupState`          | DomainMap               | GroupState[] (2+ tabs only)                         | None             |
| `calculateRepositionNeeds` | GroupState[], windowId? | GroupState[] with flags                             | None             |
| `applyGroupState`          | GroupState              | void                                                | Chrome API calls |

## Positioning Logic

| Type             | Included in repositioning | Final position                     |
| ---------------- | ------------------------- | ---------------------------------- |
| Groups (2+ tabs) | Yes                       | Index 0 → n, sorted by displayName |
| Single tabs      | No                        | Original position (after groups)   |

## Edge Cases

| Condition                                 | Action                       |
| ----------------------------------------- | ---------------------------- |
| Tab domain not in group's allowed domains | Filter out during validation |
| Single tab accidentally grouped           | Ungroup explicitly           |
| Groups already positioned                 | Skip reposition              |
| Group creation fails                      | Create new group             |
| Multiple domains, same groupName          | Merge into single group      |

## Performance

- O(n) tab filtering + deduplication
- O(g) group operations where g = unique groupNames/domains with 2+ tabs
- O(r) repositions where r ≤ g
- Single tab query cached in Map
- Skip Chrome API when state matches desired
- Single tabs excluded from repositioning (O(1) per single)
