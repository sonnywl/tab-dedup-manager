# `background.ts` - TypeScript Background Service Worker

This TypeScript file (`background.ts`) serves as the background service worker for the Chrome extension. Its primary role is to manage browser tabs by grouping them based on their domain, applying user-defined rules, and maintaining a clear, organized tab experience.

The script is event-driven, responding to browser events and managing tab states through a series of procedural steps and rules.

## Operational Flow and Rules

The `background.ts` script operates based on the following flow and rules:

1.  **Event Listeners & Triggers**:
    *   **Tab Events**: It continuously monitors `chrome.tabs.onCreated`, `chrome.tabs.onRemoved`, and `chrome.tabs.onUpdated` to keep track of tab changes.
    *   **Action Click**: The core functionality is triggered when the user clicks the extension's icon (`chrome.action.onClicked`), which initiates the `collapseDuplicateDomains` process.

2.  **Badge Updates (`updateBadge`)**:
    *   **Rule**: After any tab creation, removal, or update, the script calculates the number of duplicate tabs.
    *   **Procedure**: If duplicates exist, the extension's badge is updated with the count and a distinctive background color, providing immediate visual feedback to the user.

3.  **Tab Grouping and Management (`collapseDuplicateDomains`)**:
    *   **Rule**: When triggered by a user action, this function orchestrates the entire tab organization process.
    *   **Procedure**:
        *   **Fetch Rules**: It retrieves user-defined rules (e.g., `autoDelete`, `skipProcess`) from `chrome.storage.sync`.
        *   **Identify Relevant Tabs**: Filters out tabs based on `skipProcess` rules.
        *   **Window Consolidation (Optional)**: If multiple browser windows are open, it moves tabs from other windows into the current active window to consolidate them, improving grouping efficiency.
        *   **Deduplication (`deduplicateAllTabs`)**: Identifies and closes tabs with identical URLs, ensuring only unique tabs remain.
        *   **Auto-Deletion (`applyAutoDeleteRules`)**: Closes tabs matching `autoDelete` rules configured by the user.
        *   **Domain-Based Grouping (`groupDomainTabs`)**: Groups remaining tabs into logical tab groups based on their domain. It handles existing groups, ensures proper group titles, and sorts tabs within groups for consistency.
            *   **Condition for Grouping**: Grouping only occurs if a domain has two or more tabs.

## Key Data Structures for State Management

While event-driven, the script uses several internal data structures to manage and process tab information dynamically:

*   **`DomainMap`**: Temporarily stores tabs organized by their domain, facilitating domain-specific operations.
*   **`RulesByDomain`**: A derived map of user rules, efficiently associating rules with their respective domains.
*   **`DomainToGroupIdMap`**: Helps track existing tab group IDs for domains to ensure tabs are added to correct groups or new ones are created as needed.