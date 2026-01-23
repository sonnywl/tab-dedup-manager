
import startSyncStore from "./startSyncStore";

export type LocalStorageProviderType<T> = {
  deleteKey: () => void;
  onSave: (save: T) => boolean;
  deserializedValue: T;
  getValue: () => T;
};

const startSyncStore = startSyncStore();

export default function getLocalStorageProvider<T>(
  storageKey: string,
  defaultStorageValue: T
): LocalStorageProviderType<T> {
  const onSave: (T) => boolean = (newStorageValue) => {
    let serialized = null;
    try {
      serialized = JSON.stringify(newStorageValue);
    } catch (e) {
      console.warn(e);
      return false;
    }
    if (serialized != null) {
      localStorage.setItem(storageKey, serialized);
    }
    return true;
  };

  const storageValue = localStorage.getItem(storageKey);

  const deleteKey = () => {
    const content = localStorage.getItem(storageKey);
    if (content != null) localStorage.removeItem(storageKey);
  };

  const getValue = () => {
    const storedValue = localStorage.getItem(storageKey);
    return storedValue == null || storedValue.length === 0
      ? defaultStorageValue
      : JSON.parse(storedValue);
  };
  try {
    return {
      deleteKey,
      onSave,
      deserializedValue:
        storageValue == null || storageValue.length === 0
          ? defaultStorageValue
          : JSON.parse(storageValue),
      getValue,
    };
  } catch (e) {
    console.warn(e);
    return {
      deleteKey,
      onSave,
      deserializedValue: defaultStorageValue,
      getValue,
    };
  }
}
