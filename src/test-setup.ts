import { vi } from "vitest";
import "@testing-library/jest-dom";

const mockObj = {
  storage: {
    local: { get: vi.fn(), set: vi.fn() },
    onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
  },
  action: {
    setBadgeText: vi.fn(),
    setBadgeBackgroundColor: vi.fn(),
    onClicked: { addListener: vi.fn() },
  },
  tabs: {
    query: vi.fn(),
    group: vi.fn(),
    ungroup: vi.fn(),
    move: vi.fn(),
    remove: vi.fn(),
    onCreated: { addListener: vi.fn() },
    onUpdated: { addListener: vi.fn() },
    onRemoved: { addListener: vi.fn() },
  },
  tabGroups: {
    query: vi.fn(),
    update: vi.fn(),
    move: vi.fn(),
  },
  windows: {
    getCurrent: vi.fn(),
    getAll: vi.fn(),
  },
  runtime: {
    lastError: null,
  }
};

vi.stubGlobal("chrome", mockObj);
vi.stubGlobal("browser", mockObj);

if (typeof global !== "undefined") {
  (global as any).self = global;
  (global as any).self.chrome = mockObj;
  (global as any).self.browser = mockObj;
}
