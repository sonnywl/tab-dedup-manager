# Background Script Specification (`background.ts`)

This document outlines the architecture, critical behaviors, and design principles of the `background.ts` entry point for the One-click Tab Dedup/Group Manager extension.

## 1. Architectural Overview

The code follows a strict layered architecture to ensure testability, maintainability, and separation of concerns.

### 1.1 Domain Layer (`TabGroupingService` & `WindowManagementService`)
- **TabGroupingService**:
    - **Side-effect free**: Does not call Chrome APIs or external services.
    - **Logic**: Domain extraction, group key mapping, building group states, and calculating repositioning needs.
    - **Planning**: Generates a `GroupPlan` (a declarative set of actions: ungroup, move, group) that the Infrastructure layer executes.
- **WindowManagementService**:
    - **Responsibility**: Calculates optimal merging strategies for multi-window environments.
    - **Heuristic**: When windows are limited (via `numWindowsToKeep`), it identifies "excess" tabs and maps them to "retained" windows.
    - **Optimization**: Favors windows that already contain matching domains to minimize fragmentation.

### 1.2 Infrastructure Layer (`ChromeTabAdapter`)
- **Responsibility**: Abstraction of the Chrome Extension API.
- **Key Characteristics**:
    - **Normal Window Enforcement**: All operations are restricted to `windowType: "normal"`.
    - **Resilience**: Implements a `retry` mechanism with exponential backoff.
    - **Atomic Execution**: `executeGroupPlan` distinguishes between managed and external groups. External groups are moved as single, atomic blocks of tabs to preserve their manual ID and title.

### 1.3 Application Layer (`TabGroupingController`)
- **Responsibility**: Orchestration and workflow management.
- **Key Characteristics**:
    - **Process Guarding**: Uses an `isProcessing` semaphore to prevent race conditions.
    - **State Fingerprinting**: Employs a `lastStateHash` mechanism. It calculates a hash of the current tabs (IDs, URLs, group IDs, window IDs, indices), rules, and configuration. If the hash hasn't changed since the last successful execution, it skips the entire grouping process.

---

## 2. Critical Behaviors & Design Patterns

### 2.1 External Group Protection
The extension respects organizations created manually by the user for grouping and sorting, but applies destructive cleanup rules globally.
- **Internal Title Detection**: `isInternalTitle` recognizes generated patterns (case-insensitive):
  - `domain` or `groupName`
  - `base - Title` (Collision resolution)
  - `base - segment` (Split path)
  - `base/segment` (Legacy split path)
- **Atomic Protection**: Groups with "external" titles are marked as `isExternal`.
- **Destructive Cleanup (Global)**: Deduplication and `autoDelete` rules are applied to **all** tabs, including those in external groups. Protection only applies to grouping/ungrouping logic.
- **Execution**: During `executeGroupPlan`, external groups skip `ungroup` and `group` stages. They are moved only as a cohesive block, and their visual metadata (Title and Color) is restored if the group had to be re-created.

### 2.2 Custom Group Names (`groupName`)
- `groupName` acts as the base for the group title.
- If `splitByPath` is active, the title becomes `${groupName} - ${segment}`.
- The extension adopts existing groups if their title matches the rule's current `groupName`.

---

## 3. Data Flow

1.  **Trigger**: User clicks the extension icon.
2.  **Fingerprint**: `lastStateHash` check. Skip if state is identical.
3.  **Clean**: Global deduplication and auto-deletion based on domain rules.
4.  **Partition**: Gather `protectedTabIds` from remaining external groups.
5.  **Plan**: Domain layer builds `GroupPlan`. External groups are flagged for atomic movement.
6.  **Execute**: Infrastructure layer applies the plan, restoring manual group metadata (Title/Color) where necessary.

---

## 4. Cleanup Logic

Cleanup operations are destructive and are applied **globally** to ensure a lean browser state. These operations intentionally bypass "External Group Protection" to honor user-defined rules and maintain performance.

### 4.1 Global Deduplication
- **Behavior**: Scans all open normal tabs for duplicate URLs.
- **Enforcement**: Keeps the first occurrence (lowest index) and closes all subsequent matches.
- **Global Nature**: If a manual group contains a tab that is a duplicate of a tab elsewhere (or another tab within the same manual group), the duplicate will be removed.

### 4.2 Global Auto-Deletion
- **Behavior**: Closes any tab whose domain matches a rule where `autoDelete: true`.
- **Enforcement**: Happens immediately during the `prepareTabs` phase.
- **Global Nature**: Tabs in manual groups are deleted if they match an auto-delete rule. This ensures that "Blacklisted" domains cannot persist simply by being grouped.

---

## 5. Test Coverage

The following table summarizes the scenarios verified by unit tests (`background.test.ts`) and property-based E2E tests (`background.e2e.test.ts`).

| Category | Test Case | Description | Source |
| :--- | :--- | :--- | :--- |
| **Window** | Global Merging | Verifies all tabs move to active window when `byWindow` is false. | `background.test.ts` |
| | Per-Window Grouping | Verifies grouping logic is isolated per window when `byWindow` is true. | `background.test.ts` |
| | Window Consolidation | Verifies excess windows are merged into retained windows based on domain affinity. | `background.test.ts` |
| | Cross-Window Merge | Verifies manual groups are re-bundled after being scattered across windows. | `background.e2e.test.ts` |
| **Group** | External Protection | Verifies manual groups are treated as atomic blocks and not functionally altered. | `background.test.ts` |
| | Internal vs External | Distinguishes between automated (`internal`) and manual (`external`) groups. | `background.test.ts` |
| | Split-Path Grouping | Verifies groups are created based on URL path segments (new and legacy formats). | `background.test.ts` |
| | Custom Naming | Verifies `groupName` rules override domain-default titles. | `background.test.ts` |
| | Metadata Persistence | Verifies Title and Color are restored during manual group reconstruction. | `background.e2e.test.ts` |
| | Atomic Movement | Verifies entire groups move together without dissolving (using `tabGroups.move`). | `background.e2e.test.ts` |
| | Order Preservation | Verifies internal tab order within manual groups is preserved during moves. | `background.e2e.test.ts` |
| | Intruder Detection | Verifies tabs that don't belong in a managed group (wrong domain/path) are ejected. | `background.test.ts` |
| | Dissolution | Verifies that managed groups are dissolved when reduced to a single tab. | `background.test.ts` |
| | Multi-Domain Merge | Verifies two domains mapping to the same `groupName` merge into one group. | `background.test.ts` |
| **Tabs** | Global Deduplication | Verifies duplicate URLs are removed globally, even within manual groups. | `background.test.ts` |
| | Global Auto-Delete | Verifies tabs matching `autoDelete` rules are removed globally. | `background.test.ts` |
| | Skip Rule | Verifies domains with `skipProcess: true` are ignored by the extension. | `background.test.ts` |
| | Sorting Stability | Verifies deterministic sort order: Protected → Pinned → ID Stability. | `background.test.ts` |
| | Domain Extraction | Verifies correct hostname extraction and "www." stripping. | `background.test.ts` |
| | State Fingerprinting | Verifies early-exit logic when browser state (hash) is unchanged. | `background.test.ts` |
| | Internal Exclusion | Verifies `chrome://`, `about:`, etc. are excluded from processing. | `background.test.ts` |
| | PWA Exclusion | Verifies non-normal windows/tabs (popups, panels) are ignored. | `background.test.ts` |
