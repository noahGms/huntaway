// Display preferences kept on this computer only (localStorage): space,
// machine groups and order, favorite projects, collapsed tree nodes,
// archived conversations.

import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { MachineGroup, Space } from "../lib/spaces";

interface PrefsState {
  space: Space;
  groups: MachineGroup[];
  /** `projectKey()` of the favorite projects. */
  favorites: string[];
  machineOrder: string[];
  /** Collapsed sidebar tree nodes (`m:<machine>`, `p:<machine>|<project>`). */
  collapsed: string[];
  /** Past conversations (no agent running) show in the sidebar. */
  showPast: boolean;
  /** `archiveId()` of the conversations archived by hand, hidden from the sidebar. */
  archived: string[];
  showArchived: boolean;
  /** Projects without activity for this many days are hidden (0 = never). */
  inactiveDays: number;
  showInactive: boolean;
  setSpace: (space: Space) => void;
  addGroup: (name: string) => string;
  renameGroup: (id: string, name: string) => void;
  removeGroup: (id: string) => void;
  toggleGroupMachine: (groupId: string, machineId: string) => void;
  toggleFavorite: (key: string) => void;
  setMachineOrder: (ids: string[]) => void;
  toggleCollapsed: (id: string) => void;
  expand: (ids: string[]) => void;
  setShowPast: (v: boolean) => void;
  setArchived: (id: string, archived: boolean) => void;
  setShowArchived: (v: boolean) => void;
  setInactiveDays: (days: number) => void;
  setShowInactive: (v: boolean) => void;
}

const toggle = (list: string[], id: string) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);

export const usePrefs = create<PrefsState>()(
  persist(
    (set) => ({
      space: { kind: "all" },
      groups: [],
      favorites: [],
      machineOrder: [],
      collapsed: [],
      showPast: true,
      archived: [],
      showArchived: false,
      inactiveDays: 14,
      showInactive: false,
      setSpace: (space) => set({ space }),
      addGroup: (name) => {
        const id = `g${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
        set((s) => ({ groups: [...s.groups, { id, name, machineIds: [] }] }));
        return id;
      },
      renameGroup: (id, name) => set((s) => ({ groups: s.groups.map((g) => (g.id === id ? { ...g, name } : g)) })),
      removeGroup: (id) =>
        set((s) => ({
          groups: s.groups.filter((g) => g.id !== id),
          space: s.space.kind === "group" && s.space.id === id ? { kind: "all" } : s.space,
        })),
      toggleGroupMachine: (groupId, machineId) =>
        set((s) => ({ groups: s.groups.map((g) => (g.id === groupId ? { ...g, machineIds: toggle(g.machineIds, machineId) } : g)) })),
      toggleFavorite: (key) => set((s) => ({ favorites: toggle(s.favorites, key) })),
      setMachineOrder: (machineOrder) => set({ machineOrder }),
      toggleCollapsed: (id) => set((s) => ({ collapsed: toggle(s.collapsed, id) })),
      expand: (ids) => set((s) => (ids.some((id) => s.collapsed.includes(id)) ? { collapsed: s.collapsed.filter((x) => !ids.includes(x)) } : s)),
      setShowPast: (showPast) => set({ showPast }),
      setArchived: (id, archived) =>
        set((s) => (s.archived.includes(id) === archived ? s : { archived: archived ? [...s.archived, id] : s.archived.filter((x) => x !== id) })),
      setShowArchived: (showArchived) => set({ showArchived }),
      setInactiveDays: (inactiveDays) => set({ inactiveDays }),
      setShowInactive: (showInactive) => set({ showInactive }),
    }),
    {
      name: "huntaway:prefs",
      version: 2,
      // v1's `showArchived` meant past conversations.
      migrate: (state, version) => {
        const s = state as Partial<PrefsState>;
        return (version < 2 ? { ...s, showPast: s.showArchived ?? true, showArchived: false, archived: [] } : s) as PrefsState;
      },
      partialize: (s) => ({
        space: s.space,
        groups: s.groups,
        favorites: s.favorites,
        machineOrder: s.machineOrder,
        collapsed: s.collapsed,
        showPast: s.showPast,
        archived: s.archived,
        showArchived: s.showArchived,
        inactiveDays: s.inactiveDays,
        showInactive: s.showInactive,
      }),
    },
  ),
);
