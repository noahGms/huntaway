// App settings, stored by the Tauri backend (it needs them for notifications
// and the close button).

import { create } from "zustand";
import { app, errorMessage } from "../api/client";
import type { Settings } from "../api/types";
import { useUi } from "./ui";

const defaults: Settings = {
  keep_in_tray: true,
  notify_blocked: true,
  notify_done: true,
  notify_error: true,
  notification_sound: true,
  enter_to_send: true,
  show_cost: true,
  grouping: "date",
  skills_dir: null,
  skills_auto_sync: true,
};

interface SettingsState {
  settings: Settings;
  load: () => Promise<void>;
  update: (patch: Partial<Settings>) => Promise<void>;
}

export const useSettings = create<SettingsState>((set, get) => ({
  settings: defaults,
  async load() {
    try {
      set({ settings: { ...defaults, ...(await app.getSettings()) } });
    } catch (e) {
      // Keep the defaults: the app stays usable.
      useUi.getState().toast(`Could not load settings: ${errorMessage(e)}`, "error");
    }
  },
  async update(patch) {
    const before = get().settings;
    const settings = { ...before, ...patch };
    set({ settings });
    try {
      await app.setSettings(settings);
    } catch (e) {
      // Roll back the keys of this patch unless something changed them since.
      set((s) => {
        const reverted = { ...s.settings };
        for (const k of Object.keys(patch) as (keyof Settings)[]) {
          if (s.settings[k] === settings[k]) (reverted as Record<string, unknown>)[k] = before[k];
        }
        return { settings: reverted };
      });
      useUi.getState().toast(`Could not save settings: ${errorMessage(e)}`, "error");
    }
  },
}));
