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
| Rule: Skip      | Completely ignore domain; mutually exclusive with Delete; clears/disables split path and group name  |
| Rule: Delete    | Automatically close tabs matching domain; mutually exclusive with Skip; clears/disables split path   |
| Exclusions      | Always skip non-normal windows (popups, panels), internal pages, and PWAs                            |

## Flow (Orchestrated by `TabGroupingController.execute()`)

1.  **Initialization (`init()`):** Sets up event listeners (e.g., `chrome.action.onClicked`, `chrome.tabs.onCreated`, `chrome.tabs.onRemoved`, `chrome.tabs.onUpdated`) which trigger the `TabGroupingController.execute()` method.
2.  **State Retrieval:** Fetches user-defined rules and grouping configuration (e.g., `byWindow`, `numWindowsToKeep`) from the synchronized store.
3.  **Tab Filtering:** Uses `ChromeTabAdapter` to get relevant tabs from **normal windows** only and `TabGroupingService` to apply `skipProcess` rules.
4.  **Global Merging (Conditional):** If `byWindow` is disabled, `ChromeTabAdapter` merges all tabs into the active window (fallback to first normal window if active is a popup).
5.  **Window Consolidation (Conditional):** If `byWindow` is enabled and `numWindowsToKeep` is set, `WindowManagementService` identifies excess windows and calculates a merge plan to consolidate tabs into retained windows based on domain relevance.
6.  **Deduplication:** `ChromeTabAdapter` identifies and removes duplicate tabs.
7.  **Auto-deletion:** `ChromeTabAdapter` applies auto-delete rules to remove specified tabs.
8.  **Grouping Process (`TabGroupingController.processGrouping()`):**
    - `TabGroupingService` builds `GroupState` objects, reusing existing group IDs in the window by title.
    - `ChromeTabAdapter` applies the group states (creating new groups, adding to existing ones, or ungrouping single tabs).
    - `TabGroupingService` calculates repositioning needs.
    - `TabGroupingService` creates a `GroupPlan`.
    - `ChromeTabAdapter` executes the `GroupPlan` (ungrouping, moving, and grouping tabs).
9.  **Badge Update:** `ChromeTabAdapter` updates the extension badge based on duplicate tab count.

## State Components (Accessed by `TabGroupingController`)

| Component               | Responsibility                                                                                                                                                                                                                                        |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TabGroupingService`    | Pure business logic: `getDomain`, `getGroupKey`, `buildGroupMap`, `countDuplicates`, `filterValidTabs`, `buildGroupStates`, `calculateRepositionNeeds`, `createGroupPlan`. Operates on tab data without Chrome API calls.                            |
| `WindowManagementService`| Pure business logic: `calculateMergePlan`. Determines optimal target windows for excess tabs based on domain frequency and window size.                                                                                                              |
| `ChromeTabAdapter`      | Chrome API interactions: `getNormalTabs`, `getRelevantTabs`, `deduplicateAllTabs`, `applyAutoDeleteRules`, `mergeToActiveWindow`, `moveTabsToWindow`, `getGroupsInWindow`, `applyGroupState`, `executeGroupPlan`, `ungroupSingleTabs`, `updateBadge`. |
| `TabGroupingController` | Orchestration: `groupByWindow`, `processGrouping`, `execute`. Coordinates operations between Services and Adapter.                                                                                                                                    |

## Positioning Logic

| Type             | Included in repositioning | Final position               |
| ---------------- | ------------------------- | ---------------------------- |
| Groups (2+ tabs) | Yes                       | Index 0 → n, sorted by URL   |
| Single tabs      | Yes                       | Index n+1 → m, sorted by URL |

## Edge Cases

| Condition                       | Action                                                              |
| ------------------------------- | ------------------------------------------------------------------- |
| Tab domain ≠ group title        | Ungroup, regroup correctly                                          |
| Single tab accidentally grouped | Ungroup explicitly                                                  |
| Groups already positioned       | Skip reposition                                                     |
| Group creation fails            | Create new group                                                    |
| Active window is not 'normal'   | Target the first available normal window for merging                |
| Moving tabs across windows      | Search for and reuse existing group by title in target window       |
| Window limit exceeded           | Merge excess tabs into windows with most matching domains           |

## Performance

- O(n) tab filtering + deduplication
- O(g) group operations where g = domains with 2+ tabs
- O(r) repositions where r ≤ g
- Single tab query cached in Map
- Skip Chrome API when state matches desired
