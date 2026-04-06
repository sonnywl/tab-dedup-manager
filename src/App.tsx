import { GroupingConfig, Rule, SyncStoreState, validateRule } from "@/types";
import { PlusIcon, TrashIcon, XMarkIcon } from "@heroicons/react/24/outline";
import React, { useCallback, useEffect, useMemo, useState } from "react";

import startSyncStore from "./utils/startSyncStore";

// FIX: normalize groupName "" → undefined before persisting to avoid empty string group keys
function normalizeRule(rule: Rule): Rule {
  return {
    ...rule,
    groupName: rule.groupName || undefined,
  };
}

function useSyncStore() {
  const [state, setStateInternal] = useState<SyncStoreState>({
    rules: [],
    grouping: { byWindow: false, ungroupSingleTab: false },
  });
  const [store, setStore] = useState<any>(null);

  useEffect(() => {
    const init = async () => {
      const s = await startSyncStore({
        rules: [],
        grouping: {
          byWindow: false,
          numWindowsToKeep: 2,
          ungroupSingleTab: false,
        },
      });
      setStore(s);
      const data = await s.getState();
      const validRules = (data.rules || []).filter(validateRule);
      setStateInternal({
        rules: validRules,
        grouping: data.grouping || { byWindow: false, ungroupSingleTab: false },
      });
    };
    init();
  }, []);

  const syncToStore = useCallback(
    async (newState: SyncStoreState) => {
      if (!store) return;
      setStateInternal(newState);
      await store.setState(newState);
    },
    [store],
  );

  const updateRules = useCallback(
    (newRules: Rule[]) => {
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
        placeholder={chrome.i18n.getMessage("groupNamePlaceholder")}
        aria-label={chrome.i18n.getMessage("groupNameAriaLabel")}
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

  const handleSubmit = (e: React.SubmitEvent) => {
    e.preventDefault();
    if (isValidInput(input)) {
      onAdd(input);
      setInput("");
    } else if (input.trim()) {
      alert(chrome.i18n.getMessage("invalidDomainAlert"));
    }
  };

  return (
    <section className="bg-white rounded-lg shadow p-6 mb-6">
      <label className="block text-sm font-medium text-gray-700 mb-2">
        {chrome.i18n.getMessage("addDomainLabel")}
      </label>
      <form className="flex gap-2" onSubmit={handleSubmit}>
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={chrome.i18n.getMessage("domainPlaceholder")}
          className="flex-1 px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
          aria-label={chrome.i18n.getMessage("domainAriaLabel")}
        />
        <button
          className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 flex items-center gap-2 cursor-pointer transition-colors"
          type="submit"
        >
          <PlusIcon className="w-4 h-4" />
          {chrome.i18n.getMessage("addButton")}
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
      {chrome.i18n.getMessage("groupingBehaviorLabel")}
    </label>
    <div className="space-y-4">
      <div className="flex items-center gap-4 border-b border-gray-200 pb-4">
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={!!config.ungroupSingleTab}
            onChange={(e) =>
              onChange({
                ...config,
                ungroupSingleTab: e.target.checked,
              })
            }
            className="w-4 h-4 text-blue-600 rounded focus:ring-blue-500"
          />
          <span className="text-sm text-gray-700">
            {chrome.i18n.getMessage("ungroupSingleTabLabel")}
          </span>
        </label>
      </div>
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
                  ? (config.numWindowsToKeep ?? 2)
                  : null,
              })
            }
            className="w-4 h-4 text-blue-600 rounded focus:ring-blue-500"
          />
          <span className="text-sm text-gray-700">
            {chrome.i18n.getMessage("keepTabsPerWindowLabel")}
          </span>
        </label>
      </div>
      {config.byWindow && (
        <div className="flex items-center gap-2 ml-6">
          <span className="text-sm text-gray-700">
            {chrome.i18n.getMessage("keepTopWindowsLabel")}
          </span>
          <div className="flex items-center gap-1">
            <input
              type="number"
              min="2"
              placeholder="All"
              value={
                typeof config.numWindowsToKeep === "number"
                  ? config.numWindowsToKeep
                  : ""
              }
              onChange={(e) => {
                const val = parseInt(e.target.value);
                // If it was null and they click up, the browser might give "1".
                // If they specifically wanted 2, we can intercept.
                const finalVal =
                  isNaN(val) || (val === 1 && config.numWindowsToKeep === null)
                    ? isNaN(val)
                      ? null
                      : 2
                    : val;
                onChange({
                  ...config,
                  numWindowsToKeep: finalVal,
                });
              }}
              className="w-20 px-2 py-1 text-sm border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
              aria-label={chrome.i18n.getMessage("keepTopWindowsLabel")}
            />
            <button
              disabled={typeof config.numWindowsToKeep !== "number"}
              onClick={() => onChange({ ...config, numWindowsToKeep: null })}
              className="text-gray-400 hover:text-gray-600 p-0.5 disabled:opacity-40"
              title={chrome.i18n.getMessage("clearWindowLimitTooltip")}
              aria-label={chrome.i18n.getMessage("clearWindowLimitTooltip")}
            >
              <XMarkIcon className="w-4 h-4" />
            </button>
          </div>
          <span className="text-xs text-gray-500">
            {chrome.i18n.getMessage("retainAllWindowsLabel")}
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
    rule: Rule;
    onUpdate: (id: string, updates: Partial<Rule>) => void;
    onRemove: (id: string) => void;
    existingGroups: string[];
  }) => {
    // FIX: splitByPath and groupName are disabled by Delete (spec: clears these fields)
    const isSplitDisabled = rule.autoDelete;
    const isGroupNameDisabled = rule.autoDelete;

    return (
      <tr>
        <td className="px-6 py-4 text-sm font-medium text-gray-900">
          {rule.domain}
        </td>
        <td className="px-6 py-4">
          <input
            type="checkbox"
            checked={!!rule.autoDelete}
            onChange={(e) => {
              if (e.target.checked) {
                // FIX: Delete clears splitByPath and groupName per spec
                onUpdate(rule.id!, {
                  autoDelete: true,
                  splitByPath: null,
                  groupName: undefined,
                });
              } else {
                onUpdate(rule.id!, { autoDelete: false });
              }
            }}
            className="w-4 h-4 text-blue-600 rounded focus:ring-blue-500 cursor-pointer"
            aria-label={chrome.i18n.getMessage("autoDeleteAriaLabel", [
              rule.domain,
            ])}
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
              disabled={!!isSplitDisabled}
              onChange={(e) => {
                const val = parseInt(e.target.value, 10);
                onUpdate(rule.id!, {
                  splitByPath: isNaN(val) || val <= 0 ? null : val,
                });
              }}
              className="w-14 px-1 py-1 text-sm border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50"
              aria-label={chrome.i18n.getMessage("splitByPathAriaLabel")}
            />
            <button
              disabled={rule.splitByPath === null}
              onClick={() => onUpdate(rule.id!, { splitByPath: null })}
              className="text-gray-400 hover:text-gray-600 p-0.5 disabled:opacity-40"
              title={chrome.i18n.getMessage("clearPathIndexTooltip")}
              aria-label={chrome.i18n.getMessage("clearPathIndexTooltip")}
            >
              <XMarkIcon className="w-4 h-4" />
            </button>
          </div>
        </td>
        <td className="px-6 py-4">
          <GroupNameInput
            value={rule.groupName || ""}
            disabled={!!isGroupNameDisabled}
            onChange={(val) => onUpdate(rule.id!, { groupName: val })}
            existingGroups={existingGroups}
          />
        </td>
        <td className="px-6 py-4">
          <button
            onClick={() => onRemove(rule.id!)}
            className="text-red-600 hover:text-red-800 transition-colors p-1 rounded hover:bg-red-50"
            aria-label={chrome.i18n.getMessage("removeRuleAriaLabel", [
              rule.domain,
            ])}
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
      const domain = url.hostname;

      if (rules.some((r) => r.domain === domain)) {
        alert(chrome.i18n.getMessage("ruleExistsAlert", [domain]));
        return;
      }

      const newRule: Rule = {
        // FIX: crypto.randomUUID() replaces Date.now() — no collision risk under fast adds
        id: crypto.randomUUID(),
        domain: domain,
        autoDelete: false,
        splitByPath: null,
        groupName: undefined,
      };
      updateRules([...rules, newRule]);
    } catch {
      alert(chrome.i18n.getMessage("invalidUrlAlert"));
    }
  };

  const handleRemoveRule = (id: string) => {
    updateRules(rules.filter((r) => r.id !== id));
  };

  const handleUpdateRule = (id: string, updates: Partial<Rule>) => {
    updateRules(rules.map((r) => (r.id === id ? { ...r, ...updates } : r)));
  };

  return (
    <div className="min-h-screen bg-gray-50 p-8 font-sans text-gray-900">
      <div className="max-w-6xl mx-auto">
        <header className="mb-8">
          <h1 className="text-3xl font-extrabold text-gray-900">
            {chrome.i18n.getMessage("optionsTitle")}
          </h1>
          <p className="text-gray-600 mt-2">
            {chrome.i18n.getMessage("optionsDescription")}
          </p>
        </header>

        <GroupingSettings config={grouping} onChange={updateGrouping} />
        <AddDomainForm onAdd={handleAddDomain} />

        <section className="bg-white rounded-lg shadow overflow-hidden">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50 text-gray-500 uppercase text-xs font-semibold tracking-wider">
              <tr>
                <th className="px-6 py-4 text-left">
                  {chrome.i18n.getMessage("domainColumn")}
                </th>
                <th className="px-6 py-4 text-left">
                  {chrome.i18n.getMessage("autoDeleteColumn")}
                </th>
                <th className="px-6 py-4 text-left">
                  {chrome.i18n.getMessage("splitUrlColumn")}
                </th>
                <th className="px-6 py-4 text-left">
                  {chrome.i18n.getMessage("groupNameColumn")}
                </th>
                <th className="px-6 py-4 text-left">
                  {chrome.i18n.getMessage("actionsColumn")}
                </th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {rules.length === 0 ? (
                <tr>
                  <td
                    colSpan={5}
                    className="px-6 py-12 text-center text-gray-400 italic"
                  >
                    {chrome.i18n.getMessage("noRulesMessage")}
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

        <footer className="mt-8 text-center text-gray-400 text-xs flex flex-col gap-1">
          <div>
            {chrome.i18n.getMessage("copyrightText", [
              new Date().getFullYear().toString(),
            ])}
          </div>
          <div>v{chrome.runtime.getManifest().version}</div>
        </footer>
      </div>
    </div>
  );
}
