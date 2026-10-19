// Skills page state: the local library, the skills of each machine and the
// last sync of each machine. Listeners run while the page is open.

import { listen } from "@tauri-apps/api/event";
import { create } from "zustand";
import { errorMessage, skills } from "../api/client";
import type { Envelope, LibraryView, SkillSyncStatus } from "../api/types";
import type { RemoteSkills } from "../lib/skills";
import { can, useMachines } from "./machines";

interface SkillsState {
  library: LibraryView | null;
  libraryError: string | null;
  remotes: Record<string, RemoteSkills>;
  sync: Record<string, SkillSyncStatus>;
  /** Starts the listeners and loads everything; returns the cleanup. */
  init: () => Promise<() => void>;
  loadLibrary: () => Promise<void>;
  /** Reloads the skills of a machine (online, `skills.read`). */
  loadRemote: (machineId: string) => Promise<void>;
  loadRemotes: () => void;
}

/** Bumped per machine: an older answer is dropped. */
const remoteSeq = new Map<string, number>();

export const useSkills = create<SkillsState>((set, get) => ({
  library: null,
  libraryError: null,
  remotes: {},
  sync: {},

  async init() {
    const unlisten = await Promise.all([
      listen("skills-library", () => void get().loadLibrary()),
      listen<{ machine_id: string; status: SkillSyncStatus }>("skills-sync", (e) => {
        const { machine_id, status } = e.payload;
        set((s) => ({ sync: { ...s.sync, [machine_id]: status } }));
        if (status.state !== "syncing") void get().loadRemote(machine_id);
      }),
      listen<{ machine_id: string; event: Envelope }>("machine-event", (e) => {
        if (e.payload.event.type === "skills.updated") void get().loadRemote(e.payload.machine_id);
      }),
    ]);
    // Machines coming online: fetch their skills.
    const unsubscribe = useMachines.subscribe((s, prev) => {
      if (s.machines === prev.machines) return;
      for (const [id, m] of Object.entries(s.machines)) {
        if (m.status.state === "online" && prev.machines[id]?.status.state !== "online") void get().loadRemote(id);
      }
    });
    void skills
      .syncStatus()
      .then((sync) => set({ sync }))
      .catch(() => {});
    void get().loadLibrary();
    get().loadRemotes();
    return () => {
      unsubscribe();
      unlisten.forEach((u) => u());
    };
  },

  async loadLibrary() {
    try {
      set({ library: await skills.library(), libraryError: null });
    } catch (e) {
      set({ libraryError: errorMessage(e) });
    }
  },

  async loadRemote(machineId) {
    const m = useMachines.getState().machines[machineId];
    if (!m || m.status.state !== "online" || !can(m, "skills.read")) return;
    const seq = (remoteSeq.get(machineId) ?? 0) + 1;
    remoteSeq.set(machineId, seq);
    set((s) => ({ remotes: { ...s.remotes, [machineId]: { ...s.remotes[machineId], loading: true } } }));
    let next: RemoteSkills;
    try {
      next = { skills: await skills.remote(machineId) };
    } catch (e) {
      // Older daemon without skills: the cells say so.
      next = { error: errorMessage(e) };
    }
    if (remoteSeq.get(machineId) !== seq) return;
    set((s) => ({ remotes: { ...s.remotes, [machineId]: next } }));
  },

  loadRemotes() {
    for (const id of Object.keys(useMachines.getState().machines)) void get().loadRemote(id);
  },
}));
