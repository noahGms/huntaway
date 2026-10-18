// Calls to the Tauri backend. API requests go through `api_get` / `api_post`:
// the backend picks the machine address and adds the token.

import { Channel, invoke } from "@tauri-apps/api/core";
import type {
  ApiError,
  FileMatch,
  GitStatus,
  HistoryEntry,
  HistoryPage,
  LocalStatus,
  MachineRecord,
  MachineResponse,
  MachineView,
  PairPreview,
  Settings,
  TerminalMessage,
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

  sendMessage: (m: string, id: string, text: string) => api.post(m, `/v1/agents/${seg(id)}/messages`, { text }),
  interrupt: (m: string, id: string) => api.post(m, `/v1/agents/${seg(id)}/interrupt`),
  /** Answers the prompt `interactionId`; the daemon refuses with 409 `interaction_changed` if the agent moved on. */
  choose: (m: string, id: string, interactionId: string, number: number, text?: string) =>
    api.post(m, `/v1/agents/${seg(id)}/choice`, { number, text: text || undefined, interaction_id: interactionId }),
  deny: (m: string, id: string, interactionId: string, text?: string) =>
    api.post(m, `/v1/agents/${seg(id)}/deny`, { text: text || undefined, interaction_id: interactionId }),
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
};

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
  openTerminal: (machineId: string, agentId: string, onMessage: (m: TerminalMessage) => void) => {
    const channel = new Channel<TerminalMessage>();
    channel.onmessage = onMessage;
    return invoke<void>("open_terminal", { machineId, agentId, onEvent: channel });
  },
  testNotification: () => invoke<void>("test_notification"),
  closeTerminal: (machineId: string, agentId: string) => invoke<void>("close_terminal", { machineId, agentId }),
  terminalInput: (machineId: string, agentId: string, input: { text?: string; keys?: string[] }) =>
    invoke<void>("terminal_input", { machineId, agentId, text: input.text ?? null, keys: input.keys ?? null }),
};
