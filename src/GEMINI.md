# Tab Grouping Rules

## Architecture

The application is structured into three distinct layers to promote separation of concerns, testability, and maintainability:

1.  **Domain Layer (`TabGroupingService`):** Contains pure business logic functions that operate on data without direct knowledge of the Chrome API. This layer is responsible for tasks such as domain extraction, building domain maps, counting duplicates, filtering tabs, building group states, calculating repositioning needs, and creating group plans.
2.  **Infrastructure Layer (`ChromeTabAdapter`):** Encapsulates all interactions with the Chrome API. It provides an abstraction over browser-specific functionalities (e.g., `chrome.tabs`, `chrome.tabGroups`, `chrome.windows`) and handles concerns like batching operations, rate limiting, and error handling (with retry mechanisms).
3.  **Application Layer (`TabGroupingController`):** Orchestrates the overall tab grouping process. It coordinates between the Domain Layer (using `TabGroupingService`) and the Infrastructure Layer (using `ChromeTabAdapter`) to execute the grouping logic based on user settings and tab states. The `init()` function serves as the entry point for setting up event listeners that trigger the controller's main execution flow.

## Requirements

| Rule            | Behavior                                                                        |
| --------------- | ------------------------------------------------------------------------------- |
| Group threshold | 2+ tabs with same domain (or group key) → group, 1 tab → ungroup, stay in place |
| Grouping Scope  | Global (merge all to active window) OR per-window grouping                      |
| Group title     | Domain name by default, or user-defined custom group name                       |
| Custom Groups   | Multiple domains can be mapped to a single group name to merge them together    |
| Sort order      | Groups alphabetical by title → ungrouped tabs (unmodified position)             |
| Rule: Skip      | Completely ignore domain during deduplication and grouping                      |
| Rule: Delete    | Automatically close tabs matching domain when processing                        |
| Exclusions      | Always skip PWA windows and extension internal pages                            |

## Flow (Orchestrated by `TabGroupingController.execute()`)

1.  **Initialization (`init()`):** Sets up event listeners (e.g., `chrome.action.onClicked`, `chrome.tabs.onCreated`, `chrome.tabs.onRemoved`, `chrome.tabs.onUpdated`) which trigger the `TabGroupingController.execute()` method.
2.  **State Retrieval:** Fetches user-defined rules and grouping configuration (e.g., `byWindow`) from the synchronized store.
3.  **Tab Filtering:** Uses `ChromeTabAdapter` to get relevant tabs (excluding PWAs and extension pages) and `TabGroupingService` to apply `skipProcess` rules.
4.  **Window Merging (Conditional):** If `byWindow` grouping is disabled, `ChromeTabAdapter` merges tabs into the active window.
5.  **Deduplication:** `ChromeTabAdapter` identifies and removes duplicate tabs.
6.  **Auto-deletion:** `ChromeTabAdapter` applies auto-delete rules to remove specified tabs.
7.  **Window-based Processing (Conditional):**
    - If `byWindow` is enabled, `TabGroupingController` groups remaining tabs by window, and for each window:
      - `TabGroupingService` builds a domain map.
      - `TabGroupingController.processGrouping()` handles the grouping for that window.
    - If `byWindow` is disabled, `TabGroupingService` builds a global domain map.
8.  **Grouping Process (`TabGroupingController.processGrouping()`):**
    - `TabGroupingService` builds `GroupState` objects for domains with 2+ tabs.
    - `ChromeTabAdapter` applies the group states (creating new groups, adding to existing ones, or ungrouping single tabs).
    - `TabGroupingService` calculates repositioning needs.
    - `TabGroupingService` creates a `GroupPlan`.
    - `ChromeTabAdapter` executes the `GroupPlan` (ungrouping, moving, and grouping tabs).
9.  **Badge Update:** `ChromeTabAdapter` updates the extension badge based on duplicate tab count.

## State Components (Accessed by `TabGroupingController`)

| Component               | Responsibility                                                                                                                                                                                                                                        |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TabGroupingService`    | Pure business logic: `getDomain`, `getGroupKey`, `buildDomainMap`, `countDuplicates`, `filterValidTabs`, `buildGroupStates`, `calculateRepositionNeeds`, `createGroupPlan`. Operates on tab data without Chrome API calls.                            |
| `ChromeTabAdapter`      | Chrome API interactions: `getAllNonAppTabs`, `getRelevantTabs`, `deduplicateAllTabs`, `applyAutoDeleteRules`, `mergeToActiveWindow`, `applyGroupState`, `executeGroupPlan`, `ungroupSingleTabs`, `updateBadge`. Provides abstraction over Chrome API. |
| `TabGroupingController` | Orchestration: `groupByWindow`, `processGrouping`, `execute`. Coordinates operations between `TabGroupingService` and `ChromeTabAdapter`.                                                                                                             |

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
