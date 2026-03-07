# One-click Tab Dedup/Group Manager Rules

## Development Mandates

- **Role**: During coding, planning, and discussions, work as a **professional architect**. Ensure that code readability and architectural quality are retained or improved in every change.
- **Goals**: Continuously look for opportunities to improve **conciseness** and **performance** while strictly adhering to the defined rules and specifications.
- **Guidance**: Use the project specs (`SPEC.md`) and rules (`GEMINI.md`) as the primary foundational guidance for all decisions.
- **Clarification**: If a requested change or proposed behavior contradicts the established specifications (`SPEC.md`) or foundational rules (`GEMINI.md`), **proactively ask the user for clarity** before proceeding with implementation.
- **Thinking Time**: Do not process long-running assumptions on tests to verify instead of thinking (< 1min is ideal).
- **Clean Code Mandate**: Remove dead code and redundant parameters immediately. Maintain architectural "lean-ness" by ensuring data flow is single-source-of-truth and parameters are strictly used.
- **Format** Always prettier format the code after changes

## Architecture

The application is structured into three distinct layers:

1.  **Domain Layer (`TabGroupingService` & `WindowManagementService`):** Pure business logic. side-effect free. Responsible for domain extraction, group mapping, repositioning needs (window-aware), and window merging heuristics.
2.  **Infrastructure Layer (`ChromeTabAdapter`):** Encapsulates all Chrome API interactions. Implements resilient retry mechanisms, atomic movements, and surgical window-aware execution.
3.  **Application Layer (`TabGroupingController`):** Unified orchestration. Treats global and per-window grouping as a single mapping flow. Manages state fingerprinting and process guarding.

## Requirements & Invariants

| Rule             | Behavior                                                                                       |
| ---------------- | ---------------------------------------------------------------------------------------------- |
| Group threshold  | 2+ tabs with same domain (or group key) → group, 1 tab → ungroup, move to end                  |
| Grouping Scope   | Global (merge all to active window) OR per-window grouping.                                    |
| Window Limit     | Optional `numWindowsToKeep` (min 2). Excess windows merge into high-affinity retained windows. |
| Sort order       | Protected (Manual) → Pinned → Stable ID. Groups sorted by URL → Ungrouped sorted by URL.       |
| Performance      | **State Fingerprinting**: Skip entire process if hash (Tabs + Rules + Config) is unchanged.    |
| Visual Stability | **Lazy Moves**: Check `windowId` and `index` 1ms before moving. Skip if already correct.       |
| Exclusions       | Always skip non-normal windows (popups), internal pages, and PWAs.                             |

## Cleanup Logic (Global Priority)

Destructive operations are applied **globally** before any grouping logic.

- **Global Deduplication**: Closes duplicate URLs session-wide, keeping the earliest instance.
- **Global Auto-Delete**: Immediately closes tabs matching domain rules with `autoDelete: true`.
- **Note**: Manual groups are NOT exempt from global cleanup (Deduplication/Delete).

## Execution Flow (Unified Orchestration)

1.  **Fingerprint**: Calculate `lastStateHash`. Exit early if no change.
2.  **Cleaning**: Session-wide deduplication and auto-deletion.
3.  **Protection**: Identify manual groups via `isInternalTitle`. Gather `protectedTabIds`.
4.  **Unified Mapping**:
    - `byWindow: true` -> Map groups to current/consolidated windows.
    - `byWindow: false` -> Map ALL groups to the `activeWindowId`.
5.  **Planning Phase**: Build `GroupState` objects and calculate `targetIndex` for all groups (window-aware).
6.  **Surgical Execution**: Capture **Exactly One** fresh snapshot. `executeGroupPlan` performs all physical changes (ungroup, move, group, title) atomically using **Lazy Checks**.

## Learnings & Best Practices

- **Zero-Flicker Merging:** Never move tabs pre-emptively. Wait for the final plan and use `chrome.tabs.move` to perform window transitions and index placement simultaneously.
- **Window-Scoped Coordinates:** Chrome indices are per-window. Repositioning logic must be `targetWindowId` aware to prevent index conflicts during global merges.
- **Atomic Manual Groups:** Move external groups as cohesive blocks using `chrome.tabGroups.move` to preserve their internal order and metadata.
- **Snapshot Re-use:** Pass browser snapshots (`tabs` and `groups` arrays) between methods to avoid redundant `chrome.tabs.query` calls.
- **Stability sorting**: Always include `(a.id ?? 0) - (b.id ?? 0)` as a fallback in sorts to prevent "jitter" when URLs are identical.
