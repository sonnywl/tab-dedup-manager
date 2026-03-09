# One-click Tab Dedup/Group Manager: Intelligent, Instant Browser Organization

**Instantly declutter your browser with a single click.** One-click Tab Dedup/Group Manager is a high-performance Chrome extension that automates your browser chaos without getting in your way. Unlike other organizers that force a rigid structure, we respect your manual workflow while providing powerful, one-click automation for the tedious parts.

Available on the [Chrome Web Store](https://chromewebstore.google.com/detail/one-click-tab-dedupgroup/ijiodcedhlelfclifbjgnkdfeaknakkk?authuser=0&hl=en).

## 🚀 Key Features

- **⚡ Instant One-Click Grouping:** Group all your open tabs by domain automatically. Turn chaos into structured workspaces in less than a second.
- **🧹 Global Deduplication:** Instantly find and close duplicate URLs across all your browser windows. Reclaim your system memory and focus.
- **🔒 Manual Group Protection:** We respect your workflow. Manually created tab groups are treated as "Protected Blocks"—we'll move them for you, but we’ll never break them apart.
- **📂 Smart Window Consolidation:** Open too many windows? Automatically merge scattered tabs into your most relevant windows based on what you’re working on.
- **🎨 Custom Organization Rules:** Define custom rules to split groups by URL path or assign permanent names to your favorite domains.
- **🚀 Zero-Flicker Performance:** Engineered for speed. We use atomic API calls to ensure tabs move smoothly without visual jitter or UI lag.
- **🕵️ Incognito Support:** Works seamlessly in Incognito mode (requires "Allow in Incognito" permission).

## 🛠️ For Developers: Built for Scale

One-click Tab Dedup/Group Manager isn't just a script; it's an engineered system designed for maintainability and correctness.

- **Layered Architecture:** Clear separation between **Domain Logic** (pure functions), **Application State** (orchestration), and **Infrastructure** (Chrome API adapters).
- **Invariant-Based Testing:** We use `fast-check` for property-based testing to mathematically prove that our grouping logic holds true under thousands of random tab permutations.
  - _Invariant:_ Manual groups never lose their tabs.
  - _Invariant:_ Sorting is always deterministic.
- **Optimized API Usage:**
  - **Atomic Moves:** Uses `chrome.tabGroups.move` to move entire groups in a single API call, preventing visual jitter.
  - **State Fingerprinting:** Calculates a hash of the current browser state (Tabs + Rules + Config) to skip redundant processing loops.
  - **Lazy Moves:** Checks `windowId` and `index` 1ms before moving. Skips if already correct.
  - **Robust Title Updates:** Batches title updates to the end of the execution cycle to ensure correct rendering across all Chromium browsers (Chrome, Brave, Edge).

### Installation

1.  Clone the repository.
2.  Run `npm install`.
3.  Run `npx vite build`.
4.  Load the `build` directory as an unpacked extension in Chrome.
