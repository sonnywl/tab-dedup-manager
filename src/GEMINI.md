# Tab Grouping Rules

## Requirements

| Rule            | Behavior                                          |
| --------------- | ------------------------------------------------- |
| Group threshold | 2+ tabs with same domain → group, 1 tab → ungroup |
| Group title     | Domain name, must match all tab domains           |
| Sort order      | Groups alphabetical by domain → ungrouped tabs    |
| Exclusions      | Skip PWA windows, extension pages                 |

## Flow

```
Filter tabs (exclude PWAs) → Deduplicate → Auto-delete → Build domain map
  ↓
Build state (validate domains, sort URLs, track groupIds)
  ↓
Apply state (create/reuse groups, ungroup singles)
  ↓
Calculate reposition needs (compare current vs expected indices)
  ↓
Conditional reposition (only if needsReposition = true)
```

## State Components

| Function                   | Input        | Output                  | Side Effects     |
| -------------------------- | ------------ | ----------------------- | ---------------- |
| `buildGroupState`          | Domain map   | GroupState[]            | None             |
| `calculateRepositionNeeds` | GroupState[] | GroupState[] with flags | None             |
| `applyGroupState`          | GroupState   | void                    | Chrome API calls |

## Edge Cases

| Condition                | Action                     |
| ------------------------ | -------------------------- |
| Tab domain ≠ group title | Ungroup, regroup correctly |
| Tabs already positioned  | Skip reposition            |
| Group creation fails     | Create new group           |
| Single tab in domain     | Ungroup if grouped         |

## Performance

- O(n) tab filtering + deduplication
- O(g) group operations
- O(r) repositions where r ≤ g
- Single tab query cached in Map
- Skip Chrome API when state matches desired
