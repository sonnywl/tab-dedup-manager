import { PlusIcon, TrashIcon } from "@heroicons/react/24/outline";
import { useCallback, useEffect, useState } from "react";

// @ts-ignore
import startSyncStore from "./utils/startSyncStore";

interface DomainRule {
  id: string;
  domain: string;
  autoDelete: boolean;
  skipProcess: boolean;
  splitByPath: boolean | undefined;
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

  const setRulesWithLocal = useCallback(async (rules: DomainRule[]) => {
    const { setState, getState } = await startSyncStore({
      rules: [],
    });

    const appConfig = await getState();
    setRules(rules);
    await setState({ ...appConfig, rules });
  }, []);

  useEffect(() => {
    const retrieveData = async () => {
      const { getState } = await startSyncStore({
        rules: [],
      });

      const config = await getState();
      setRules(config.rules);
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
      splitByPath: false,
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
                    colSpan={5}
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
                          updateRule(rule.id, "skipProcess", e.target.checked);
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
                          updateRule(rule.id, "autoDelete", e.target.checked);
                        }}
                        className="w-4 h-4 text-blue-600 rounded focus:ring-blue-500 disabled:opacity-50"
                      />
                    </td>
                    <td className="px-6 py-4">
                      <GroupNameInput
                        value={rule.groupName || ""}
                        disabled={rule.skipProcess}
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
