import { PlusIcon, TrashIcon } from "@heroicons/react/24/outline";
import { useCallback, useEffect, useState } from "react";

// @ts-ignore
import startSyncStore from "./utils/startSyncStore";

interface DomainRule {
  id: string;
  domain: string;
  autoDelete: boolean;
  skipProcess: boolean;
  splitByPath: number | null;
  groupName: string | undefined;
}

function GroupNameInput({
  value,
  onChange,
  existingGroups,
  disabled,
}: {
  value: string;
  onChange: (val: string) => void;
  existingGroups: string[];
  disabled?: boolean;
}) {
  return (
    <>
      <input
        list="group-names"
        type="text"
        value={value}
        disabled={disabled}
        onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
          onChange(e.target.value)
        }
        className="w-full px-2 py-1 text-sm border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-gray-100 disabled:text-gray-500"
        placeholder="Group name..."
      />
      <datalist id="group-names">
        {existingGroups.map((group) => (
          <option key={group} value={group} />
        ))}
      </datalist>
    </>
  );
}

function isValidDomain(url: string): boolean {
  const trimmed = url.trim();
  if (!trimmed) return false;
  const hasProtocol =
    trimmed.startsWith("http://") || trimmed.startsWith("https://");
  const dotCount = (trimmed.match(/\./g) || []).length;
  return hasProtocol && dotCount >= 2;
}

export default function App() {
  const [rules, setRules] = useState<DomainRule[]>([]);
  const [input, setInput] = useState("");

  const existingGroups = Array.from(
    new Set(rules.map((r) => r.groupName).filter(Boolean)),
  ) as string[];

  const [grouping, setGrouping] = useState<{
    byWindow: boolean;
    numWindowsToKeep?: number | null;
  }>({ byWindow: false });

  const setRulesWithLocal = useCallback(
    async (rules: DomainRule[], newGrouping = grouping) => {
      const { setState } = await startSyncStore({
        rules: [],
        grouping: { byWindow: false },
      });

      setRules(rules);
      setGrouping(newGrouping);
      await setState({ rules, grouping: newGrouping });
    },
    [grouping],
  );

  useEffect(() => {
    const retrieveData = async () => {
      const { getState } = await startSyncStore({
        rules: [],
        grouping: { byWindow: false },
      });

      const config = await getState();
      setRules(config.rules || []);
      setGrouping(config.grouping || { byWindow: false });
    };
    retrieveData();
  }, []);

  const addDomain = (e: React.SubmitEvent) => {
    e.preventDefault();
    const inputValue = input.trim();
    if (!isValidDomain(inputValue)) {
      return;
    }
    const url = new URL(inputValue);

    const newRule: DomainRule = {
      id: Date.now().toString(),
      domain: url.hostname,
      autoDelete: false,
      skipProcess: false,
      splitByPath: null,
      groupName: "",
    };

    setRulesWithLocal([...rules, newRule]);
    setInput("");
  };

  const removeDomain = (id: string) => {
    setRulesWithLocal(rules.filter((r) => r.id !== id));
  };

  const updateRule = (id: string, field: keyof DomainRule, value: any) => {
    setRulesWithLocal(
      rules.map((r) => (r.id === id ? { ...r, [field]: value } : r)),
    );
  };

  return (
    <div className="min-h-screen bg-gray-50 p-8">
      <div className="max-w-9/12 mx-auto">
        <h1 className="text-3xl font-bold text-gray-900 mb-8">
          Tab Group Dedup Management Preferences
        </h1>

        <div className="bg-white rounded-lg shadow p-6 mb-6">
          <label className="block text-sm font-medium text-gray-700 mb-2">
            Add Domain
          </label>
          <form className="flex gap-2" onSubmit={addDomain}>
            <input
              type="text"
              value={input}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                setInput(e.target.value)
              }
              placeholder="example.com"
              className="flex-1 px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <button
              className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 flex items-center gap-2 pointer"
              type="submit"
            >
              <PlusIcon className="w-4 h-4" />
              Add
            </button>
          </form>
        </div>

        <div className="bg-white rounded-lg shadow p-6 mb-6">
          <label className="block text-sm font-medium text-gray-700 mb-4">
            Grouping Settings
          </label>
          <div className="space-y-4">
            <div className="flex items-center gap-4">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={grouping.byWindow}
                  onChange={(e) => {
                    const isByWindow = e.target.checked;
                    setRulesWithLocal(rules, {
                      ...grouping,
                      byWindow: isByWindow,
                      numWindowsToKeep: isByWindow
                        ? grouping.numWindowsToKeep
                        : null,
                    });
                  }}
                  className="w-4 h-4 text-blue-600 rounded focus:ring-blue-500"
                />
                <span className="text-sm text-gray-700">
                  check to keep all open windows or a limited amount of windows
                </span>
              </label>
            </div>
            {grouping.byWindow && (
              <div className="flex items-center gap-2 ml-6">
                <span className="text-sm text-gray-700">
                  Keep top windows by tab count:
                </span>
                <input
                  type="number"
                  min="1"
                  placeholder="All"
                  value={
                    typeof grouping.numWindowsToKeep === "number"
                      ? grouping.numWindowsToKeep
                      : ""
                  }
                  onChange={(e) => {
                    const val = parseInt(e.target.value);
                    setRulesWithLocal(rules, {
                      ...grouping,
                      numWindowsToKeep: isNaN(val) ? null : val,
                    });
                  }}
                  className="w-20 px-2 py-1 text-sm border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
                <span className="text-xs text-gray-500">
                  (Empty = retain all windows)
                </span>
              </div>
            )}
          </div>
        </div>

        <div className="bg-white rounded-lg shadow overflow-hidden mb-6">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                  Domain
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                  Skip
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                  Auto Delete
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                  Split Path
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                  Group
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {rules.length === 0 ? (
                <tr>
                  <td
                    colSpan={6}
                    className="px-6 py-8 text-center text-gray-500"
                  >
                    No domains added
                  </td>
                </tr>
              ) : (
                rules.map((rule) => (
                  <tr key={rule.id}>
                    <td className="px-6 py-4 text-sm font-medium text-gray-900">
                      {rule.domain}
                    </td>
                    <td className="px-6 py-4">
                      <input
                        type="checkbox"
                        checked={rule.skipProcess}
                        onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                          const checked = e.target.checked;
                          if (checked) {
                            setRulesWithLocal(
                              rules.map((r) =>
                                r.id === rule.id
                                  ? {
                                      ...r,
                                      skipProcess: true,
                                      autoDelete: false,
                                      splitByPath: null,
                                    }
                                  : r,
                              ),
                            );
                          } else {
                            updateRule(rule.id, "skipProcess", false);
                          }
                        }}
                        className="w-4 h-4 text-blue-600 rounded focus:ring-blue-500"
                      />
                    </td>
                    <td className="px-6 py-4">
                      <input
                        type="checkbox"
                        checked={rule.autoDelete}
                        disabled={rule.skipProcess}
                        onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                          const checked = e.target.checked;
                          if (checked) {
                            setRulesWithLocal(
                              rules.map((r) =>
                                r.id === rule.id
                                  ? {
                                      ...r,
                                      autoDelete: true,
                                      skipProcess: false,
                                      splitByPath: null,
                                    }
                                  : r,
                              ),
                            );
                          } else {
                            updateRule(rule.id, "autoDelete", false);
                          }
                        }}
                        className="w-4 h-4 text-blue-600 rounded focus:ring-blue-500 disabled:opacity-50"
                      />
                    </td>
                    <td className="px-6 py-4">
                      <div className="flex items-center gap-1">
                        <input
                          type="number"
                          min="0"
                          placeholder="Off"
                          value={
                            typeof rule.splitByPath === "number"
                              ? rule.splitByPath
                              : ""
                          }
                          disabled={rule.skipProcess || rule.autoDelete}
                          onChange={(
                            e: React.ChangeEvent<HTMLInputElement>,
                          ) => {
                            const val = parseInt(e.target.value, 10);
                            updateRule(
                              rule.id,
                              "splitByPath",
                              isNaN(val) || val <= 0 ? null : val,
                            );
                          }}
                          className="w-14 px-1 py-1 text-sm border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50"
                        />
                        {rule.splitByPath !== null && (
                          <button
                            onClick={() =>
                              updateRule(rule.id, "splitByPath", null)
                            }
                            className="text-gray-400 hover:text-gray-600 p-0.5"
                            title="Clear"
                          >
                            <svg
                              xmlns="http://www.w3.org/2000/svg"
                              viewBox="0 0 20 20"
                              fill="currentColor"
                              className="w-4 h-4"
                            >
                              <path d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z" />
                            </svg>
                          </button>
                        )}
                      </div>
                    </td>
                    <td className="px-6 py-4">
                      <GroupNameInput
                        value={rule.groupName || ""}
                        disabled={rule.skipProcess || rule.autoDelete}
                        onChange={(val) =>
                          updateRule(rule.id, "groupName", val)
                        }
                        existingGroups={existingGroups}
                      />
                    </td>
                    <td className="px-6 py-4">
                      <button
                        onClick={() => removeDomain(rule.id)}
                        className="text-red-600 hover:text-red-800"
                      >
                        <TrashIcon className="w-4 h-4" />
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        {/* <Info /> */}
      </div>
    </div>
  );
}

function Info() {
  return (
    <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
      <h2 className="text-sm font-semibold text-blue-900 mb-3">
        Keyboard Shortcuts
      </h2>
      <div className="space-y-2 text-sm text-blue-800">
        <div className="flex items-start gap-2">
          <kbd className="px-2 py-1 bg-white border border-blue-300 rounded text-xs font-mono">
            Alt + Click
          </kbd>
          <span>Merge all into one window and merge duplicates</span>
        </div>
        <div className="flex items-start gap-2">
          <kbd className="px-2 py-1 bg-white border border-blue-300 rounded text-xs font-mono">
            Ctrl + Click
          </kbd>
          <span>Merge and auto delete domains</span>
        </div>
      </div>
    </div>
  );
}
