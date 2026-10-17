// App settings, stored by the Tauri backend (it needs them for notifications
// and the close button).

import { create } from "zustand";
import { app } from "../api/client";
import type { Settings } from "../api/types";

const defaults: Settings = {
  keep_in_tray: true,
  notify_blocked: true,
  notify_done: true,
  notify_error: true,
  notification_sound: true,
  enter_to_send: true,
  show_cost: true,
  grouping: "date",
};

interface SettingsState {
  settings: Settings;
  load: () => Promise<void>;
  update: (patch: Partial<Settings>) => Promise<void>;
}

export const useSettings = create<SettingsState>((set, get) => ({
  settings: defaults,
  async load() {
    set({ settings: { ...defaults, ...(await app.getSettings()) } });
  },
  async update(patch) {
    const settings = { ...get().settings, ...patch };
    set({ settings });
    await app.setSettings(settings);
  },
}));
