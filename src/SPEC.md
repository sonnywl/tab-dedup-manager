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
  - **Resilience**: Implements a `retry` mechanism.
  - **Surgical Execution**: `executeGroupPlan` is the single point of contact for side-effects (ungroup, move, group, title). It uses "Lazy Checks" to skip redundant API calls and `TAB_UPDATE_DELAY` (50ms) for Chrome stability.
  - **API Efficiency**: Re-uses browser snapshots passed from the application layer to avoid redundant `chrome.tabs.query` calls.

### 1.3 Application Layer (`TabGroupingController`)

- **Responsibility**: Orchestration and workflow management.
- **Unified Flow**: Treats both "Global" and "Per-Window" grouping as a single mapping operation. Global mode is simply a window map with one entry (the active window).
- **Thinking -> Doing separation**: The logic is split into a pure pipeline (Thinking) and a surgical execution (Doing).
- **Logical Efficiency**: Ensures exactly **two** full browser state captures per run (one for the fingerprint, one for the execution pass).
- **Process Guarding**: Uses an `isProcessing` semaphore to prevent race conditions.

---

## 2. Performance & Visual Stability

The extension ensures operations are both efficient and visually stable (minimizing "tab flicker").

### 2.1 Layered Redundancy Checks

| Mechanism                | Layer          | Scope  | Goal                                                                                                                         |
| :----------------------- | :------------- | :----- | :--------------------------------------------------------------------------------------------------------------------------- |
| **State Fingerprinting** | Application    | Global | **Gatekeeper**: Skips the entire process if the global state (tabs, rules, config) is unchanged.                             |
| **Lazy Movement Check**  | Infrastructure | Local  | **Surgical Execution**: Checks both `windowId` and `index` immediately before moving. Skips move if both match target state. |

### 2.2 Unified Global Merging (Zero-Flicker)

- **Old Approach**: Move all tabs to active window first (reshuffle), then sort (reshuffle again).
- **Optimized Approach**: No pre-emptive moves. Tabs stay in their original windows until the final plan is executed. `chrome.tabs.move` handles both window transition and index placement in **one single API call** per block.

---

## 3. Critical Behaviors & Design Patterns

### 3.1 External Group Protection & Title Management

- **Internal Title Detection**: `isInternalTitle` recognizes generated patterns (case-insensitive):
  - `domain`, `groupName`, `base - Title`, `base - segment`, or `base/segment`.
- **Title Fallbacks**:
  - **Managed Groups**: Always have a title (falls back to `sourceDomain` or "Managed Group").
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
3.  **Clean**: Global deduplication, auto-deletion, and optional single-tab ungrouping.
4.  **Partition**: Gather `protectedTabIds` from external groups.
5.  **Map Windows**:
    - `byWindow: true` -> Map groups to their current/consolidated windows.
    - `byWindow: false` -> Map all groups to the `activeWindowId`.
6.  **Simplified Pipeline**:
    - **Mapping**: Build `GroupMap` based on rules and proximity.
    - **Needs**: `calculateRepositionNeeds` determines virtual targets and titling needs.
    - **Plan**: `createGroupPlan` generates declarative instructions.
    - **Execute**: `executeGroupPlan` captures a final snapshot and performs all physical changes (ungroup, move, group, title) atomically using Lazy Checks.

---

## 5. Testing Strategy

The system is verified through a tiered testing approach:

1.  **Unit Tests (`background.test.ts`)**: Verify isolated logic in `CacheManager`, `TabGroupingService`, and `ChromeTabAdapter` edge cases.
2.  **E2E Integration Tests (`background.e2e.test.ts`)**: Verify the unified orchestration of the `TabGroupingController`.
3.  **Property-Based Tests (`background.e2e.test.ts` via `fast-check`)**: Exhaustively verify structural invariants and manual group persistence across 100+ random tab/window configurations.

### Requirements & Invariants Traceability Matrix

| Requirement                                 | Test(s)                                                                        | Status       |
| :------------------------------------------ | :----------------------------------------------------------------------------- | :----------- |
| **Group threshold (2+ tabs)**               | `Invariant: Managed group titles follow rules...`                              | **Verified** |
| **1 tab -> ungroup, move to end**           | `E2E: splitByPath correctly groups tabs by root...`                            | **Verified** |
| **Global Grouping (byWindow: false)**       | `Invariant: When byWindow is false...`                                         | **Verified** |
| **Per-window Grouping (byWindow: true)**    | `Invariant: When byWindow is true...`                                          | **Verified** |
| **Window Consolidation (numWindowsToKeep)** | `E2E: numWindowsToKeep correctly consolidates...`                              | **Verified** |
| **Manual Group Protection**                 | `Invariant: Manual groups are moved atomically`                                | **Verified** |
| **Manual Group Order Persistence**          | `Invariant: Manual groups preserve their internal tab order`                   | **Verified** |
| **State Fingerprinting**                    | `TabGroupingController > execute() > skips when state hash unchanged`          | **Verified** |
| **Lazy Moves (Visual Stability)**           | `ChromeTabAdapter > executeGroupPlan() > skips move if already at targetIndex` | **Verified** |
| **Global Deduplication**                    | `E2E: global deduplication closes duplicate URLs session-wide...`              | **Verified** |
| **Global Auto-Delete**                      | `E2E: autoDelete rule correctly closes tabs session-wide...`                   | **Verified** |
| **Exclusions (Popups, PWAs, Internal)**     | `ChromeTabAdapter > excludes internal pages in getNormalTabs...`               | **Verified** |
