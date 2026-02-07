# Tab Grouping Rules

## Requirements

| Rule            | Behavior                                                             |
| --------------- | -------------------------------------------------------------------- |
| Group threshold | 2+ tabs with same domain → group, 1 tab → ungroup, stay in place     |
| Group title     | Domain name, must match all tab domains                              |
| Sort order      | Groups alphabetical by domain → ungrouped tabs (unmodified position) |
| Exclusions      | Skip PWA windows, extension pages                                    |

## Flow

```
Filter tabs (exclude PWAs) → Deduplicate → Auto-delete → Build domain map
  ↓
Build state (only domains with 2+ tabs, validate, sort URLs, track groupIds)
  ↓
Apply state (create/reuse groups for 2+ tab domains)
  ↓
Ungroup orphaned singles (single tabs accidentally grouped)
  ↓
Calculate reposition needs (compare current vs expected indices for groups only)
  ↓
Conditional reposition (only groups, singles remain untouched)
```

## State Components

| Function                   | Input        | Output                      | Side Effects     |
| -------------------------- | ------------ | --------------------------- | ---------------- |
| `buildGroupState`          | Domain map   | GroupState[] (2+ tabs only) | None             |
| `calculateRepositionNeeds` | GroupState[] | GroupState[] with flags     | None             |
| `applyGroupState`          | GroupState   | void                        | Chrome API calls |

## Positioning Logic

| Type             | Included in repositioning | Final position                   |
| ---------------- | ------------------------- | -------------------------------- |
| Groups (2+ tabs) | Yes                       | Index 0 → n, sorted by domain    |
| Single tabs      | No                        | Original position (after groups) |

## Edge Cases

| Condition                       | Action                     |
| ------------------------------- | -------------------------- |
| Tab domain ≠ group title        | Ungroup, regroup correctly |
| Single tab accidentally grouped | Ungroup explicitly         |
| Groups already positioned       | Skip reposition            |
| Group creation fails            | Create new group           |

## Performance

- O(n) tab filtering + deduplication
- O(g) group operations where g = domains with 2+ tabs
- O(r) repositions where r ≤ g
- Single tab query cached in Map
- Skip Chrome API when state matches desired
- Single tabs excluded from repositioning (O(1) per single)
