// Desktop auto-update: checked at launch then every 6 h with the Tauri
// updater, downloaded in the background, installed on restart. The release
// version also tells which huntawayd daemons are out of date (the app and the
// daemon ship together under the same tag).

import { getVersion } from "@tauri-apps/api/app";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { create } from "zustand";

const EVERY = 6 * 3600_000;

export const DAEMON_UPDATE_COMMAND = "curl -fsSL https://github.com/noahGms/huntaway/releases/latest/download/install.sh | sh";

interface UpdateState {
  /** Version of the latest release, once known. */
  latest: string | null;
  /** Downloaded update waiting for a restart. */
  ready: Update | null;
  checking: boolean;
  dismissed: boolean;
  /** Checks now; resolves to the new version, or null when up to date. */
  checkNow: () => Promise<string | null>;
  restart: () => Promise<void>;
  dismiss: () => void;
}

let downloading: string | null = null;

export const useUpdates = create<UpdateState>((set, get) => ({
  latest: null,
  ready: null,
  checking: false,
  dismissed: false,
  async checkNow() {
    set({ checking: true });
    try {
      const update = await check();
      if (!update) {
        set({ latest: await getVersion().catch(() => get().latest) });
        return null;
      }
      set({ latest: update.version });
      if (get().ready?.version !== update.version && downloading !== update.version) {
        downloading = update.version;
        try {
          await update.download();
          set({ ready: update, dismissed: false });
        } finally {
          downloading = null;
        }
      }
      return update.version;
    } finally {
      set({ checking: false });
    }
  },
  async restart() {
    const update = get().ready;
    if (!update) return;
    await update.install();
    await relaunch();
  },
  dismiss: () => set({ dismissed: true }),
}));

let started = false;

/** Starts the background checks (once per launch); failures stay silent. */
export function startUpdateChecks() {
  if (started) return;
  started = true;
  const run = () => void useUpdates.getState().checkNow().catch(() => {});
  run();
  setInterval(run, EVERY);
}

/** -1, 0 or 1; ignores a `v` prefix and pre-release suffixes. */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) => v.replace(/^v/, "").split(/[-+]/)[0].split(".").map((n) => Number.parseInt(n, 10) || 0);
  const pa = parts(a);
  const pb = parts(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** A daemon older than the latest release. */
export function daemonOutdated(version: string | null | undefined, latest: string | null): boolean {
  return !!version && !!latest && compareVersions(version, latest) < 0;
}
