import { PlusIcon, TrashIcon, XMarkIcon } from "@heroicons/react/24/outline";
import React, { useCallback, useEffect, useMemo, useState } from "react";

// @ts-ignore
import startSyncStore from "./utils/startSyncStore";

interface DomainRule {
  id: string;
  domain: string;
  autoDelete: boolean;
  skipProcess: boolean;
  splitByPath: number | null;
  // FIX: undefined (not "") so validateRule never receives an empty string group key
  groupName: string | undefined;
}

interface GroupingConfig {
  byWindow: boolean;
  numWindowsToKeep?: number | null;
}

interface SyncStoreState {
  rules: DomainRule[];
  grouping: GroupingConfig;
}

// FIX: normalize groupName "" → undefined before persisting to avoid empty string group keys
function normalizeRule(rule: DomainRule): DomainRule {
  return {
    ...rule,
    groupName: rule.groupName?.trim() || undefined,
  };
}

function useSyncStore() {
  const [state, setStateInternal] = useState<SyncStoreState>({
    rules: [],
    grouping: { byWindow: false },
  });

  const syncToStore = useCallback(async (newState: SyncStoreState) => {
    const { setState } = await startSyncStore({
      rules: [],
      grouping: { byWindow: false },
    });
    setStateInternal(newState);
    await setState(newState);
  }, []);

  useEffect(() => {
    const init = async () => {
      const { getState } = await startSyncStore({
        rules: [],
        grouping: { byWindow: false },
      });
      const data = await getState();
      setStateInternal({
        rules: data.rules || [],
        grouping: data.grouping || { byWindow: false },
      });
    };
    init();
  }, []);

  const updateRules = useCallback(
    (newRules: DomainRule[]) => {
      syncToStore({ ...state, rules: newRules.map(normalizeRule) });
    },
    [state, syncToStore],
  );

  const updateGrouping = useCallback(
    (newGrouping: GroupingConfig) => {
      syncToStore({ ...state, grouping: newGrouping });
    },
    [state, syncToStore],
  );

  return {
    rules: state.rules,
    grouping: state.grouping,
    updateRules,
    updateGrouping,
  };
}

const isValidInput = (val: string): boolean => {
  const trimmed = val.trim();
  if (!trimmed || trimmed.includes(" ")) return false;
  return trimmed.includes(".");
};

const normalizeDomainInput = (domainUrl: string): string => {
  let normalized = domainUrl.trim();
  if (!normalized.startsWith("http://") && !normalized.startsWith("https://")) {
    normalized = `https://${normalized}`;
  }
  return normalized;
};

// --- Sub-components ---

const GroupNameInput = React.memo(
  ({
    value,
    onChange,
    existingGroups,
    disabled,
  }: {
    value: string;
    onChange: (val: string) => void;
    existingGroups: string[];
    disabled?: boolean;
  }) => (
    <>
      <input
        list="group-names"
        type="text"
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className="w-full px-2 py-1 text-sm border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-gray-100 disabled:text-gray-500"
        placeholder="Group name..."
        aria-label="Group name"
      />
      <datalist id="group-names">
        {existingGroups.map((group) => (
          <option key={group} value={group} />
        ))}
      </datalist>
    </>
  ),
);

const AddDomainForm = ({ onAdd }: { onAdd: (domain: string) => void }) => {
  const [input, setInput] = useState("");

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (isValidInput(input)) {
      onAdd(input);
      setInput("");
    } else if (input.trim()) {
      alert("Please enter a valid domain (e.g., google.com or www.google.com)");
    }
  };

  return (
    <section className="bg-white rounded-lg shadow p-6 mb-6">
      <label className="block text-sm font-medium text-gray-700 mb-2">
        Add Domain
      </label>
      <form className="flex gap-2" onSubmit={handleSubmit}>
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="example.com or www.example.com"
          className="flex-1 px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
          aria-label="New domain URL"
        />
        <button
          className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 flex items-center gap-2 cursor-pointer transition-colors"
          type="submit"
        >
          <PlusIcon className="w-4 h-4" />
          Add
        </button>
      </form>
    </section>
  );
};

const GroupingSettings = ({
  config,
  onChange,
}: {
  config: GroupingConfig;
  onChange: (config: GroupingConfig) => void;
}) => (
  <section className="bg-white rounded-lg shadow p-6 mb-6">
    <label className="block text-sm font-medium text-gray-700 mb-4">
      Grouping Settings
    </label>
    <div className="space-y-4">
      <div className="flex items-center gap-4">
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={config.byWindow}
            onChange={(e) =>
              onChange({
                ...config,
                byWindow: e.target.checked,
                numWindowsToKeep: e.target.checked
                  ? config.numWindowsToKeep
                  : null,
              })
            }
            className="w-4 h-4 text-blue-600 rounded focus:ring-blue-500"
          />
          <span className="text-sm text-gray-700">
            Keep tabs grouped per window (or limit number of windows)
          </span>
        </label>
      </div>
      {config.byWindow && (
        <div className="flex items-center gap-2 ml-6">
          <span className="text-sm text-gray-700">
            Keep top windows by tab count:
          </span>
          <div className="flex items-center gap-1">
            <input
              type="number"
              min="1"
              placeholder="All"
              value={
                typeof config.numWindowsToKeep === "number"
                  ? config.numWindowsToKeep
                  : ""
              }
              onChange={(e) => {
                const val = parseInt(e.target.value);
                onChange({
                  ...config,
                  numWindowsToKeep: isNaN(val) ? null : val,
                });
              }}
              className="w-20 px-2 py-1 text-sm border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
              aria-label="Number of windows to keep"
            />
            <button
              disabled={typeof config.numWindowsToKeep !== "number"}
              onClick={() => onChange({ ...config, numWindowsToKeep: null })}
              className="text-gray-400 hover:text-gray-600 p-0.5 disabled:opacity-40"
              title="Clear window limit"
              aria-label="Clear window limit"
            >
              <XMarkIcon className="w-4 h-4" />
            </button>
          </div>
          <span className="text-xs text-gray-500">
            (Empty = retain all windows)
          </span>
        </div>
      )}
    </div>
  </section>
);

const RuleRow = React.memo(
  ({
    rule,
    onUpdate,
    onRemove,
    existingGroups,
  }: {
    rule: DomainRule;
    onUpdate: (id: string, updates: Partial<DomainRule>) => void;
    onRemove: (id: string) => void;
    existingGroups: string[];
  }) => {
    // FIX: splitByPath and groupName are disabled by Skip OR Delete (spec: both clear these fields)
    const isSplitDisabled = rule.skipProcess || rule.autoDelete;
    const isGroupNameDisabled = rule.skipProcess || rule.autoDelete;

    return (
      <tr>
        <td className="px-6 py-4 text-sm font-medium text-gray-900">
          {rule.domain}
        </td>
        <td className="px-6 py-4">
          <input
            type="checkbox"
            checked={rule.skipProcess}
            onChange={(e) => {
              if (e.target.checked) {
                // FIX: Skip clears splitByPath and groupName per spec
                onUpdate(rule.id, {
                  skipProcess: true,
                  autoDelete: false,
                  splitByPath: null,
                  groupName: undefined,
                });
              } else {
                onUpdate(rule.id, { skipProcess: false });
              }
            }}
            className="w-4 h-4 text-blue-600 rounded focus:ring-blue-500 cursor-pointer"
            aria-label={`Skip processing for ${rule.domain}`}
          />
        </td>
        <td className="px-6 py-4">
          <input
            type="checkbox"
            checked={rule.autoDelete}
            disabled={rule.skipProcess}
            onChange={(e) => {
              if (e.target.checked) {
                // FIX: Delete clears splitByPath and groupName per spec
                onUpdate(rule.id, {
                  autoDelete: true,
                  skipProcess: false,
                  splitByPath: null,
                  groupName: undefined,
                });
              } else {
                onUpdate(rule.id, { autoDelete: false });
              }
            }}
            className="w-4 h-4 text-blue-600 rounded focus:ring-blue-500 disabled:opacity-50 cursor-pointer"
            aria-label={`Auto-delete tabs for ${rule.domain}`}
          />
        </td>
        <td className="px-6 py-4">
          <div className="flex items-center gap-1">
            <input
              type="number"
              min="1"
              placeholder="Off"
              value={
                typeof rule.splitByPath === "number" ? rule.splitByPath : ""
              }
              disabled={isSplitDisabled}
              onChange={(e) => {
                const val = parseInt(e.target.value, 10);
                onUpdate(rule.id, {
                  splitByPath: isNaN(val) || val <= 0 ? null : val,
                });
              }}
              className="w-14 px-1 py-1 text-sm border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50"
              aria-label="Split by path segment index"
            />
            <button
              disabled={rule.splitByPath === null}
              onClick={() => onUpdate(rule.id, { splitByPath: null })}
              className="text-gray-400 hover:text-gray-600 p-0.5 disabled:opacity-40"
              title="Clear split path"
              aria-label="Clear split path"
            >
              <XMarkIcon className="w-4 h-4" />
            </button>
          </div>
        </td>
        <td className="px-6 py-4">
          <GroupNameInput
            value={rule.groupName || ""}
            disabled={isGroupNameDisabled}
            onChange={(val) => onUpdate(rule.id, { groupName: val })}
            existingGroups={existingGroups}
          />
        </td>
        <td className="px-6 py-4">
          <button
            onClick={() => onRemove(rule.id)}
            className="text-red-600 hover:text-red-800 transition-colors p-1 rounded hover:bg-red-50"
            aria-label={`Remove rule for ${rule.domain}`}
          >
            <TrashIcon className="w-4 h-4" />
          </button>
        </td>
      </tr>
    );
  },
);

// --- Main App Component ---

export default function App() {
  const { rules, grouping, updateRules, updateGrouping } = useSyncStore();

  const existingGroups = useMemo(
    () =>
      Array.from(
        new Set(rules.map((r) => r.groupName).filter((g): g is string => !!g)),
      ),
    [rules],
  );

  const handleAddDomain = (domainUrl: string) => {
    try {
      const normalized = normalizeDomainInput(domainUrl);
      const url = new URL(normalized);
      const newRule: DomainRule = {
        // FIX: crypto.randomUUID() replaces Date.now() — no collision risk under fast adds
        id: crypto.randomUUID(),
        domain: url.hostname,
        autoDelete: false,
        skipProcess: false,
        splitByPath: null,
        groupName: undefined,
      };
      updateRules([...rules, newRule]);
    } catch {
      alert("Invalid URL or domain format. Please try again.");
    }
  };

  const handleRemoveRule = (id: string) => {
    updateRules(rules.filter((r) => r.id !== id));
  };

  const handleUpdateRule = (id: string, updates: Partial<DomainRule>) => {
    updateRules(rules.map((r) => (r.id === id ? { ...r, ...updates } : r)));
  };

  return (
    <div className="min-h-screen bg-gray-50 p-8 font-sans text-gray-900">
      <div className="max-w-6xl mx-auto">
        <header className="mb-8">
          <h1 className="text-3xl font-extrabold text-gray-900">
            One-click Tab Dedup/Grouper Manager Options
          </h1>
          <p className="text-gray-600 mt-2">
            Configure how your tabs are automatically organized and cleaned up.
          </p>
        </header>

        <AddDomainForm onAdd={handleAddDomain} />
        <GroupingSettings config={grouping} onChange={updateGrouping} />

        <section className="bg-white rounded-lg shadow overflow-hidden">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50 text-gray-500 uppercase text-xs font-semibold tracking-wider">
              <tr>
                <th className="px-6 py-4 text-left">Domain</th>
                <th className="px-6 py-4 text-left">Skip</th>
                <th className="px-6 py-4 text-left">Auto Delete</th>
                <th className="px-6 py-4 text-left">Split Path</th>
                <th className="px-6 py-4 text-left">Group Name</th>
                <th className="px-6 py-4 text-left">Actions</th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {rules.length === 0 ? (
                <tr>
                  <td
                    colSpan={6}
                    className="px-6 py-12 text-center text-gray-400 italic"
                  >
                    No domain rules configured yet.
                  </td>
                </tr>
              ) : (
                rules.map((rule) => (
                  <RuleRow
                    key={rule.id}
                    rule={rule}
                    existingGroups={existingGroups}
                    onUpdate={handleUpdateRule}
                    onRemove={handleRemoveRule}
                  />
                ))
              )}
            </tbody>
          </table>
        </section>

        <footer className="mt-8 text-center text-gray-400 text-xs">
          One-click Tab Dedup/Grouper Manager &copy; {new Date().getFullYear()}
        </footer>
      </div>
    </div>
  );
}
