# Background Script Specification (`background.ts`)

This document outlines the architecture, critical behaviors, and design principles of the `background.ts` entry point for the One-click Tab Dedup/Group Manager extension.

## 1. Architectural Overview

The code follows a strict layered architecture to ensure testability, maintainability, and separation of concerns.

### 1.1 Domain Layer (`TabGroupingService` & `WindowManagementService`)

- **TabGroupingService**:
  - **Side-effect free**: Does not call Chrome APIs or external services.
  - **Logic**: Domain extraction, group key mapping, building group states, and calculating repositioning needs.
  - **Planning**: Generates a `GroupPlan` (a declarative set of actions: ungroup, move, group) that the Infrastructure layer executes.
  - **Window Awareness**: Calculations for target indices are scoped to a specific `targetWindowId` to prevent global index conflicts.
- **WindowManagementService**:
  - **Responsibility**: Calculates optimal merging strategies for multi-window environments.
  - **Heuristic**: When windows are limited (via `numWindowsToKeep`), it identifies "excess" tabs and maps them to "retained" windows.
  - **Optimization**: Favors windows that already contain matching domains (frequency-based scoring).
  - **Defaults**: `numWindowsToKeep` defaults to **2** (minimum 2).

### 1.2 Infrastructure Layer (`ChromeTabAdapter`)

- **Responsibility**: Abstraction of the Chrome Extension API.
- **Key Characteristics**:
  - **Normal Window Enforcement**: All operations are restricted to `windowType: "normal"`.
  - **Resilience**: Implements a `retry` mechanism with exponential backoff.
  - **Surgical Moves**: `executeGroupPlan` performs window-aware movement. If a tab is already in the target window at the target index, the move call is skipped.
  - **API Efficiency**: Re-uses browser snapshots passed from the application layer to avoid redundant `chrome.tabs.query` calls.

### 1.3 Application Layer (`TabGroupingController`)

- **Responsibility**: Orchestration and workflow management.
- **Unified Flow**: Treats both "Global" and "Per-Window" grouping as a single mapping operation. Global mode is simply a window map with one entry (the active window).
- **Logical Efficiency**: Ensures exactly **two** full browser state captures per run (one for the fingerprint, one for final planning).
- **Process Guarding**: Uses an `isProcessing` semaphore to prevent race conditions.

---

## 2. Performance & Visual Stability

The extension ensures operations are both efficient and visually stable (minimizing "tab flicker").

### 2.1 Layered Redundancy Checks

| Mechanism | Layer | Scope | Goal |
| :--- | :--- | :--- | :--- |
| **State Fingerprinting** | Application | Global | **Gatekeeper**: Skips the entire process if the global state (tabs, rules, config) is unchanged. |
| **State Synchronization** | Application | Scoped | **Accuracy**: Refreshes the internal cache (`cache.invalidate`) after grouping operations but before positioning to ensure target indices are calculated against current IDs. |
| **Lazy Movement Check** | Infrastructure | Local | **Surgical Execution**: Checks both `windowId` and `index` immediately before moving. Skips move if both match target state. |

### 2.2 Unified Global Merging (Zero-Flicker)

- **Old Approach**: Move all tabs to active window first (reshuffle), then sort (reshuffle again).
- **Optimized Approach**: No pre-emptive moves. Tabs stay in their original windows until the final plan is executed. `chrome.tabs.move` handles both window transition and index placement in **one single API call** per block.

---

## 3. Critical Behaviors & Design Patterns

### 3.1 External Group Protection & Title Management

- **Internal Title Detection**: `isInternalTitle` recognizes generated patterns (case-insensitive):
  - `domain`, `groupName`, `base - Title`, `base - segment`, or `base/segment`.
- **Title Fallbacks**: 
  - **Managed Groups**: Always have a title (falls back to `sourceDomain`).
  - **Manual (External) Groups**: Allowed to remain unnamed to respect explicit user organization.
- **Atomic Protection**: External groups move as cohesive blocks using `chrome.tabGroups.move`.

### 3.2 Stable Positioning Strategy

- **Pinned Priority**: Managed pinned tabs follow ignored pinned tabs.
- **Managed Anchor**: Managed unpinned tabs are anchored to the front of the unpinned section.
- **Ignored Displacement**: Non-managed tabs (PWAs, popups) are naturally displaced to the end of the window.

---

## 4. Data Flow

1.  **Trigger**: User clicks extension icon.
2.  **Fingerprint**: `lastStateHash` check. Skip if identical.
3.  **Clean**: Global deduplication and auto-deletion.
4.  **Partition**: Gather `protectedTabIds` from external groups.
5.  **Map Windows**: 
    - `byWindow: true` -> Map groups to their current/consolidated windows.
    - `byWindow: false` -> Map all groups to the `activeWindowId`.
6.  **Grouping Process**:
    - **Membership**: `applyGroupState` creates/merges groups.
    - **Refresh**: Capture fresh snapshot (Exactly 1 call).
    - **Plan**: `calculateRepositionNeeds` (window-scoped indices).
    - **Execute**: `executeGroupPlan` using the captured snapshot.

---

## 5. Test Coverage

| Category   | Test Case            | Description                                                                         |
| :--------- | :------------------- | :---------------------------------------------------------------------------------- |
| **Window** | Global Merging       | Verifies surgical, window-aware moves when `byWindow` is false.                     |
|            | Per-Window Grouping  | Verifies grouping logic is isolated per window when `byWindow` is true.             |
|            | Cross-Window Merge   | Verifies manual groups are re-bundled correctly when moving windows.                |
| **Group**  | External Protection  | Verifies manual groups are treated as atomic blocks.                                |
|            | Intruder Detection   | Verifies tabs that don't belong in a managed group are ejected.                     |
| **Perf**   | State Fingerprinting | Verifies early-exit logic when state hash is unchanged.                             |
|            | Lazy Movement        | Verifies `chrome.tabs.move` is skipped if tab/window is already correct.            |
|            | API Consolidation    | Verifies minimum number of `getNormalTabs` and `query` calls per run.               |
