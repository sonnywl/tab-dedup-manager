# Tab Grouping Rules

## Development Mandates

- **Role**: During coding, planning, and discussions, work as a **professional architect**. Ensure that code readability and architectural quality are retained or improved in every change.
- **Goals**: Continuously look for opportunities to improve **conciseness** and **performance** while strictly adhering to the defined rules and specifications.
- **Guidance**: Use the project specs (`SPEC.md`) and rules (`GEMINI.md`) as the primary foundational guidance for all decisions.
- **Clarification**: If a requested change or proposed behavior contradicts the established specifications (`SPEC.md`) or foundational rules (`GEMINI.md`), **proactively ask the user for clarity** before proceeding with implementation.
- **Verification**: **Always** utilize a sub-agent (e.g., `codebase_investigator` or `generalist`) to verify that any proposed plan or implemented change aligns perfectly with the established rules, invariants, and specifications. Do not process to long (< 1min is ideal)

## Architecture

The application is structured into three distinct layers to promote separation of concerns, testability, and maintainability:

1.  **Domain Layer (`TabGroupingService`):** Contains pure business logic functions that operate on data without direct knowledge of the Chrome API. This layer is responsible for tasks such as domain extraction, building group maps, counting duplicates, filtering tabs, building group states, calculating repositioning needs, and creating group plans.
2.  **Infrastructure Layer (`ChromeTabAdapter`):** Encapsulates all interactions with the Chrome API. It provides an abstraction over browser-specific functionalities (e.g., `chrome.tabs`, `chrome.tabGroups`, `chrome.windows`) and handles concerns like batching operations, rate limiting, and error handling (with retry mechanisms).
3.  **Application Layer (`TabGroupingController`):** Orchestrates the overall tab grouping process. It coordinates between the Domain Layer (using `TabGroupingService`) and the Infrastructure Layer (using `ChromeTabAdapter`) to execute the grouping logic based on user settings and tab states. The `init()` function serves as the entry point for setting up event listeners that trigger the controller's main execution flow.

## Requirements

| Rule            | Behavior                                                                                              |
| --------------- | ----------------------------------------------------------------------------------------------------- |
| Group threshold | 2+ tabs with same domain (or group key) → group, 1 tab → ungroup, move to end                         |
| Grouping Scope  | Global (merge all to active window) OR per-window grouping ("check to keep all windows or a limit")   |
| Window Limit    | Optional `numWindowsToKeep`. Excess windows are merged into retained windows.                         |
| Merge Strategy  | Excess tabs merge into windows with matching domains (frequency-based heuristic)                      |
| Group title     | Domain name by default, or user-defined custom group name                                             |
| Custom Groups   | Multiple domains can be mapped to a single group name to merge them together                          |
| Sort order      | Groups sorted by URL → ungrouped tabs sorted by URL (after groups)                                    |
| Performance     | **Mandate**: Use state-hashing to skip redundant operations. Skip API calls if state already correct. |
| Rule: Skip      | Completely ignore domain; mutually exclusive with Delete; clears/disables split path and group name   |
| Rule: Delete    | Automatically close tabs matching domain; mutually exclusive with Skip; clears/disables split path    |
| Exclusions      | Always skip non-normal windows (popups, panels), internal pages, and PWAs                             |

## Cleanup Logic

Destructive operations are applied **globally** to the entire browser session before any grouping logic occurs. This ensures that the workspace is clean regardless of how tabs were organized previously.

- **Global Deduplication**: Closes all tabs with duplicate URLs, keeping only the earliest instance. This applies to tabs inside manual groups as well.
- **Global Auto-Delete**: Immediately closes any tab matching a domain rule with `autoDelete: true`. Manual groups are not exempt from this rule to prevent blacklisted content from persisting.

## Flow (Orchestrated by `TabGroupingController.execute()`)

1.  **Trigger**: User clicks the extension icon or debounced tab event.
2.  **Fingerprint**: Calculate `lastStateHash`. If identical to previous successful run, return early.
3.  **Cleaning**: Global deduplication and auto-deletion (applies to ALL tabs).
4.  **Protection**: Identify remaining manual groups via `isInternalTitle`. Gather `protectedTabIds`.
5.  **State Retrieval**: Fetches user-defined rules and grouping configuration from the synchronized store.
6.  **Grouping Process (`processGrouping`)**:
    - **Stage 1 (Membership)**: `TabGroupingService.buildGroupStates` maps tabs to logical bundles. `ChromeTabAdapter.applyGroupState` performs functional grouping/ungrouping to establish group IDs.
    - **Stage 2 (Positioning)**: `TabGroupingService.calculateRepositionNeeds` calculates absolute `targetIndex` for every group, accounting for ignored tabs (PWAs, popups).
    - **Stage 3 (Planning)**: `TabGroupingService.createGroupPlan` identifies precisely which groups are out of position and which "intruder" tabs must be ejected from managed groups.
    - **Stage 4 (Execution)**: `ChromeTabAdapter.executeGroupPlan` applies the plan via Chrome API:
      - **Optimization**: Uses `chrome.tabGroups.move` for whole-group atomic repositions.
      - **Isolation**: Ungroups intruders from managed groups before moving blocks.
      - **Movement**: Uses `chrome.tabs.move` for atomic block-level tab shifts.
      - **Visual Sync**: Final update of Title and Color for managed and restored external groups.
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
- **Global Cleanup Priority:** Destructive operations (Deduplication and Auto-Deletion) are applied globally to **all** tabs before protection logic begins. This ensures that user-defined cleanup rules are session-wide and take precedence over group preservation.
- **Session Continuity (Metadata Restoration):** Manual group continuity across windows or re-bundling cycles is achieved by capturing visual metadata (`title`, `color`) before movement and restoring it immediately upon group reconstruction.
- **Execution Efficiency (Fingerprinting):** The `lastStateHash` mechanism ensures the extension only performs expensive API operations when the browser state (tabs, rules, or config) has actually changed. This in-memory "memory" persists throughout the extension's active lifecycle.
- **Rule Persistence:** Integration with `chrome.storage.local` via a synchronized store allows user-defined domain rules and grouping configurations to persist across browser restarts and extension updates.
