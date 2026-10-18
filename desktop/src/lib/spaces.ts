// Spaces: which machines the sidebar shows (all, one machine, or a
// user-defined group of machines), and the manual machine order.

import type { MachineView } from "../api/types";

export type Space = { kind: "all" } | { kind: "machine"; id: string } | { kind: "group"; id: string };

export interface MachineGroup {
  id: string;
  name: string;
  machineIds: string[];
}

/** Machine ids of a space; `null` when the space no longer exists. */
export function spaceMachineIds(space: Space, machineIds: string[], groups: MachineGroup[]): string[] | null {
  if (space.kind === "all") return machineIds;
  if (space.kind === "machine") return machineIds.includes(space.id) ? [space.id] : null;
  const group = groups.find((g) => g.id === space.id);
  return group ? machineIds.filter((id) => group.machineIds.includes(id)) : null;
}

export function spaceLabel(space: Space, machines: MachineView[], groups: MachineGroup[]): string {
  if (space.kind === "machine") return machines.find((m) => m.record.machine_id === space.id)?.record.name ?? "All machines";
  if (space.kind === "group") return groups.find((g) => g.id === space.id)?.name ?? "All machines";
  return "All machines";
}

/** Manual order first, then this computer, then by name. */
export function orderMachines<T extends Pick<MachineView, "record">>(list: T[], order: string[]): T[] {
  const index = (m: T) => {
    const i = order.indexOf(m.record.machine_id);
    return i === -1 ? Infinity : i;
  };
  return [...list].sort(
    (a, b) => index(a) - index(b) || Number(b.record.local) - Number(a.record.local) || a.record.name.localeCompare(b.record.name),
  );
}

/** Moves a machine one step up or down in the manual order. */
export function moveMachine(ordered: string[], id: string, delta: -1 | 1): string[] {
  const out = [...ordered];
  const i = out.indexOf(id);
  const j = i + delta;
  if (i === -1 || j < 0 || j >= out.length) return out;
  [out[i], out[j]] = [out[j], out[i]];
  return out;
}
