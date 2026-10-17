// Activity panel data, computed from a conversation timeline.

import type { StoredItem, Todo, ToolKind } from "../api/types";
import { changeDiff } from "./diff";
import { parseTime } from "./format";

export interface CommandRun {
  toolUseId: string;
  command: string;
  timestamp: string;
  /** `null` while running. */
  ok: boolean | null;
  output: string | null;
}

export interface ChangedFile {
  path: string;
  additions: number;
  deletions: number;
  /** Number of edits. */
  edits: number;
  lastAt: string;
  /** `n` of the edits, oldest first. */
  items: number[];
}

export interface Activity {
  todos: Todo[];
  toolCounts: Partial<Record<ToolKind, number>>;
  commands: CommandRun[];
  files: ChangedFile[];
  messages: number;
  startedAt: string | null;
  lastAt: string | null;
  durationMs: number | null;
  results: Map<string, { is_error: boolean; rejected: boolean; summary: string }>;
}

export function computeActivity(items: StoredItem[]): Activity {
  const results = new Map<string, { is_error: boolean; rejected: boolean; summary: string }>();
  for (const it of items) {
    if (it.type === "tool_result") results.set(it.tool_use_id, { is_error: it.is_error, rejected: it.rejected, summary: it.summary });
  }
  let todos: Todo[] = [];
  const toolCounts: Partial<Record<ToolKind, number>> = {};
  const commands: CommandRun[] = [];
  const files = new Map<string, ChangedFile>();
  let messages = 0;
  let startedAt: string | null = null;
  let lastAt: string | null = null;
  for (const it of items) {
    if (it.timestamp) {
      startedAt ??= it.timestamp;
      lastAt = it.timestamp;
    }
    switch (it.type) {
      case "user_message":
      case "assistant_message":
        messages++;
        break;
      case "todos_updated":
        todos = it.todos;
        break;
      case "tool_call": {
        toolCounts[it.kind] = (toolCounts[it.kind] ?? 0) + 1;
        if (it.kind === "command") {
          const r = results.get(it.tool_use_id);
          commands.push({
            toolUseId: it.tool_use_id,
            command: it.summary,
            timestamp: it.timestamp,
            ok: r ? !r.is_error && !r.rejected : null,
            output: r?.summary ?? null,
          });
        }
        if (it.kind === "file_modified") {
          const path = it.change?.path ?? it.summary;
          if (!path) break;
          const d = it.change ? changeDiff(it.change) : { additions: 0, deletions: 0 };
          const f = files.get(path) ?? { path, additions: 0, deletions: 0, edits: 0, lastAt: it.timestamp, items: [] };
          f.additions += d.additions;
          f.deletions += d.deletions;
          f.edits++;
          f.lastAt = it.timestamp;
          f.items.push(it.n);
          files.set(path, f);
        }
        break;
      }
    }
  }
  const a = parseTime(startedAt);
  const b = parseTime(lastAt);
  return {
    todos,
    toolCounts,
    commands,
    files: [...files.values()].sort((x, y) => (parseTime(y.lastAt) ?? 0) - (parseTime(x.lastAt) ?? 0)),
    messages,
    startedAt,
    lastAt,
    durationMs: a !== null && b !== null ? b - a : null,
    results,
  };
}
