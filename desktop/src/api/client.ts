// Calls to the Tauri backend. API requests go through `api_get` / `api_post`:
// the backend picks the machine address and adds the token.

import { Channel, invoke } from "@tauri-apps/api/core";
import type {
  ApiError,
  DaemonUpdateCheck,
  FileMatch,
  GitStatus,
  HistoryEntry,
  HistoryPage,
  LibrarySkill,
  LibraryView,
  LocalStatus,
  MachineRecord,
  MachineResponse,
  MachineView,
  PairPreview,
  ProjectScripts,
  ProjectShells,
  ScriptView,
  Settings,
  ShellView,
  SkillFile,
  SkillSyncReport,
  SkillSyncStatus,
  SkillView,
  TerminalMessage,
  TerminalTarget,
  TimelinePage,
} from "./types";

const seg = encodeURIComponent;

function query(params: Record<string, string | number | undefined | null>): string {
  const parts = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${k}=${seg(String(v))}`);
  return parts.length ? `?${parts.join("&")}` : "";
}

export function isApiError(e: unknown): e is ApiError {
  return typeof e === "object" && e !== null && "code" in e && "message" in e;
}

export function errorMessage(e: unknown): string {
  if (isApiError(e)) return e.message;
  if (e instanceof Error) return e.message;
  return String(e);
}

export const api = {
  get<T>(machineId: string, path: string): Promise<T> {
    return invoke<T>("api_get", { machineId, path });
  },
  post<T>(machineId: string, path: string, body?: unknown): Promise<T> {
    return invoke<T>("api_post", { machineId, path, body: body ?? {} });
  },

  machine: (m: string) => api.get<MachineResponse>(m, "/v1/machine"),
  timeline: (m: string, id: string, before?: number, limit = 120) =>
    api.get<TimelinePage>(m, `/v1/agents/${seg(id)}/timeline${query({ before, limit })}`),

  /** Queued by the daemon while the agent works, unless `now`. */
  sendMessage: (m: string, id: string, text: string, now = false) =>
    api.post<{ ok: boolean; queued?: boolean }>(m, `/v1/agents/${seg(id)}/messages`, { text, now: now || undefined }),
  /** Removes a waiting message; returns its text. */
  removeQueued: (m: string, id: string, queued: string) => api.post<{ ok: boolean; text: string }>(m, `/v1/agents/${seg(id)}/queue/${seg(queued)}/remove`),
  sendQueuedNow: (m: string, id: string, queued: string) => api.post(m, `/v1/agents/${seg(id)}/queue/${seg(queued)}/send`),
  interrupt: (m: string, id: string) => api.post(m, `/v1/agents/${seg(id)}/interrupt`),
  /** Answers the prompt `interactionId`; the daemon refuses with 409 `interaction_changed` if the agent moved on. */
  choose: (m: string, id: string, interactionId: string, number: number, text?: string) =>
    api.post(m, `/v1/agents/${seg(id)}/choice`, { number, text: text || undefined, interaction_id: interactionId }),
  deny: (m: string, id: string, interactionId: string, text?: string) =>
    api.post<{ ok: boolean; message_sent?: boolean }>(m, `/v1/agents/${seg(id)}/deny`, { text: text || undefined, interaction_id: interactionId }),
  createAgent: (
    m: string,
    body: { session: string; workspace_id: string; kind: string; prompt: string; model?: string; cwd?: string },
  ) => api.post<{ agent_id: string; prompt_sent: boolean }>(m, "/v1/agents", body),
  createWorkspace: (m: string, body: { session: string; cwd: string; label?: string }) =>
    api.post<{ workspace_id: string }>(m, "/v1/workspaces", body),

  history: (m: string, p: { before?: number; limit?: number; project?: string; kind?: string; q?: string } = {}) =>
    api.get<HistoryPage>(m, `/v1/history${query(p)}`),
  historyEntry: (m: string, id: string) => api.get<HistoryEntry>(m, `/v1/history/${seg(id)}`),
  historyTimeline: (m: string, id: string, before?: number, limit = 120) =>
    api.get<TimelinePage>(m, `/v1/history/${seg(id)}/timeline${query({ before, limit })}`),
  resume: (m: string, id: string, body: { session?: string; workspace_id?: string; prompt?: string } = {}) =>
    api.post<{ agent_id: string; prompt_sent: boolean; already_running?: boolean }>(m, `/v1/history/${seg(id)}/resume`, body),

  files: (m: string, id: string, q: string) =>
    api.get<{ files: FileMatch[] }>(m, `/v1/agents/${seg(id)}/files${query({ q, limit: 40 })}`),
  gitStatus: (m: string, id: string) => api.get<GitStatus>(m, `/v1/agents/${seg(id)}/git/status`),
  gitDiff: (m: string, id: string, path?: string) =>
    api.get<{ diff: string }>(m, `/v1/agents/${seg(id)}/git/diff${query({ path })}`),

  /** Scripts of the project at `path` (absolute; the answer has its canonical form). */
  scripts: (m: string, path: string) => api.get<ProjectScripts>(m, `/v1/scripts${query({ path })}`),
  startScript: (m: string, path: string, name: string) => api.post<{ script: ScriptView }>(m, "/v1/scripts/start", { path, name }),
  stopScript: (m: string, path: string, name: string) => api.post(m, "/v1/scripts/stop", { path, name }),
  restartScript: (m: string, path: string, name: string) => api.post<{ script: ScriptView }>(m, "/v1/scripts/restart", { path, name }),
  /** Adds or replaces a script stored by the daemon (`rename_from`: its previous name). */
  saveScript: (m: string, body: { path: string; name: string; cmd: string; cwd?: string; rename_from?: string }) =>
    api.post<ProjectScripts>(m, "/v1/scripts", body),
  deleteScript: (m: string, path: string, name: string) => api.post(m, "/v1/scripts/delete", { path, name }),
  shells: (m: string, path: string) => api.get<ProjectShells>(m, `/v1/shells${query({ path })}`),
  openShell: (m: string, path: string) => api.post<{ shell: ShellView }>(m, "/v1/shells", { path }),
  closeShell: (m: string, pane: string) => api.post(m, "/v1/shells/close", { pane }),
};

const terminalArgs = (t: TerminalTarget) => ("pane" in t ? { agentId: "", pane: t.pane } : { agentId: t.agentId, pane: null });

export const app = {
  listMachines: () => invoke<MachineView[]>("list_machines"),
  inspectPairing: (link: string) => invoke<PairPreview>("inspect_pairing", { link }),
  pairMachine: (link: string) => invoke<MachineRecord>("pair_machine", { link }),
  forgetMachine: (machineId: string) => invoke<void>("forget_machine", { machineId }),
  renameMachine: (machineId: string, name: string) => invoke<void>("rename_machine", { machineId, name }),
  reconnectMachine: (machineId: string) => invoke<void>("reconnect_machine", { machineId }),
  localStatus: () => invoke<LocalStatus>("local_status"),
  startLocalDaemon: () => invoke<boolean>("start_local_daemon"),
  refreshLocal: () => invoke<boolean>("refresh_local"),
  setFocus: (machineId: string | null, agentId: string | null) => invoke<void>("set_focus", { machineId, agentId }),
  getSettings: () => invoke<Settings>("get_settings"),
  setSettings: (settings: Settings) => invoke<void>("set_settings", { settings }),
  uploadFile: (machineId: string, path: string) => invoke<string>("upload_file", { machineId, path }),
  uploadData: (machineId: string, name: string, dataBase64: string) =>
    invoke<string>("upload_data", { machineId, name, dataBase64 }),
  openTerminal: (machineId: string, target: TerminalTarget, onMessage: (m: TerminalMessage) => void) => {
    const channel = new Channel<TerminalMessage>();
    channel.onmessage = onMessage;
    return invoke<void>("open_terminal", { machineId, ...terminalArgs(target), onEvent: channel });
  },
  testNotification: () => invoke<void>("test_notification"),
  /** System terminal in a folder of this computer. */
  openInTerminal: (path: string) => invoke<void>("open_in_terminal", { path }),
  closeTerminal: (machineId: string, target: TerminalTarget) => invoke<void>("close_terminal", { machineId, ...terminalArgs(target) }),
  terminalInput: (machineId: string, target: TerminalTarget, input: { text?: string; keys?: string[] }) =>
    invoke<void>("terminal_input", { machineId, ...terminalArgs(target), text: input.text ?? null, keys: input.keys ?? null }),
  /** Streams `agent.item` events of these agents only (`null` = all). */
  setStreamItems: (machineId: string, agentIds: string[] | null) => invoke<void>("set_stream_items", { machineId, agentIds }),
};

// Skills library (local folder, read by the backend) and its sync with the
// daemons, plus daemon self-update.
export const skills = {
  library: () => invoke<LibraryView>("skills_library"),
  create: (name: string, description: string) => invoke<LibrarySkill>("skills_create", { name, description }),
  deleteLocal: (name: string) => invoke<void>("skills_delete_local", { name }),
  files: (name: string) => invoke<SkillFile[]>("skills_files", { name }),
  /** Opens the library folder (created if missing), or a skill's folder. */
  openFolder: (name?: string) => invoke<void>("skills_open_folder", { name: name ?? null }),
  remote: (machineId: string) => invoke<SkillView[]>("skills_remote", { machineId }),
  push: (machineId: string, name: string) => invoke<SkillView>("skills_push", { machineId, name }),
  /** Pushes the skills that differ; `removeExtra` also deletes the machine's skills missing from the library. */
  sync: (machineId: string, removeExtra = false) => invoke<SkillSyncReport>("skills_sync", { machineId, removeExtra }),
  deleteRemote: (machineId: string, name: string) => invoke<void>("skills_delete_remote", { machineId, name }),
  syncStatus: () => invoke<Record<string, SkillSyncStatus>>("skills_sync_status"),
};

export const daemon = {
  checkUpdate: (machineId: string) => api.get<DaemonUpdateCheck>(machineId, "/v1/daemon/update"),
  /** Installs the latest huntawayd; the daemon restarts right after answering (409 `up_to_date` when current). */
  update: (machineId: string) => api.post<{ ok: boolean; from: string; to: string }>(machineId, "/v1/daemon/update"),
};
