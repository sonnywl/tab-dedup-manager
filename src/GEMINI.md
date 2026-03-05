# Tab Grouping Rules

## Architecture

The application is structured into three distinct layers to promote separation of concerns, testability, and maintainability:

1.  **Domain Layer (`TabGroupingService`):** Contains pure business logic functions that operate on data without direct knowledge of the Chrome API. This layer is responsible for tasks such as domain extraction, building group maps, counting duplicates, filtering tabs, building group states, calculating repositioning needs, and creating group plans.
2.  **Infrastructure Layer (`ChromeTabAdapter`):** Encapsulates all interactions with the Chrome API. It provides an abstraction over browser-specific functionalities (e.g., `chrome.tabs`, `chrome.tabGroups`, `chrome.windows`) and handles concerns like batching operations, rate limiting, and error handling (with retry mechanisms).
3.  **Application Layer (`TabGroupingController`):** Orchestrates the overall tab grouping process. It coordinates between the Domain Layer (using `TabGroupingService`) and the Infrastructure Layer (using `ChromeTabAdapter`) to execute the grouping logic based on user settings and tab states. The `init()` function serves as the entry point for setting up event listeners that trigger the controller's main execution flow.

## Requirements

| Rule            | Behavior                                                                                             |
| --------------- | ---------------------------------------------------------------------------------------------------- |
| Group threshold | 2+ tabs with same domain (or group key) → group, 1 tab → ungroup, move to end                        |
| Grouping Scope  | Global (merge all to active window) OR per-window grouping ("check to keep all windows or a limit") |
| Window Limit    | Optional `numWindowsToKeep`. Excess windows are merged into retained windows.                        |
| Merge Strategy  | Excess tabs merge into windows with matching domains (frequency-based heuristic)                      |
| Group title     | Domain name by default, or user-defined custom group name                                            |
| Custom Groups   | Multiple domains can be mapped to a single group name to merge them together                         |
| Sort order      | Groups sorted by URL → ungrouped tabs sorted by URL (after groups)                                   |
| External Groups | **Mandate**: Treat manual groups as immutable, atomic blocks for grouping/moving only.               |
| Performance     | **Mandate**: Use state-hashing to skip redundant operations. Skip API calls if state already correct.|
| Rule: Skip      | Completely ignore domain; mutually exclusive with Delete; clears/disables split path and group name  |
| Rule: Delete    | Automatically close tabs matching domain; mutually exclusive with Skip; clears/disables split path   |
| Exclusions      | Always skip non-normal windows (popups, panels), internal pages, and PWAs                            |

## Flow (Orchestrated by `TabGroupingController.execute()`)

1.  **Trigger**: User clicks the extension icon.
2.  **Fingerprint**: Calculate `lastStateHash`. If identical to previous successful run, return early.
3.  **Cleaning**: Global deduplication and auto-deletion (applies to ALL tabs).
4.  **Protection**: Identify remaining manual groups via `isInternalTitle`. Gather `protectedTabIds`.
5.  **State Retrieval**: Fetches user-defined rules and grouping configuration from the synchronized store.
6.  **Grouping Process**:
    - `TabGroupingService` builds `GroupState` objects. Manual groups are marked `isExternal`.
    - `ChromeTabAdapter` applies states (Managed: ungroup/group; External: skip).
    - `TabGroupingService` creates a `GroupPlan`.
    - `ChromeTabAdapter` executes the `GroupPlan` (Managed: functional; External: atomic move only, metadata restore).
7.  **Badge Update**: `ChromeTabAdapter` updates the extension badge based on duplicate tab count.

## Performance

- **State Fingerprinting**: Skip redundant executions via `lastStateHash`.
- **Atomic Movement**: Manual groups move as blocks, minimizing API calls.
- **Redundancy Checks**: `applyGroupState` avoids grouping/ungrouping if the target state matches the current.
- O(n) tab filtering + deduplication
## Learnings
- **Code Duplication:** Successfully consolidated duplicated types and classes from `src/background.ts` into `src/utils/grouping.ts`. This reduces the risk of divergence.
- **Testing:** `fast-check` (in `src/background.e2e.test.ts`) is critical for verifying invariants like "atomic manual group moves" and "re-bundling". Always run these property-based tests when modifying grouping logic.
- **Chrome API:** `chrome.tabs.group` effectively handles merging and moving tabs into groups, reducing the need for explicit `ungroup` calls. `chrome.tabGroups.move` is the most efficient way to move existing groups.
- **Vitest Imports:** When moving local classes to an external utility, they must be both imported (for local class members like `TabGroupingController.service`) and exported (if the test suite imports them from the original file).
- **Behavior Consistency:** Aesthetic changes (like domain capitalization) should be applied globally or disabled if they conflict with invariant expectations in existing tests.
- **Cumulative Index Offsets:** Absolute tab indices in Chrome are sensitive to the total count of preceding tabs. When calculating target positions for groups, always sum the `tabIds.length` of preceding groups rather than the number of group objects. Failure to do so leads to "drifting" target indices and redundant move operations.
- **Cleaning vs. Protection:** Deduplication and auto-deletion are destructive operations that must be aware of manual groups. Identification of protected tabs must happen *before* cleaning, and cleaning functions must skip protected IDs to maintain the "immutable atomic block" mandate.
- **Visual Persistence:** Reconstructing groups after movement (especially cross-window) requires capturing and restoring not just the title, but also visual metadata like `color`, which is otherwise lost in the group/ungroup cycle.
