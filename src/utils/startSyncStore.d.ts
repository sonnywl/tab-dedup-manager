import { SyncStoreState } from "@/types";

export interface SyncStore {
  getState: () => Promise<SyncStoreState>;
  setState: (data: Partial<SyncStoreState>) => Promise<SyncStoreState>;
  onChange: (fn: (state: SyncStoreState, prevState: mixed) => void) => void;
}

export default function startSyncStore(
  defaultState?: Partial<SyncStoreState>,
): Promise<SyncStore>;
