# Tab Grouper: Intelligent, Non-Destructive Tab Management

**Tab Grouper** is a high-performance Chrome extension that organizes your browser chaos without getting in your way. Unlike other organizers that force a rigid structure, Tab Grouper respects your manual workflow while automating the tedious parts.

## 🚀 For Users: Why You'll Love It

*   **Respects Your Work:** Manually created groups are **locked**. We treat them as atomic blocks—moving them as a whole but never ungrouping or messing with your curated sets.
*   **Smart Automation:** Automatically groups tabs by domain (e.g., all `github.com` tabs together). Single tabs are kept ungrouped for easy access.
*   **Performance First:** Built for speed. We use advanced state hashing to ensure the extension only acts when necessary, saving battery and CPU.
*   **Cross-Window Merging:** Intelligently consolidates scattered tabs from multiple windows into focused workspaces based on content affinity.
*   **Privacy Focused:** 100% local processing. Your browsing data never leaves your machine.

## 🛠️ For Developers: Built for Scale

Tab Grouper isn't just a script; it's an engineered system designed for maintainability and correctness.

*   **Layered Architecture:** Clear separation between **Domain Logic** (pure functions), **Application State** (orchestration), and **Infrastructure** (Chrome API adapters).
*   **Invariant-Based Testing:** We use `fast-check` for property-based testing to mathematically prove that our grouping logic holds true under thousands of random tab permutations.
    *   *Invariant:* Manual groups never lose their tabs.
    *   *Invariant:* Sorting is always deterministic.
*   **Optimized API Usage:**
    *   **Atomic Moves:** Uses `chrome.tabGroups.move` to move entire groups in a single API call, preventing visual jitter.
    *   **State Diffing:** Calculates a hash of the current browser state to skip redundant processing loops.
    *   **Reconciliation:** Smart diffing logic ensures we only `group`, `ungroup`, or `move` when absolutely necessary.

### Installation

1.  Clone the repository.
2.  Run `npm install`.
3.  Run `npm run build`.
4.  Load the `build` directory as an unpacked extension in Chrome.
