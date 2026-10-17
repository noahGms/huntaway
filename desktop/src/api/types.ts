// API types generated from Rust (`npm run bindings`), plus the types of the
// Tauri backend (`src-tauri/src`).

export type * from "./generated/AgentView";
export type * from "./generated/Attention";
export type * from "./generated/BlockedReason";
export type * from "./generated/Envelope";
export type * from "./generated/FileChange";
export type * from "./generated/FileMatch";
export type * from "./generated/GitFileStatus";
export type * from "./generated/GitStatus";
export type * from "./generated/HistoryEntry";
export type * from "./generated/HistoryPage";
export type * from "./generated/Interaction";
export type * from "./generated/MachineInfo";
export type * from "./generated/MachineResponse";
export type * from "./generated/Notification";
export type * from "./generated/PendingToolView";
export type * from "./generated/Question";
export type * from "./generated/QuestionOption";
export type * from "./generated/RateLimits";
export type * from "./generated/RateWindow";
export type * from "./generated/ScreenOption";
export type * from "./generated/SessionView";
export type * from "./generated/StateSnapshot";
export type * from "./generated/StoredItem";
export type * from "./generated/TimelineItem";
export type * from "./generated/TimelinePage";
export type * from "./generated/Todo";
export type * from "./generated/ToolKind";
export type * from "./generated/Usage";
export type * from "./generated/WorkspaceView";

import type { StateSnapshot } from "./generated/StateSnapshot";

/** `storage::MachineRecord`. */
export interface MachineRecord {
  machine_id: string;
  name: string;
  addresses: string[];
  public_key: string | null;
  device_id: string | null;
  permissions: string[];
  local: boolean;
  added_at: number;
}

/** `machines::MachineStatus`. */
export interface MachineStatus {
  state: "connecting" | "online" | "offline";
  address: string | null;
  latency_ms: number | null;
  error: string | null;
  last_seen: number | null;
  retry_in_ms: number | null;
}

/** `machines::MachineView`. */
export interface MachineView {
  record: MachineRecord;
  status: MachineStatus;
  snapshot: StateSnapshot | null;
}

/** `storage::Settings`. */
export interface Settings {
  keep_in_tray: boolean;
  notify_blocked: boolean;
  notify_done: boolean;
  notify_error: boolean;
  notification_sound: boolean;
  enter_to_send: boolean;
  show_cost: boolean;
  grouping: "date" | "project";
}

export interface LocalStatus {
  installed: boolean;
  has_token: boolean;
  binary: string | null;
  install_command: string;
}

export interface PairPreview {
  machine_id: string;
  machine_name: string;
  addresses: string[];
  fingerprint: string;
}

/** Error returned by Tauri commands. */
export interface ApiError {
  status: number;
  code: string;
  message: string;
}

export type TerminalMessage =
  | { type: "screen"; ansi: string }
  | { type: "error"; code: string; message: string }
  | { type: "closed" };
