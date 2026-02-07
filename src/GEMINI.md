# Tab Grouping Extension - Technical Specification

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                    Application Layer                         │
│  (TabGroupingController - Orchestration & Concurrency)       │
└──────────────┬──────────────────────────────┬────────────────┘
               │                              │
               ▼                              ▼
┌──────────────────────────┐    ┌──────────────────────────────┐
│     Domain Layer         │    │   Infrastructure Layer       │
│  (TabGroupingService)    │    │   (ChromeTabAdapter)         │
│  - Pure functions        │    │   - Chrome API wrapper       │
│  - Business logic        │    │   - Retry logic              │
│  - State calculation     │    │   - Rate limiting            │
│  - No side effects       │    │   - Transaction rollback     │
└──────────────────────────┘    └──────────────────────────────┘
```

## Design Principles

| Principle              | Implementation                                           |
| ---------------------- | -------------------------------------------------------- |
| Separation of Concerns | 3-layer architecture (Application/Domain/Infrastructure) |
| Type Safety            | Branded types for IDs (TabId, GroupId, Domain)           |
| Reliability            | Retry logic, transaction rollback, validation            |
| Performance            | Batching, rate limiting, parallel processing             |
| Testability            | Pure functions, dependency injection                     |
| Observability          | Structured logging, error tracking                       |

## Core Components

### 1. Domain Layer (`TabGroupingService`)

**Responsibility**: Pure business logic without side effects

**Key Methods**:

```typescript
class TabGroupingService {
  // Extract domain from URL with fallback
  getDomain(url: string | undefined): Domain;

  // Determine group key from rules
  getGroupKey(domain: Domain, rules: RulesByDomain): string;

  // Build map of group → tabs
  buildDomainMap(tabs: Tab[], rules: RulesByDomain): DomainMap;

  // Filter tabs belonging to allowed domains
  filterValidTabs(tabs: Tab[], allowed: Set<Domain>, cache: Map): Tab[];

  // Create group states from domain map
  buildGroupStates(domainMap: DomainMap, cache: Map): GroupState[];

  // Calculate which groups need repositioning
  calculateRepositionNeeds(states: GroupState[], indices: Map): GroupState[];

  // Generate execution plan for grouping
  createGroupPlan(states: GroupState[]): GroupPlan;
}
```

**Invariants**:

- All functions are pure (same input → same output)
- No Chrome API calls
- No mutations of input parameters
- Deterministic behavior

### 2. Infrastructure Layer (`ChromeTabAdapter`)

**Responsibility**: Chrome API interaction with reliability guarantees

**Reliability Features**:

```typescript
class ChromeTabAdapter {
  private readonly MAX_BATCH_SIZE = 100; // Prevent API overload
  private readonly RATE_LIMIT_DELAY = 50; // Throttle requests

  // Retry failed operations up to 3 times
  async getAllNonAppTabs(): Promise<Tab[]>;

  // Batch large operations to avoid Chrome limits
  async deduplicateAllTabs(tabs: Tab[]): Promise<Tab[]>;

  // Transaction with rollback on failure
  async executeGroupPlan(plan: GroupPlan): Promise<Result<void, Error>>;

  // Capture state before changes
  private async captureState(): Promise<Snapshot>;

  // Restore previous state on error
  private async rollback(snapshot: Snapshot): Promise<void>;
}
```

**Error Handling Strategy**:

- Retry transient failures (3 attempts, exponential backoff)
- Capture state before mutations
- Rollback on critical failures
- Log errors without blocking execution
- Return `Result<T, E>` for explicit error handling

### 3. Application Layer (`TabGroupingController`)

**Responsibility**: Orchestrate domain and infrastructure layers

**Concurrency Control**:

```typescript
class TabGroupingController {
  private isProcessing = false; // Mutex lock

  async execute(): Promise<void> {
    if (this.isProcessing) return; // Prevent concurrent execution

    this.isProcessing = true;
    try {
      // Load config
      // Process tabs
      // Apply grouping
    } finally {
      this.isProcessing = false; // Always release lock
    }
  }
}
```

## Type System

### Branded Types

Prevent accidental mixing of primitive values:

```typescript
type Domain = string & { readonly __brand: "Domain" };
type TabId = number & { readonly __brand: "TabId" };
type GroupId = number & { readonly __brand: "GroupId" };
type WindowId = number & { readonly __brand: "WindowId" };

// Compile error - type safety
const tabId: TabId = 123; // ❌ Error
const tabId: TabId = asTabId(123); // ✓ OK
```

### Result Type

Explicit error handling without exceptions:

```typescript
type Result<T, E> = { success: true; value: T } | { success: false; error: E };

// Usage
const result = await retry(() => chrome.tabs.remove(ids));
if (!result.success) {
  console.error("Failed:", result.error);
  return;
}
// Use result.value safely
```

## Data Flow

```
User Click
    ↓
[TabGroupingController.execute()]
    ↓
Load config from SyncStore
    ↓
[ChromeTabAdapter.getRelevantTabs()]
    ↓
Filter: PWA windows, extension pages, skipProcess rules
    ↓
[ChromeTabAdapter.mergeToActiveWindow()] (if byWindow: false)
    ↓
[ChromeTabAdapter.deduplicateAllTabs()]
    ↓
[ChromeTabAdapter.applyAutoDeleteRules()]
    ↓
[TabGroupingService.buildDomainMap()]
    ↓
Group tabs by rule.groupName or domain
    ↓
[TabGroupingController.processGrouping()]
    ↓
┌─────────────────────────────────────┐
│ buildGroupStates()                  │
│   → Filter valid tabs               │
│   → Sort by URL                     │
│   → Track groupId if exists         │
└─────────────────────────────────────┘
    ↓
┌─────────────────────────────────────┐
│ applyGroupState() (parallel)        │
│   → Create/reuse groups             │
│   → Ungroup mismatched tabs         │
│   → Update group titles             │
└─────────────────────────────────────┘
    ↓
[ChromeTabAdapter.ungroupSingleTabs()]
    ↓
[TabGroupingService.calculateRepositionNeeds()]
    ↓
Check if groups are in correct positions
    ↓
[TabGroupingService.createGroupPlan()]
    ↓
[ChromeTabAdapter.executeGroupPlan()]
    ↓
┌─────────────────────────────────────┐
│ Transaction with rollback:          │
│   1. Capture current state          │
│   2. Ungroup all tabs               │
│   3. Move tabs to positions         │
│   4. Recreate groups                │
│   5. On error → rollback            │
└─────────────────────────────────────┘
```

## Performance Optimizations

| Optimization        | Implementation                       | Impact                         |
| ------------------- | ------------------------------------ | ------------------------------ |
| Batching            | Split operations into 100-tab chunks | Prevents Chrome API limits     |
| Rate limiting       | 50ms delay between batches           | Avoids throttling              |
| Parallel processing | `Promise.allSettled` for groups      | 5-10x faster                   |
| Debouncing          | 300ms delay for badge updates        | Reduces unnecessary calls      |
| Caching             | Single tab query, reuse Map          | Eliminates redundant API calls |
| Early exit          | Skip reposition if not needed        | Saves 3 API calls per group    |

## Reliability Guarantees

### Retry Logic

```typescript
async function retry<T>(
  fn: () => Promise<T>,
  maxAttempts: number = 3,
  delayMs: number = 100,
): Promise<Result<T, Error>>;
```

**Behavior**:

- Attempt 1: Immediate
- Attempt 2: 100ms delay
- Attempt 3: 200ms delay
- Returns `Result<T, Error>` for explicit handling

**Applied to**:

- All Chrome API calls
- Tab queries, moves, grouping, ungrouping
- Group creation and updates

### Transaction Rollback

```typescript
async executeGroupPlan(plan: GroupPlan): Promise<Result<void, Error>> {
  const snapshot = await this.captureState();
  try {
    // Execute plan
    return { success: true };
  } catch (error) {
    await this.rollback(snapshot);
    return { success: false, error };
  }
}
```

**Rollback Scope**:

- Best-effort restoration
- Restores group membership
- Logs errors but continues
- Prevents partial state corruption

### Input Validation

```typescript
function validateRule(rule: any): rule is Rule {
  return (
    typeof rule === "object" &&
    rule !== null &&
    typeof rule.domain === "string" &&
    typeof rule.autoDelete === "boolean" &&
    typeof rule.skipProcess === "boolean" &&
    (rule.groupName === null || typeof rule.groupName === "string")
  );
}
```

**Validated Inputs**:

- Rules from SyncStore
- Tabs from Chrome API
- Configuration objects

**Invalid Data Handling**:

- Filter out invalid items
- Log warnings
- Continue with valid subset

## Concurrency Model

### Mutex Lock

```typescript
private isProcessing = false;

async execute(): Promise<void> {
  if (this.isProcessing) {
    console.log('Already processing, skipping...');
    return;
  }

  this.isProcessing = true;
  try {
    // Process
  } finally {
    this.isProcessing = false;  // Always release
  }
}
```

**Prevents**:

- Concurrent executions corrupting state
- Race conditions in tab operations
- Duplicate API calls

### Event Handling

```typescript
const debouncedUpdateBadge = debounce(() => adapter.updateBadge(service), 300);

chrome.action.onClicked.addListener(() => controller.execute());
chrome.tabs.onCreated.addListener(debouncedUpdateBadge);
chrome.tabs.onRemoved.addListener(debouncedUpdateBadge);
chrome.tabs.onUpdated.addListener(debouncedUpdateBadge);
```

**Debouncing**:

- Coalesces rapid events
- Prevents badge update spam
- 300ms window

## Error Handling

### Error Categories

| Category                  | Handling Strategy     | User Impact                |
| ------------------------- | --------------------- | -------------------------- |
| Transient Chrome API      | Retry 3x with backoff | None (auto-recovered)      |
| Invalid configuration     | Filter + log warning  | Continues with valid data  |
| Partial operation failure | Rollback transaction  | State remains consistent   |
| Critical system failure   | Log + release lock    | Operation fails gracefully |

### Logging Strategy

```typescript
// Success
console.log("Already processing, skipping...");

// Warnings (non-critical)
console.warn("Failed to ungroup single tabs:", result.error);
console.warn(`Filtered ${count} invalid rules`);

// Errors (critical)
console.error("Invalid store state:", state);
console.error("Grouping failed:", result.error);
```

## Configuration

### SyncStore Schema

```typescript
interface SyncStore {
  rules: Rule[];
  grouping: {
    byWindow: boolean;
  };
}

interface Rule {
  domain: string; // e.g., "github.com"
  autoDelete: boolean; // Auto-remove tabs from this domain
  skipProcess: boolean; // Exclude from grouping
  groupName: string | null; // Custom group name (null = use domain)
}
```

### Default Values

```typescript
{
  rules: [],
  grouping: { byWindow: false }
}
```

## Limitations

| Limitation                  | Reason                    | Workaround                |
| --------------------------- | ------------------------- | ------------------------- |
| Max 100 tabs per batch      | Chrome API limit          | Automatic batching        |
| 50ms rate limit delay       | Prevent throttling        | Built-in delays           |
| Best-effort rollback        | Complex state restoration | Retry entire operation    |
| No undo/redo                | State not preserved       | Manual re-trigger         |
| Single concurrent execution | Prevent race conditions   | Queue ignored (by design) |

## Testing Strategy

### Unit Tests (Domain Layer)

```typescript
describe("TabGroupingService", () => {
  it("should extract domain from URL", () => {
    const service = new TabGroupingService();
    expect(service.getDomain("https://github.com/user/repo")).toBe(
      "github.com",
    );
  });

  it("should group by custom groupName", () => {
    const rules = {
      "api.github.com": { groupName: "GitHub" },
      "github.com": { groupName: "GitHub" },
    };
    expect(service.getGroupKey("api.github.com", rules)).toBe("GitHub");
  });
});
```

### Integration Tests (Infrastructure Layer)

```typescript
describe("ChromeTabAdapter", () => {
  it("should retry failed operations", async () => {
    const mockChrome = {
      tabs: {
        remove: jest
          .fn()
          .mockRejectedValueOnce(new Error("Transient"))
          .mockResolvedValueOnce(undefined),
      },
    };

    const result = await adapter.deduplicateAllTabs(tabs);
    expect(mockChrome.tabs.remove).toHaveBeenCalledTimes(2);
  });
});
```

## Monitoring

### Key Metrics

- Execution duration
- Retry counts
- Rollback frequency
- Filtered rules count
- Tabs processed
- Groups created

### Health Checks

- Validate SyncStore schema
- Check Chrome API availability
- Verify tab count consistency
- Monitor error rates

## Future Enhancements

1. **Persistent undo stack**: Store previous states for rollback
2. **Dry-run mode**: Preview changes before applying
3. **Incremental updates**: Only process changed tabs
4. **Conflict resolution**: Handle overlapping group rules
5. **Performance telemetry**: Track operation latency
6. **User notifications**: Surface errors to UI
