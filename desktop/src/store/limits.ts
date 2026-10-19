// Plan limits per machine: loaded when a machine connects, then kept up to
// date by the `limits.updated` stream event.

import { create } from "zustand";
import { api } from "../api/client";
import type { MachineLimits } from "../api/types";

interface LimitsState {
  byMachine: Record<string, MachineLimits>;
  load: (machineId: string) => Promise<void>;
  set: (machineId: string, limits: MachineLimits) => void;
}

export const useLimits = create<LimitsState>((set) => ({
  byMachine: {},
  async load(machineId) {
    try {
      const limits = await api.limits(machineId);
      set((s) => ({ byMachine: { ...s.byMachine, [machineId]: limits } }));
    } catch {
      // Older daemon: no limits.
    }
  },
  set: (machineId, limits) => set((s) => ({ byMachine: { ...s.byMachine, [machineId]: limits } })),
}));
