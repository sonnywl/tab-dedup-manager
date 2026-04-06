# One-click Tab Dedup/Group Manager Rules

## Development Mandates

- **Role**: During coding, planning, and discussions, work as a **professional architect**. Ensure that code readability and architectural quality are retained or improved in every change.
- **Agents**: Use architecture and coding subagents to monitor and get feedback about your execution and plans. Code quality, simplification, and logical soundness. Agree on the plan before providing the final proposal. If there are problems prompt back DO NOT EXECUTE.
- **Goals**: Continuously look for opportunities to improve **conciseness** and **performance** while strictly adhering to the defined rules and specifications.
- **Guidance**: Use the project specs (`SPEC.md`) and rules (`GEMINI.md`) as the primary foundational guidance for all decisions. If specs does not make sense prompt back.
- **Clarification**: If a requested change or proposed behavior contradicts the established specifications (`SPEC.md`) or foundational rules (`GEMINI.md`), **proactively ask the user for clarity** before proceeding with implementation.
- **Thinking Time**: Do not process long-running assumptions on tests to verify instead of thinking (< 1min is ideal). If too long return the current context and pass to a new agent.
- **Clean Code Mandate**: Adhere strictly to the **Single Responsibility Principle (SRP)**. Maintain architectural "lean-ness" by ensuring data flow is single-source-of-truth and dependencies are injected. Remove dead code and redundant parameters immediately.
- **Styling**: **Use Tailwind CSS** for all UI components. This project is built with Tailwind CSS; do not use Vanilla CSS or other frameworks.
- **Format**: Always prettier format the code after changes.

## Architecture

The application is structured into three distinct layers with all shared data structures consolidated in `src/types.ts`:

1.  **Domain Layer (`src/utils/grouping.ts`):** Pure business logic. Side-effect free. Responsible for domain extraction, group mapping, repositioning needs (via **Longest Increasing Subsequence** for visual stability), and window merging heuristics.
2.  **Infrastructure Layer (`src/core/ChromeTabAdapter.ts`):** Encapsulates all Chrome API interactions and low-level utilities (**retry with backoff**, atomic operations). Implements surgical, window-aware execution with best-effort rollbacks.
3.  **Application Layer (`src/core/TabGroupingController.ts`):** Unified orchestration. Manages **State Fingerprinting**, process guarding, and high-level workflow. Uses **Dependency Injection** for all services and adapters.

## Requirements & Invariants

| Rule             | Behavior                                                                                                         |
| ---------------- | ---------------------------------------------------------------------------------------------------------------- |
| Group threshold  | 2+ tabs with same group key (domain + path) → group, 1 tab → ungroup.                                            |
| Grouping Scope   | Global (merge all to active window) OR per-window grouping.                                                      |
| Window Limit     | Optional `numWindowsToKeep` (defaults to **2**). Excess windows merge into high-affinity retained windows based on domain frequency. |
| Sort order       | **Managed Pinned**: Groups → Manual → Managed → Stable ID. **Managed Unpinned**: Internal Pages → Clustered Groups → Title/URL. |
| Performance      | **State Fingerprinting**: Skip entire process if hash (Tabs + Rules + Config) is unchanged.                      |
| Visual Stability | **Atomic Execution**: Plan on intended state, execute changes sequentially with stability delays.                |
| Exclusions       | Always skip non-normal windows and extension-owned pages. Internal pages are managed and sorted to the front.    |

## Cleanup Logic (Global Priority)

Destructive operations are applied **globally** to the entire session before phase 1.

- **Global Deduplication**: Closes duplicate URLs session-wide, keeping the earliest occurrence in the current tab list (Win 1 > Win 2 ...).
- **Global Auto-Delete**: Immediately closes tabs matching domain rules with `autoDelete: true`.
- **Internal Page Pre-sort**: Moves internal browser pages (`edge://`, `chrome://`, etc.) to the start of each window to ensure they don't interleave with managed content.
- **Global Single-Tab Ungroup** (Optional): Immediately ungroups any managed group that contains only one tab.

## Execution Flow (Unified Orchestration)

1.  **Config**: Load current rules and grouping settings.
2.  **Fingerprint**: Calculate `lastStateHash`. Exit early if no change.
3.  **Cleaning**: Session-wide deduplication, auto-deletion, and optional single-tab ungrouping.
4.  **Phase 1: Consolidation**: If configured, consolidate windows exceeding `numWindowsToKeep` into high-affinity targets.
5.  **Phase 2: Grouping Pass**:
    - **Phase 2a: Membership**: Identify `protectedTabIds`, build `GroupMap`, and execute `MembershipPlan` (ungroup/group/title) on the current state.
    - **Phase 2b: Ordering (Reality Check)**: Recapture fresh state to get actual indices and IDs, calculate reposition needs using LIS, and execute `OrderPlan` (absolute positioning).
    - **Cleanup**: Final pass to ensure no single-tab managed groups remain.

## Learnings & Best Practices

- **Group-Block Stability:** Prefer moving entire groups using `chrome.tabGroups.move` to preserve metadata and minimize visual disruption, as opposed to moving individual tabs.
- **Window-Scoped Coordinates:** Chrome indices are per-window. Repositioning logic must be `targetWindowId` aware to prevent index conflicts during global merges.
- **Atomic Manual Groups:** Move external groups as cohesive blocks using `chrome.tabGroups.move` to preserve their internal order and metadata.
- **Snapshot Re-use:** Pass browser snapshots (`tabs` and `groups` arrays) between methods to avoid redundant `chrome.tabs.query` calls.
- **Port-Aware Grouping:** Uses `url.host` instead of `url.hostname` to ensure different services on `localhost` (e.g., `:8000`, `:3000`) are grouped separately, improving developer workflow.
- **Case-Insensitive Consolidation:** Always normalize path segments in group keys and perform a final case-insensitive merge pass on `GroupState` display names within their respective sections (Pinned/Unpinned). This prevents redundant groups when URLs have varying casing.
- **Stability sorting**: Always include `(a.id ?? 0) - (b.id ?? 0)` as a fallback in sorts to prevent "jitter" when URLs are identical.
- **ID Generation**: Use `crypto.randomUUID()` in the UI for unique rule IDs to avoid collisions during rapid edits.
