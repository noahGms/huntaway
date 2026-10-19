// Groups the timeline by turn: the user's message, the agent's work folded
// into one block, the agents it started and the questions it asked, its
// final answer, and the files the turn changed.

import type { StoredItem } from "../../api/types";
import { changeDiff } from "../../lib/diff";
import { parseTime } from "../../lib/format";
import { buildRows, type Row, type ToolCallItem, type ToolResultItem } from "./rows";

export interface WorkStats {
  reads: number;
  searches: number;
  commands: number;
  /** Distinct files modified. */
  edits: number;
  web: number;
  subagents: number;
  other: number;
}

export interface FileSummary {
  path: string;
  additions: number;
  deletions: number;
  created: boolean;
}

export type TurnRow =
  | Row
  | {
      kind: "work";
      key: string;
      rows: Row[];
      stats: WorkStats;
      /** Turn duration, when it ended. */
      durationMs: number | null;
      startedAt: string | null;
      /** The agent is working on this turn now. */
      live: boolean;
      /** What it is doing now (last action), while live. */
      current: string | null;
    }
  | { kind: "agent"; key: string; call: ToolCallItem; result?: ToolResultItem }
  | { kind: "files"; key: string; files: FileSummary[] };

type Item = StoredItem;

const isSidechain = (it: Item) => "sidechain" in it && it.sidechain;

/** Shown outside the work block. */
function visible(it: Item): boolean {
  if (isSidechain(it)) return false;
  switch (it.type) {
    case "user_message":
    case "question_asked":
    case "notice":
      return true;
    case "tool_call":
      return it.kind === "agent";
    default:
      return false;
  }
}

/** Counts as work: moves the agent's last answer after it. */
function isWork(it: Item): boolean {
  if (isSidechain(it)) return true;
  switch (it.type) {
    case "tool_call":
      return it.kind !== "agent" && it.kind !== "question";
    case "thinking":
    case "todos_updated":
      return true;
    default:
      return false;
  }
}

export function workStats(calls: ToolCallItem[]): WorkStats {
  const stats: WorkStats = { reads: 0, searches: 0, commands: 0, edits: 0, web: 0, subagents: 0, other: 0 };
  const files = new Set<string>();
  for (const c of calls) {
    if (c.sidechain) continue;
    switch (c.kind) {
      case "file_read":
        stats.reads++;
        break;
      case "search":
        stats.searches++;
        break;
      case "command":
        stats.commands++;
        break;
      case "file_modified":
        files.add(c.change?.path ?? c.summary);
        break;
      case "web":
        stats.web++;
        break;
      case "subagent":
        stats.subagents++;
        break;
      case "todo":
      case "question":
      case "plan":
      case "agent":
        break;
      default:
        stats.other++;
    }
  }
  stats.edits = files.size;
  return stats;
}

/** `6 files read · 2 commands · 2 files changed`. */
export function statsLabel(s: WorkStats): string {
  const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n > 1 ? many : one}`;
  return [
    s.reads && `${plural(s.reads, "file")} read`,
    s.searches && plural(s.searches, "search", "searches"),
    s.commands && plural(s.commands, "command"),
    s.edits && `${plural(s.edits, "file")} changed`,
    s.web && plural(s.web, "web request"),
    s.subagents && plural(s.subagents, "subagent"),
    s.other && plural(s.other, "other action"),
  ]
    .filter(Boolean)
    .join(" · ");
}

/** Files changed by the calls (accepted ones), additions and deletions summed per file. */
export function fileSummary(calls: ToolCallItem[], results: Map<string, ToolResultItem>): FileSummary[] {
  const map = new Map<string, FileSummary>();
  for (const c of calls) {
    if (c.kind !== "file_modified" || !c.change || c.sidechain) continue;
    const r = results.get(c.tool_use_id);
    if (r?.rejected || r?.is_error) continue;
    const d = changeDiff(c.change);
    const path = c.change.path;
    const f = map.get(path) ?? { path, additions: 0, deletions: 0, created: c.change.old === null && !c.change.new.startsWith("*** Begin Patch") };
    f.additions += d.additions;
    f.deletions += d.deletions;
    map.set(path, f);
  }
  return [...map.values()];
}

/**
 * Display rows, turn by turn. `live`: the agent is working, so the last
 * turn without a `turn_ended` is in progress.
 */
export function buildTurns(items: Item[], live: boolean): TurnRow[] {
  const results = new Map<string, ToolResultItem>();
  for (const it of items) if (it.type === "tool_result") results.set(it.tool_use_id, it);

  // Segments start at each user message. Away summaries show as a banner.
  const segments: Item[][] = [];
  for (const it of items) {
    if (it.type === "away_summary") continue;
    if (it.type === "user_message" || segments.length === 0) segments.push([]);
    segments[segments.length - 1].push(it);
  }

  const out: TurnRow[] = [];
  segments.forEach((seg, i) => {
    const last = i === segments.length - 1;
    const ended = seg.find((it) => it.type === "turn_ended") as Extract<Item, { type: "turn_ended" }> | undefined;
    // The answer: agent text after the last piece of work.
    let lastWork = -1;
    seg.forEach((it, j) => {
      if (isWork(it)) lastWork = j;
    });
    const work: Item[] = [];
    const calls: ToolCallItem[] = [];
    let workAt = -1;
    const shown: { at: number; row: TurnRow }[] = [];
    const answers: TurnRow[] = [];
    seg.forEach((it, j) => {
      if (it.type === "tool_call") calls.push(it);
      if (it.type === "tool_result" || it.type === "turn_ended") {
        if (it.type === "tool_result") work.push(it);
        return;
      }
      const key = `n${it.n}-${it.type}`;
      if (it.type === "assistant_message" && !it.sidechain) {
        if (j > lastWork) answers.push({ kind: "assistant", key, item: it, continued: false });
        else {
          work.push(it);
          if (workAt < 0) workAt = j;
        }
        return;
      }
      if (visible(it)) {
        switch (it.type) {
          case "user_message":
            shown.push({ at: j, row: { kind: "user", key, item: it } });
            break;
          case "question_asked":
            shown.push({ at: j, row: { kind: "question", key, item: it, result: results.get(it.tool_use_id), continued: false } });
            break;
          case "notice":
            shown.push({ at: j, row: { kind: "notice", key, item: it } });
            break;
          case "tool_call":
            shown.push({ at: j, row: { kind: "agent", key, call: it, result: results.get(it.tool_use_id) } });
            break;
        }
        return;
      }
      work.push(it);
      if (workAt < 0) workAt = j;
    });

    const rows = buildRows(work).filter((r) => r.kind !== "turn");
    const inProgress = live && last && !ended;
    if (rows.length || inProgress) {
      const lastCall = [...calls].reverse().find((c) => !c.sidechain && c.kind !== "agent");
      const lastThing = [...seg].reverse().find(isWork);
      const startedAt = seg[0] && "timestamp" in seg[0] ? seg[0].timestamp : null;
      const endTs = [...seg].reverse().find((it) => "timestamp" in it)?.timestamp;
      const span = parseTime(endTs) !== null && parseTime(startedAt) !== null ? parseTime(endTs)! - parseTime(startedAt)! : null;
      shown.push({
        at: workAt < 0 ? seg.length : workAt,
        row: {
          kind: "work",
          key: `w${seg[0]?.n ?? i}`,
          rows,
          stats: workStats(calls),
          durationMs: ended?.duration_ms ?? (!inProgress && span !== null && span > 0 ? span : null),
          startedAt,
          live: inProgress,
          current: inProgress ? (lastThing?.type === "thinking" ? "Thinking…" : (lastCall?.summary ?? null)) : null,
        },
      });
    }
    shown.sort((a, b) => a.at - b.at);
    for (const s of shown) out.push(s.row);
    out.push(...answers);
    const files = fileSummary(calls, results);
    if (files.length && !inProgress) out.push({ kind: "files", key: `f${seg[0]?.n ?? i}`, files });
  });
  return out;
}
