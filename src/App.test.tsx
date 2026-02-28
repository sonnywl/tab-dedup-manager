import {
  render,
  screen,
  fireEvent,
  waitFor,
  cleanup,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as matchers from "@testing-library/jest-dom/matchers";
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
expect.extend(matchers);
import App from "./App";

// Mock chrome API
const mockChrome = {
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
  }),
  setState: vi.fn().mockResolvedValue(undefined),
};

vi.mock("./utils/startSyncStore", () => ({
  default: vi.fn(() => Promise.resolve(mockStore)),
}));

describe("App Component", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStore.getState.mockResolvedValue({ rules: [] });
  });

  afterEach(() => {
    cleanup();
  });

  it("renders the app title", async () => {
    render(<App />);
    expect(
      await screen.findByText("Tab Group Dedup Management Preferences"),
    ).toBeDefined();
  });

  it("shows 'No domains added' when rules list is empty", async () => {
    render(<App />);
    expect(await screen.findByText("No domains added")).toBeDefined();
    const noDomainsCell = screen.getByText("No domains added");
    expect(noDomainsCell).toHaveAttribute("colspan", "6");
  });

  it("adds a new domain rule", async () => {
    const user = userEvent.setup();
    render(<App />);

    const input = screen.getByPlaceholderText("example.com");
    const addButton = screen.getByRole("button", { name: /add/i });

    await user.type(input, "https://www.google.com");
    await user.click(addButton);

    await waitFor(() => {
      expect(mockStore.setState).toHaveBeenCalled();
    });
  });

  it("does not add an invalid domain", async () => {
    const user = userEvent.setup();
    render(<App />);

    const input = screen.getByPlaceholderText("example.com");
    const addButton = screen.getByRole("button", { name: /add/i });

    await user.type(input, "invalid-domain");
    await user.click(addButton);

    expect(mockStore.setState).not.toHaveBeenCalled();
  });

  it("removes a domain rule", async () => {
    const initialRules = [
      {
        id: "1",
        domain: "google.com",
        autoDelete: false,
        skipProcess: false,
        splitByPath: null,
        groupName: "",
      },
    ];
    mockStore.getState.mockResolvedValue({ rules: initialRules });

    const user = userEvent.setup();
    render(<App />);

    const removeButton = await screen.findByRole("button", { name: "" }); // TrashIcon button
    await user.click(removeButton);

    await waitFor(() => {
      expect(mockStore.setState).toHaveBeenCalledWith(
        expect.objectContaining({
          rules: [],
        }),
      );
    });
  });

  it("toggles skipProcess checkbox and clears other fields", async () => {
    const initialRules = [
      {
        id: "1",
        domain: "google.com",
        autoDelete: true,
        skipProcess: false,
        splitByPath: 1,
        groupName: "Test Group",
      },
    ];
    mockStore.getState.mockResolvedValue({ rules: initialRules });

    render(<App />);

    const tbody = document.querySelector("tbody");
    const checkboxes = await within(tbody!).findAllByRole("checkbox");
    const skipCheckbox = checkboxes[0];

    fireEvent.click(skipCheckbox);

    await waitFor(() => {
      expect(mockStore.setState).toHaveBeenCalledWith(
        expect.objectContaining({
          rules: [
            expect.objectContaining({
              id: "1",
              skipProcess: true,
              autoDelete: false,
              splitByPath: null,
              groupName: "",
            }),
          ],
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
        skipProcess: true,
        splitByPath: 1,
        groupName: "Test Group",
      },
    ];
    mockStore.getState.mockResolvedValue({ rules: initialRules });

    render(<App />);

    const tbody = document.querySelector("tbody");
    const checkboxes = await within(tbody!).findAllByRole("checkbox");
    const autoDeleteCheckbox = checkboxes[1];

    fireEvent.click(autoDeleteCheckbox);

    await waitFor(() => {
      expect(mockStore.setState).toHaveBeenCalledWith(
        expect.objectContaining({
          rules: [
            expect.objectContaining({
              id: "1",
              autoDelete: true,
              skipProcess: false,
              splitByPath: null,
              groupName: "",
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
        skipProcess: false,
        splitByPath: null,
        groupName: "",
      },
    ];
    mockStore.getState.mockResolvedValue({ rules: initialRules });

    const user = userEvent.setup();
    render(<App />);

    const splitInput = await screen.findByPlaceholderText("Off");
    await user.type(splitInput, "1");

    await waitFor(() => {
      expect(mockStore.setState).toHaveBeenCalledWith(
        expect.objectContaining({
          rules: [expect.objectContaining({ id: "1", splitByPath: 1 })],
        }),
      );
    });

    // Clear it
    const clearButton = screen.getByTitle("Clear");
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
        skipProcess: false,
        splitByPath: null,
        groupName: "",
      },
    ];
    mockStore.getState.mockResolvedValue({ rules: initialRules });

    const user = userEvent.setup();
    render(<App />);

    const groupInput = await screen.findByPlaceholderText("Group name...");
    await user.type(groupInput, "Search Engine");

    await waitFor(() => {
      expect(mockStore.setState).toHaveBeenCalledWith(
        expect.objectContaining({
          rules: [
            expect.objectContaining({ id: "1", groupName: "Search Engine" }),
          ],
        }),
      );
    });
  });

  it("disables inputs when skip or autoDelete is enabled", async () => {
    const initialRules = [
      {
        id: "1",
        domain: "google.com",
        autoDelete: false,
        skipProcess: true,
        splitByPath: null,
        groupName: "Test Group",
      },
      {
        id: "2",
        domain: "bing.com",
        autoDelete: true,
        skipProcess: false,
        splitByPath: null,
        groupName: "Search",
      },
    ];
    mockStore.getState.mockResolvedValue({ rules: initialRules });

    render(<App />);

    const groupInputs = await screen.findAllByPlaceholderText("Group name...");
    const splitInputs = await screen.findAllByPlaceholderText("Off");
    const rows = document.querySelectorAll("tbody tr");

    // Row 1 (Skip enabled)
    expect(groupInputs[0]).toBeDisabled();
    expect(splitInputs[0]).toBeDisabled();
    const row1Checkboxes = within(rows[0] as HTMLElement).getAllByRole(
      "checkbox",
    );
    expect(row1Checkboxes[1]).toBeDisabled(); // autoDelete checkbox

    // Row 2 (AutoDelete enabled)
    expect(groupInputs[1]).toBeDisabled();
    expect(splitInputs[1]).toBeDisabled();
    const row2Checkboxes = within(rows[1] as HTMLElement).getAllByRole(
      "checkbox",
    );
    expect(row2Checkboxes[0]).not.toBeDisabled(); // skip checkbox (can still toggle)
  });
});
