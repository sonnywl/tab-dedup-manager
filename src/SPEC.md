# Background Script Specification (`background.ts`)

This document outlines the architecture, critical behaviors, and design principles of the `background.ts` entry point for the Tab Grouper extension.

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

## 4. Domain Rules & Grouping Logic

### 4.1 Rule Configuration
- **domain**: The hostname.
- **autoDelete**: Automatically close tabs (Mutually exclusive with `skipProcess`).
- **skipProcess**: Ignore domain (Mutually exclusive with `autoDelete`).
- **groupName**: Custom title override.
- **splitByPath**: Group by `n`-th path segment. Formats title as `${base} - ${segment}`.
