import * as matchers from "@testing-library/jest-dom/matchers";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

import App from "./App";
import userEvent from "@testing-library/user-event";

// Fix type errors for jest-dom matchers in Vitest
import { TestingLibraryMatchers } from "@testing-library/jest-dom/matchers";
declare module "vitest" {
  interface Assertion<T = any> extends TestingLibraryMatchers<any, T> {}
  interface AsymmetricMatchersContaining extends TestingLibraryMatchers<
    any,
    any
  > {}
}

expect.extend(matchers);

// Mock chrome API
const mockChrome = {
  runtime: {
    getManifest: vi.fn().mockReturnValue({ version: "1.0.0" }),
  },
  storage: {
    local: {
      get: vi.fn().mockResolvedValue({}),
      set: vi.fn().mockResolvedValue(undefined),
    },
    onChanged: {
      addListener: vi.fn(),
      removeListener: vi.fn(),
    },
  },
};

vi.stubGlobal("chrome", mockChrome);
vi.stubGlobal("browser", mockChrome);

// Mock startSyncStore
const mockStore = {
  getState: vi.fn().mockResolvedValue({
    rules: [],
    grouping: { byWindow: false },
  }),
  setState: vi.fn().mockResolvedValue(undefined),
};

vi.mock("./utils/startSyncStore", () => ({
  default: vi.fn(() => Promise.resolve(mockStore)),
}));

describe("App Component", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStore.getState.mockResolvedValue({
      rules: [],
      grouping: { byWindow: false },
    });
  });

  afterEach(() => {
    cleanup();
  });

  it("renders the app title", async () => {
    render(<App />);
    expect(
      await screen.findByText("One-click Tab Dedup/Group Manager Options"),
    ).toBeDefined();
  });

  it("shows empty state when rules list is empty", async () => {
    render(<App />);
    expect(
      await screen.findByText("No domain rules configured yet."),
    ).toBeDefined();
    const noDomainsCell = screen.getByText("No domain rules configured yet.");
    expect(noDomainsCell).toHaveAttribute("colspan", "5");
  });

  it("adds a new domain rule", async () => {
    const user = userEvent.setup();
    render(<App />);

    const input = screen.getByPlaceholderText("example.com or www.example.com");
    const addButton = screen.getByRole("button", { name: /add/i });

    await user.type(input, "https://www.google.com");
    await user.click(addButton);

    await waitFor(() => {
      expect(mockStore.setState).toHaveBeenCalledWith(
        expect.objectContaining({
          rules: expect.arrayContaining([
            expect.objectContaining({ domain: "www.google.com" }),
          ]),
        }),
      );
    });
  });

  it("does not add an invalid domain", async () => {
    const user = userEvent.setup();
    render(<App />);

    const input = screen.getByPlaceholderText("example.com or www.example.com");
    const addButton = screen.getByRole("button", { name: /add/i });

    await user.type(input, "invalid-domain");
    await user.click(addButton);

    expect(mockStore.setState).not.toHaveBeenCalled();
  });

  it("does not add a duplicate domain", async () => {
    const initialRules = [
      {
        id: "1",
        domain: "google.com",
        autoDelete: false,
        splitByPath: null,
        groupName: "",
      },
    ];
    mockStore.getState.mockResolvedValue({
      rules: initialRules,
      grouping: { byWindow: false },
    });

    const user = userEvent.setup();
    render(<App />);

    const input = screen.getByPlaceholderText("example.com or www.example.com");
    const addButton = screen.getByRole("button", { name: /add/i });

    await user.type(input, "google.com");
    await user.click(addButton);

    expect(mockStore.setState).not.toHaveBeenCalled();
  });

  it("removes a domain rule", async () => {
    const initialRules = [
      {
        id: "1",
        domain: "google.com",
        autoDelete: false,
        splitByPath: null,
        groupName: "",
      },
    ];
    mockStore.getState.mockResolvedValue({
      rules: initialRules,
      grouping: { byWindow: false },
    });

    const user = userEvent.setup();
    render(<App />);

    const removeButton = await screen.findByRole("button", {
      name: /remove rule for google.com/i,
    });
    await user.click(removeButton);

    await waitFor(() => {
      expect(mockStore.setState).toHaveBeenCalledWith(
        expect.objectContaining({
          rules: [],
        }),
      );
    });
  });

  it("toggles autoDelete checkbox and clears other fields", async () => {
    const initialRules = [
      {
        id: "1",
        domain: "google.com",
        autoDelete: false,
        splitByPath: 1,
        groupName: "Test Group",
      },
    ];
    mockStore.getState.mockResolvedValue({
      rules: initialRules,
      grouping: { byWindow: false },
    });

    render(<App />);

    const autoDeleteCheckbox = await screen.findByLabelText(
      /auto-delete tabs for google.com/i,
    );

    fireEvent.click(autoDeleteCheckbox);

    await waitFor(() => {
      expect(mockStore.setState).toHaveBeenCalledWith(
        expect.objectContaining({
          rules: [
            expect.objectContaining({
              id: "1",
              autoDelete: true,
              splitByPath: null,
            }),
          ],
        }),
      );
    });
  });

  it("updates splitByPath numeric input", async () => {
    const initialRules = [
      {
        id: "1",
        domain: "google.com",
        autoDelete: false,
        splitByPath: null,
        groupName: "",
      },
    ];
    mockStore.getState.mockResolvedValue({
      rules: initialRules,
      grouping: { byWindow: false },
    });

    const user = userEvent.setup();
    render(<App />);

    const splitInput = await screen.findByLabelText(/split by.*path/i);
    await user.type(splitInput, "1");

    await waitFor(() => {
      expect(mockStore.setState).toHaveBeenCalledWith(
        expect.objectContaining({
          rules: [expect.objectContaining({ id: "1", splitByPath: 1 })],
        }),
      );
    });

    // Clear it
    const clearButton = screen.getByTitle(/clear.*path.*index/i);
    await user.click(clearButton);

    await waitFor(() => {
      expect(mockStore.setState).toHaveBeenCalledWith(
        expect.objectContaining({
          rules: [expect.objectContaining({ id: "1", splitByPath: null })],
        }),
      );
    });
  });

  it("updates group name", async () => {
    const initialRules = [
      {
        id: "1",
        domain: "google.com",
        autoDelete: false,
        splitByPath: null,
        groupName: undefined,
      },
    ];
    mockStore.getState.mockResolvedValue({
      rules: initialRules,
      grouping: { byWindow: false },
    });

    const user = userEvent.setup();
    render(<App />);

    const groupInput = await screen.findByLabelText(/group name/i);
    await user.type(groupInput, "Search Engine");

    await waitFor(() => {
      // normalizeRule removes spaces, so it should be "SearchEngine"
      expect(mockStore.setState).toHaveBeenLastCalledWith(
        expect.objectContaining({
          rules: [
            expect.objectContaining({ id: "1", groupName: "SearchEngine" }),
          ],
        }),
      );
    });
  });

  it("toggles window grouping and updates limit", async () => {
    const user = userEvent.setup();
    render(<App />);

    const checkbox = screen.getByLabelText(
      /Keep tabs grouped per window \(or limit number of windows\)/i,
    );
    await user.click(checkbox);

    await waitFor(() => {
      expect(mockStore.setState).toHaveBeenCalledWith(
        expect.objectContaining({
          grouping: expect.objectContaining({ byWindow: true }),
        }),
      );
    });

    // Limit input should now be visible
    const limitInput = screen.getByLabelText(/Number of windows to keep/i);
    await user.clear(limitInput);
    await user.type(limitInput, "3");

    await waitFor(() => {
      expect(mockStore.setState).toHaveBeenLastCalledWith(
        expect.objectContaining({
          grouping: expect.objectContaining({
            byWindow: true,
            numWindowsToKeep: 3,
          }),
        }),
      );
    });

    // Clear limit
    const clearButton = screen.getByLabelText(/Clear window limit/i);
    await user.click(clearButton);

    await waitFor(() => {
      expect(mockStore.setState).toHaveBeenLastCalledWith(
        expect.objectContaining({
          grouping: expect.objectContaining({
            byWindow: true,
            numWindowsToKeep: null,
          }),
        }),
      );
    });
  });

  it("disables inputs when autoDelete is enabled", async () => {
    const initialRules = [
      {
        id: "1",
        domain: "google.com",
        autoDelete: true,
        splitByPath: null,
        groupName: "Search",
      },
    ];
    mockStore.getState.mockResolvedValue({
      rules: initialRules,
      grouping: { byWindow: false },
    });

    render(<App />);

    const groupInputs = await screen.findAllByLabelText(/group name/i);
    const splitInputs = await screen.findAllByLabelText(/split by.*path/i);

    expect(groupInputs[0]).toBeDisabled();
    expect(splitInputs[0]).toBeDisabled();
  });
});
