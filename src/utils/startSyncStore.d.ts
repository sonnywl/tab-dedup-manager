import { SyncStoreState } from "../types.js";

export interface SyncStore {
  getState: () => Promise<SyncStoreState>;
  setState: (data: Partial<SyncStoreState>) => Promise<SyncStoreState>;
  onChange: (fn: (state: SyncStoreState, prevState: any) => void) => void;
}

export default function startSyncStore(
  defaultState?: Partial<SyncStoreState>,
): Promise<SyncStore>;
