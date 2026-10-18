// Scripts and shells of projects (`/v1/scripts`, `/v1/shells`), kept in sync
// with the `scripts.updated` / `shells.updated` stream events, and the
// terminal opened on the project page.

import { create } from "zustand";
import { api, errorMessage } from "../api/client";
import type { Envelope, ProjectScripts, ProjectShells, ScriptView, ShellView } from "../api/types";

/** `machineId|path`; `path` is the daemon's canonical form. */
export const projectPathKey = (machineId: string, path: string) => `${machineId}|${path}`;

/** Terminal shown under the project page: a script's tab or a shell. */
export interface ProjectTerminal {
  machineId: string;
  /** Canonical project path. */
  path: string;
  pane: string;
  kind: "script" | "shell";
  title: string;
}

interface ProjectsState {
  scripts: Record<string, ProjectScripts>;
  shells: Record<string, ShellView[]>;
  /** Path given by the app (agent cwd) → canonical path, per machine. */
  aliases: Record<string, string>;
  errors: Record<string, string>;
  terminal: ProjectTerminal | null;
  loadScripts: (machineId: string, path: string) => Promise<ProjectScripts | undefined>;
  loadShells: (machineId: string, path: string) => Promise<void>;
  /** Projects of a machine already loaded, again (reconnection: events may be lost). */
  reloadMachine: (machineId: string) => void;
  onEvent: (machineId: string, event: Envelope) => void;
  openTerminal: (t: ProjectTerminal | null) => void;
}

/** Canonical path of `path` once known. */
export function canonicalPath(aliases: Record<string, string>, machineId: string, path: string): string {
  return aliases[projectPathKey(machineId, path)] ?? path;
}

export function scriptsOf(s: ProjectsState, machineId: string, path: string | null | undefined): ProjectScripts | undefined {
  return path ? s.scripts[projectPathKey(machineId, canonicalPath(s.aliases, machineId, path))] : undefined;
}

export function shellsOf(s: ProjectsState, machineId: string, path: string | null | undefined): ShellView[] | undefined {
  return path ? s.shells[projectPathKey(machineId, canonicalPath(s.aliases, machineId, path))] : undefined;
}

/** Status shown for a script: `running`, `exited` or `stopped`. */
export function scriptStatus(script: ScriptView): "running" | "exited" | "stopped" {
  return script.status === "running" || script.status === "exited" ? script.status : "stopped";
}

export const useProjects = create<ProjectsState>((set, get) => {
  const alias = (machineId: string, asked: string, canonical: string) => {
    const key = projectPathKey(machineId, asked);
    if (get().aliases[key] !== canonical) set((s) => ({ aliases: { ...s.aliases, [key]: canonical } }));
  };

  return {
    scripts: {},
    shells: {},
    aliases: {},
    errors: {},
    terminal: null,

    async loadScripts(machineId, path) {
      const asked = projectPathKey(machineId, path);
      try {
        const scripts = await api.scripts(machineId, path);
        alias(machineId, path, scripts.path);
        set((s) => {
          const errors = { ...s.errors };
          delete errors[asked];
          return { scripts: { ...s.scripts, [projectPathKey(machineId, scripts.path)]: scripts }, errors };
        });
        return scripts;
      } catch (e) {
        set((s) => ({ errors: { ...s.errors, [asked]: errorMessage(e) } }));
        return undefined;
      }
    },

    async loadShells(machineId, path) {
      try {
        const shells = await api.shells(machineId, path);
        alias(machineId, path, shells.path);
        set((s) => ({ shells: { ...s.shells, [projectPathKey(machineId, shells.path)]: shells.shells } }));
      } catch {
        // Older daemon or no permission: no shells listed.
      }
    },

    reloadMachine(machineId) {
      const prefix = `${machineId}|`;
      for (const key of Object.keys(get().scripts)) if (key.startsWith(prefix)) void get().loadScripts(machineId, key.slice(prefix.length));
      for (const key of Object.keys(get().shells)) if (key.startsWith(prefix)) void get().loadShells(machineId, key.slice(prefix.length));
    },

    onEvent(machineId, event) {
      if (event.type === "scripts.updated") {
        const data = event.data as ProjectScripts;
        const key = projectPathKey(machineId, data.path);
        // Events carry no suggestions: keep the ones loaded.
        set((s) => ({ scripts: { ...s.scripts, [key]: { ...data, suggestions: s.scripts[key]?.suggestions ?? [] } } }));
        const t = get().terminal;
        // The script's tab closed (or moved): its terminal follows.
        if (t?.kind === "script" && t.machineId === machineId && t.path === data.path) {
          const script = data.scripts.find((sc) => t.title === sc.name);
          if (script?.pane && script.pane !== t.pane) set({ terminal: { ...t, pane: script.pane } });
        }
      } else if (event.type === "shells.updated") {
        const data = event.data as ProjectShells;
        set((s) => ({ shells: { ...s.shells, [projectPathKey(machineId, data.path)]: data.shells } }));
        const t = get().terminal;
        if (t?.kind === "shell" && t.machineId === machineId && t.path === data.path && !data.shells.some((sh) => sh.pane === t.pane)) {
          set({ terminal: null });
        }
      }
    },

    openTerminal(terminal) {
      set({ terminal });
    },
  };
});
