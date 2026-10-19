// Navigation and transient UI state.

import { create } from "zustand";

export type View = "conversations" | "servers" | "skills" | "history" | "settings" | "project";
export type PanelTab = "activity" | "files" | "terminal";
/** Terminal tab: a shell in the project folder, or the agent's own pane. */
export type TerminalMode = "shell" | "agent";

export interface Toast {
  id: number;
  kind: "info" | "error" | "success";
  text: string;
}

interface UiState {
  view: View;
  selected: string | null;
  panelTab: PanelTab;
  terminalMode: TerminalMode;
  showSidebar: boolean;
  showPanel: boolean;
  paletteOpen: boolean;
  newSession: { open: boolean; machineId?: string; workspace?: string };
  pair: { open: boolean; link?: string };
  /** Project shown by the project page. */
  project: { machineId: string; project: string } | null;
  /** Conversation keys of the sidebar rows, in order (Alt+↑/↓ walks them). */
  visibleKeys: string[];
  toasts: Toast[];
  /** Focused diff in the Files tab. */
  focusedFile: string | null;
  setView: (v: View) => void;
  select: (key: string | null) => void;
  setPanelTab: (t: PanelTab, mode?: TerminalMode) => void;
  toggleSidebar: () => void;
  togglePanel: () => void;
  setPalette: (open: boolean) => void;
  openNewSession: (opts?: { machineId?: string; workspace?: string }) => void;
  closeNewSession: () => void;
  openPair: (link?: string) => void;
  closePair: () => void;
  openProject: (machineId: string, project: string) => void;
  setVisibleKeys: (keys: string[]) => void;
  toast: (text: string, kind?: Toast["kind"]) => void;
  dismiss: (id: number) => void;
  focusFile: (path: string | null) => void;
}

let toastId = 0;

export const useUi = create<UiState>((set) => ({
  view: "conversations",
  selected: null,
  panelTab: "activity",
  terminalMode: "shell",
  showSidebar: true,
  showPanel: true,
  paletteOpen: false,
  newSession: { open: false },
  pair: { open: false },
  project: null,
  visibleKeys: [],
  toasts: [],
  focusedFile: null,
  setView: (view) => set({ view }),
  select: (selected) => set({ selected, view: "conversations", focusedFile: null }),
  setPanelTab: (panelTab, mode) => set((s) => ({ panelTab, showPanel: true, terminalMode: mode ?? s.terminalMode })),
  toggleSidebar: () => set((s) => ({ showSidebar: !s.showSidebar })),
  togglePanel: () => set((s) => ({ showPanel: !s.showPanel })),
  setPalette: (paletteOpen) => set({ paletteOpen }),
  openNewSession: (opts) => set({ newSession: { open: true, ...opts } }),
  closeNewSession: () => set({ newSession: { open: false } }),
  openPair: (link) => set({ pair: { open: true, link } }),
  closePair: () => set({ pair: { open: false } }),
  openProject: (machineId, project) => set({ project: { machineId, project }, view: "project" }),
  setVisibleKeys: (visibleKeys) => set({ visibleKeys }),
  toast: (text, kind = "info") => {
    const id = ++toastId;
    set((s) => ({ toasts: [...s.toasts, { id, kind, text }] }));
    setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), kind === "error" ? 6000 : 3500);
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  focusFile: (focusedFile) => set({ focusedFile, panelTab: "files", showPanel: true }),
}));
