// Desktop auto-update: checked at launch then every 6 h with the Tauri
// updater, downloaded in the background, installed on restart. The release
// version also tells which huntawayd daemons are out of date (the app and the
// daemon ship together under the same tag).

import { getVersion } from "@tauri-apps/api/app";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { create } from "zustand";
import { daemon, errorMessage, isApiError } from "../api/client";
import { useMachines } from "../store/machines";
import { useUi } from "../store/ui";

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

/** The machine runs `target` or newer: its update is done. */
export function daemonUpdated(version: string | null | undefined, target: string | null | undefined): boolean {
  return !!version && !!target && compareVersions(version, target) >= 0;
}

/** How long a daemon may take to come back after updating itself. */
export const DAEMON_UPDATE_TIMEOUT_MS = 90_000;

/** Self-update of a daemon (`POST /v1/daemon/update`): running, or failed. */
export interface DaemonUpdate {
  state: "updating" | "error";
  /** Version being installed, once the daemon answered. */
  to: string | null;
  error?: string;
}

interface DaemonUpdatesState {
  updates: Record<string, DaemonUpdate>;
  /** Asks the daemon to update itself, then waits for it to reconnect with the new version. */
  run: (machineId: string) => Promise<void>;
  clear: (machineId: string) => void;
}

export const useDaemonUpdates = create<DaemonUpdatesState>((set, get) => {
  const put = (id: string, u: DaemonUpdate) => set((s) => ({ updates: { ...s.updates, [id]: u } }));
  const name = (id: string) => useMachines.getState().machines[id]?.record.name ?? "the machine";
  const versionOf = (id: string) => useMachines.getState().machines[id]?.snapshot?.machine.bridge_version;

  /** Resolves when the machine is back online with `to`, or fails after the timeout. */
  const waitFor = (id: string, to: string) =>
    new Promise<void>((resolve, reject) => {
      const done = () => {
        const m = useMachines.getState().machines[id];
        return m?.status.state === "online" && daemonUpdated(versionOf(id), to);
      };
      const timer = setTimeout(() => {
        unsubscribe();
        reject(new Error(`huntawayd did not come back with ${to} within ${DAEMON_UPDATE_TIMEOUT_MS / 1000} s`));
      }, DAEMON_UPDATE_TIMEOUT_MS);
      const unsubscribe = useMachines.subscribe(() => {
        if (!done()) return;
        clearTimeout(timer);
        unsubscribe();
        resolve();
      });
    });

  return {
    updates: {},
    async run(machineId) {
      if (get().updates[machineId]?.state === "updating") return;
      put(machineId, { state: "updating", to: null });
      const toast = useUi.getState().toast;
      try {
        const r = await daemon.update(machineId);
        put(machineId, { state: "updating", to: r.to });
        await waitFor(machineId, r.to);
        get().clear(machineId);
        toast(`${name(machineId)}: huntawayd updated to ${r.to}`, "success");
      } catch (e) {
        if (isApiError(e) && e.code === "up_to_date") {
          get().clear(machineId);
          toast(`${name(machineId)}: huntawayd is already up to date`);
          return;
        }
        put(machineId, { state: "error", to: get().updates[machineId]?.to ?? null, error: errorMessage(e) });
      }
    },
    clear: (machineId) =>
      set((s) => {
        const updates = { ...s.updates };
        delete updates[machineId];
        return { updates };
      }),
  };
});
