import { describe, it, expect, beforeEach } from "vitest";
import { TabGroupingService } from "./utils/grouping";
import { asTabId, asGroupId, OrderUnit } from "./types";

describe("Reproduction of Interleaving Issue", () => {
  let service: TabGroupingService;

  beforeEach(() => {
    service = new TabGroupingService();
  });

  it("should detect interleaving and move tabs to absolute positions", () => {
    // Current state (absolute indices):
    // 0: G1 (Managed Group 1)
    // 1: edge://settings (Unmanaged)
    // 2: G manual (Managed Group Manual)
    // 3: solo1 (Managed Solo)

    // liveUnits (Normal tabs only):
    // G1 (index 0)
    // G manual (index 2)
    // solo1 (index 3)

    // desired (All managed tabs at front):
    // G1 (targetIndex 0)
    // G manual (targetIndex 1 - assuming G1 has 1 tab)
    // solo1 (targetIndex 2)

    const desired: OrderUnit[] = [
      { kind: "group", groupId: asGroupId(101), tabIds: [asTabId(1)!], targetIndex: 0 },
      { kind: "group", groupId: asGroupId(102), tabIds: [asTabId(2)!], targetIndex: 1 },
      { kind: "solo", tabId: asTabId(3)!, targetIndex: 2 }
    ];

    const live: OrderUnit[] = [
      { kind: "group", groupId: asGroupId(101), tabIds: [asTabId(1)!], targetIndex: 0 },
      { kind: "group", groupId: asGroupId(102), tabIds: [asTabId(2)!], targetIndex: 2 },
      { kind: "solo", tabId: asTabId(3)!, targetIndex: 3 }
    ];

    const plan = service.buildOrderPlan(desired, live);

    // Current LIS logic:
    // liveIndexMap: { "g:101": 0, "g:102": 1, "t:3": 2 }
    // indices: [0, 1, 2]
    // LIS: [0, 1, 2]
    // toMove: [] <--- THIS IS THE BUG!
    
    // We expect G manual and solo1 to be in toMove because they are interleaved with an unmanaged tab.
    expect(plan.toMove.some(u => u.kind === "group" && u.groupId === 102)).toBe(true);
    expect(plan.toMove.some(u => u.kind === "solo" && u.tabId === 3)).toBe(true);
  });
});
