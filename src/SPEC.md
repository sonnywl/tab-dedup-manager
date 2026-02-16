# Background Script Specification (`background.ts`)

This document outlines the architecture, critical behaviors, and design principles of the `background.ts` entry point for the Tab Grouper extension.

## 1. Architectural Overview

The code follows a strict layered architecture to ensure testability, maintainability, and separation of concerns.

### 1.1 Domain Layer (`TabGroupingService`)
- **Responsibility**: Pure business logic and state transitions.
- **Key Characteristics**:
    - **Side-effect free**: Does not call Chrome APIs or external services.
    - **Logic**: Domain extraction, group key mapping, building group states, and calculating repositioning needs.
    - **Planning**: Generates a `GroupPlan` (a declarative set of actions: ungroup, move, group) that the Infrastructure layer executes.

### 1.2 Infrastructure Layer (`ChromeTabAdapter`)
- **Responsibility**: Abstraction of the Chrome Extension API.
- **Key Characteristics**:
    - **Resilience**: Implements a `retry` mechanism with exponential backoff for transient API failures.
    - **Rate Limiting**: Batches operations (e.g., removing 100+ tabs) and introduces delays to stay within browser performance envelopes.
    - **State Capture**: Includes logic to capture current state for best-effort rollbacks during complex plan executions.

### 1.3 Application Layer (`TabGroupingController`)
- **Responsibility**: Orchestration and workflow management.
- **Key Characteristics**:
    - **Process Guarding**: Uses an `isProcessing` semaphore to prevent re-entrant execution and race conditions.
    - **State Integration**: Connects the `SyncStore` (user rules) with the Domain and Infrastructure layers.
    - **Flow**: Handles the high-level sequence: Filter -> Deduplicate -> Auto-delete -> Group -> Reposition.

---

## 2. Critical Behaviors & Design Patterns

### 2.1 State-Driven Repositioning
Instead of "blindly" moving tabs, the system performs a **diffing** operation:
1. The Domain layer calculates the *desired* final state.
2. It compares this against the *actual* state retrieved from Chrome.
3. Only tabs that are out of order or in the wrong group are included in the `GroupPlan`.
This minimizes screen flicker and unnecessary API overhead.

### 2.2 Branded Type Safety
To prevent the common "id mixup" bug (e.g., using a `WindowId` where a `TabId` is expected), the script employs **Branded Types**:
```typescript
type TabId = number & { readonly __brand: "TabId" };
type GroupId = number & { readonly __brand: "GroupId" };
```
This ensures compile-time errors if incompatible IDs are passed to specialized functions.

### 2.3 Batching & Concurrency
Chrome's `tabs.move` and `tabs.remove` can be expensive. The `ChromeTabAdapter` uses a `MAX_BATCH_SIZE` (100) and `RATE_LIMIT_DELAY` (50ms) to ensure the browser remains responsive during massive cleanup operations.

### 2.4 Idempotency
The execution flow is designed to be idempotent. If interrupted or triggered multiple times, the state-comparison logic ensures that only missing steps are performed in subsequent runs.

---

## 3. Data Flow

1.  **Event Trigger**: User clicks the extension icon or a tab is updated.
2.  **Configuration Fetch**: `SyncStore` provides current user rules (Custom Groups, Auto-delete, etc.).
3.  **Tab Filtering**: `ChromeTabAdapter` fetches raw tabs; `TabGroupingService` filters out internal pages, PWAs, and "Skip" domains.
4.  **Transformation**: Logic branches based on `byWindow` configuration.
5.  **Plan Execution**: The `GroupPlan` is applied transactionally (best-effort) by the Adapter.
6.  **Badge Update**: A debounced count of duplicates is calculated and displayed on the extension badge.

---

## 4. Cross-Browser Compatibility

The extension is designed to be compatible with both Chromium-based browsers and Firefox.
- **Manifests**: Separate manifest files are maintained in `public_chrome/` and `public_firefox/` to handle browser-specific requirements (e.g., manifest version differences or specific API permissions).
- **Polyfill**: A lightweight polyfill in `utils/startSyncStore.js` ensures that `browser` is available as an alias for `chrome` in environments where it is not natively present:
  ```javascript
  if (!("browser" in self)) self.browser = self.chrome;
  ```

---

## 5. Error Handling & Resilience

### 5.1 Result Pattern
The codebase favors explicit error handling over exceptions for critical paths using a `Result<T, E>` type:
```typescript
type Result<T, E> = { success: true; value: T } | { success: false; error: E };
```
This forces the caller to handle potential failures, especially in the `Infrastructure` layer where API calls are non-deterministic.

### 5.2 Best-Effort Rollback
During the execution of a `GroupPlan`, the `ChromeTabAdapter` captures a snapshot of the current state. If a sequence of operations fails, it attempts a "best-effort" rollback to restore the previous tab and group configuration, minimizing the risk of leaving the user's browser in a fragmented state.

---

## 6. Frontend Architecture (React UI)

The management interface is built using **React 19** and **Tailwind CSS v4**.

### 6.1 Data-Driven UI
The UI is strictly synchronized with the `SyncStore`. Any change in the rules table triggers an immediate update to the underlying storage, which in turn can be reacted to by the background script.

### 6.2 Component Library
- **Tailwind CSS v4**: Utilizes the latest utility-first CSS framework for styling, integrated via `@tailwindcss/vite`.
- **Heroicons**: Provides a consistent iconography for actions like adding/removing domains.
- **Datalist Integration**: Uses native HTML5 `<datalist>` for group name suggestions, providing an "autocomplete" experience without heavy external libraries.

---

## 7. Storage & Synchronization

### 7.1 SyncStore Abstraction
The `startSyncStore` utility provides a unified interface for interacting with `chrome.storage.local`.
- **Deep Merge**: Ensures that default settings are preserved and merged with existing user data upon initialization.
- **Event-Based Updates**: Implements an `onChange` listener to allow different parts of the extension (background vs. options page) to stay in sync without manual polling.

---

## 8. Development & Tooling

- **Build System**: Powered by **Vite**, configured with multiple entry points for the background script and the options page.
- **Type Safety**: Uses branded types for IDs and strict TypeScript configurations to eliminate common extension-related bugs.
- **Testing**: Employs **Vitest** with `jsdom` for unit and integration testing of both the domain logic and the React components.
