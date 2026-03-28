# Background Script Specification (`background.ts`)

This document outlines the architecture, critical behaviors, and design principles of the `background.ts` entry point for the One-click Tab Dedup/Group Manager extension.

## 1. Architectural Overview

The code follows a strict layered architecture to ensure testability, maintainability, and separation of concerns. All shared data structures and validation logic are centralized in `src/types.ts`.

### 1.1 Domain Layer (`src/utils/grouping.ts`)

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

### 1.2 Infrastructure Layer (`src/core/ChromeTabAdapter.ts`)

- **Responsibility**: Abstraction of the Chrome Extension API and low-level utility functions (`retry`, `runAtomicOperation`).
- **Key Characteristics**:
  - **Normal Window Enforcement**: All operations are restricted to `windowType: "normal"`.
  - **Resilience**: Implements a `retry` mechanism for all destructive or movement-based API calls.
  - **Surgical Execution**: `executeGroupPlan` is the single point of contact for side-effects (ungroup, move, group, title). It executes the plan sequentially and uses `RATE_DELAY` (30ms) for Chrome stability.
  - **Internal Page Management**: Now includes system/browser internal pages (`edge://`, `chrome://`, etc.) to manage their sorting and prevent them from interleaving with managed content.
  - **API Efficiency**: Re-uses browser snapshots passed from the application layer to avoid redundant `chrome.tabs.query` calls.

### 1.3 Application Layer (`src/core/TabGroupingController.ts`)

- **Responsibility**: Orchestration, workflow management, and state fingerprinting.
- **Unified Flow**: Treats both "Global" and "Per-Window" grouping as a single mapping operation. Global mode is simply a window map with one entry (the active window).
- **Dependency Injection**: Services and adapters are injected via the constructor, allowing for easy mocking in tests.
- **Thinking -> Doing separation**: The logic is split into a pure pipeline (Thinking) and a surgical execution (Doing).
- **Logical Efficiency**: Ensures exactly **two** full browser state captures per run (one for the fingerprint, one for the execution pass).
- **Process Guarding**: Uses an `isProcessing` semaphore to prevent race conditions.

### 1.4 Shared Types & Validation (`src/types.ts`)

- **Centralization**: All interfaces (`Tab`, `Rule`, `GroupState`, `GroupPlan`, etc.) are defined in a single location to eliminate circular dependencies.
- **Validation**: Contains core validation logic like `validateRule` and type guards (`isGrouped`, `asTabId`).
- **Standardization**: Enforces consistency across the options UI (`App.tsx`) and background processes.

---

## 2. Performance & Visual Stability

The extension ensures operations are both efficient and visually stable (minimizing "tab flicker").

### 2.1 Layered Redundancy Checks

| Mechanism                | Layer       | Scope  | Goal                                                                                                                   |
| :----------------------- | :---------- | :----- | :--------------------------------------------------------------------------------------------------------------------- |
| **State Fingerprinting** | Application | Global | **Gatekeeper**: Skips the entire process if the global state (tabs, rules, config) is unchanged.                       |
| **Atomic Planning**      | Domain      | Global | **Intended State**: Logic calculates final targets as if cleanup/merges already happened, ensuring one-click finality. |

### 2.2 Unified Global Merging (Zero-Flicker)

- **Old Approach**: Move all tabs to active window first (reshuffle), then sort (reshuffle again).
- **Optimized Approach**: No pre-emptive moves. Tabs stay in their original windows until the final plan is executed. `chrome.tabs.move` handles both window transition and index placement in **one single API call** per block.

---

## 3. Critical Behaviors & Design Patterns

## 3. Critical Behaviors & Design Patterns

### 3.1 External Group Protection & Title Management

- **Internal Title Detection**: `isInternalTitle` recognizes generated patterns (case-insensitive):
  - `domain`, `groupName`, `base - Title`, `base - segment`, or `base/segment`.
  - It handles collision-resolved variants (e.g., "google.com - Search") and path-segment variants.
- **Title Fallbacks**:
  - **Managed Groups**: Always have a title based on the rule or domain. If `splitByPath` is used, the title follows the `segment - base` or `segment/base` pattern.
  - **Manual (External) Groups**: Allowed to remain unnamed or have custom titles; they are protected if their title does not match the managed patterns.
- **Atomic Protection**: External groups move as cohesive blocks using `chrome.tabGroups.move`.

### 3.2 Stable Positioning Strategy

The layout follows a deterministic order:

1.  **Ignored Pinned**: Non-managed pinned tabs (e.g., system pages explicitly pinned by the user) remain at the very front.
2.  **Managed Pinned**: Sorted by "Group vs Tab" (groups first), then "Protected vs Managed" (manual groups first), and finally by Stable ID.
3.  **Managed Unpinned**:
    - **Internal Pages**: Unpinned system pages (`edge://`, `chrome://`, etc.) are placed first, sorted alphabetically by host.
    - **Clustered**: Groups (2+ tabs or Manual groups) are placed next.
    - **Sorted**: Within clusters and individual tabs, items are sorted by Title (lexicographical) and then URL/ID for stability.
4.  **Ignored Unpinned**: Unmanaged unpinned tabs (e.g., extension popups) are naturally displaced to the end of the window.

### 3.3 Grouping Threshold & Path Splitting

- **Threshold**: 2+ tabs with the same group key (domain + path segment if applicable) form a group. 1 tab is ungrouped.
- **Path Splitting**: Rules can define `splitByPath` (index-based). This creates unique group keys per path segment, allowing tabs like `github.com/org1` and `github.com/org2` to be grouped separately.
- **Single-Tab Ungrouping**: If a group (managed) is left with only one tab after moves or cleanup, it is explicitly ungrouped in a final pass.

---

## 4. Data Flow

1.  **Trigger**: User clicks extension icon.
2.  **Load Config**: Fetch rules and grouping settings from sync storage.
3.  **Fingerprint**: `lastStateHash` check. Skip if identical.
4.  **Clean**: Global deduplication (keeping the first occurrence), auto-deletion, internal page pre-sorting, and optional single-tab ungrouping.
5.  **Phase 1: Window Consolidation**: If `byWindow` is true and windows exceed `numWindowsToKeep`, merge excess tabs/groups into high-affinity retained windows based on domain frequency.
6.  **Phase 2: Grouping Pass**:
    - **Mapping**: Build `GroupMap` based on rules, `splitByPath`, and protected group status.
    - **States**: `buildGroupStates` creates the virtual target state.
    - **Needs**: `calculateRepositionNeeds` determines which tabs/groups actually need physical movement or title updates.
    - **Plan**: `createGroupPlan` generates declarative instructions (ungroup, move, group).
    - **Execute**: `executeGroupPlan` performs physical changes atomically, including a final single-tab ungrouping pass.

---

## 5. Testing Strategy

The system is verified through a tiered testing approach:

1.  **Unit Tests (`background.test.ts`)**: Verify isolated logic in `TabGroupingService`, and `ChromeTabAdapter` edge cases.
2.  **E2E Integration Tests (`background.e2e.test.ts`)**: Verify the unified orchestration of the `TabGroupingController`.
3.  **Property-Based Tests (`background.e2e.test.ts` via `fast-check`)**: Exhaustively verify structural invariants and manual group persistence across 100+ random tab/window configurations.

### Requirements & Invariants Traceability Matrix

| Requirement                                 | Test(s)                                                                            | Status       |
| :------------------------------------------ | :--------------------------------------------------------------------------------- | :----------- |
| **Group threshold (2+ tabs)**               | `Invariant: Managed group titles follow rules...`                                  | **Verified** |
| **1 tab -> ungroup, move to end**           | `E2E: splitByPath correctly groups tabs by root...`                                | **Verified** |
| **Global Grouping (byWindow: false)**       | `Invariant: When byWindow is false...`                                             | **Verified** |
| **Per-window Grouping (byWindow: true)**    | `Invariant: When byWindow is true...`                                              | **Verified** |
| **Window Consolidation (numWindowsToKeep)** | `E2E: numWindowsToKeep correctly consolidates...`                                  | **Verified** |
| **Manual Group Protection**                 | `Invariant: Manual groups are moved atomically`                                    | **Verified** |
| **Manual Group Order Persistence**          | `Invariant: Manual groups preserve their internal tab order`                       | **Verified** |
| **State Fingerprinting**                    | `TabGroupingController > execute() > skips when state hash unchanged`              | **Verified** |
| **Atomic Planning**                         | `TabGroupingController > execute() > is idempotent: second execution does nothing` | **Verified** |
| **Global Deduplication**                    | `E2E: global deduplication closes duplicate URLs session-wide...`                  | **Verified** |
| **Global Auto-Delete**                      | `E2E: autoDelete rule correctly closes tabs session-wide...`                       | **Verified** |
| **Exclusions (Popups, PWAs)**               | `ChromeTabAdapter > getNormalTabs correctly filters...`                   | **Verified** |
