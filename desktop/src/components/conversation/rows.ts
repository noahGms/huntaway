// Turns timeline items into display rows: consecutive reads/searches are
// grouped, results attach to their calls, sub-agent work is folded.

import type { StoredItem } from "../../api/types";

export type ToolCallItem = Extract<StoredItem, { type: "tool_call" }>;
export type ToolResultItem = Extract<StoredItem, { type: "tool_result" }>;

export type Row =
  | { kind: "user"; key: string; item: Extract<StoredItem, { type: "user_message" }> }
  | { kind: "assistant"; key: string; item: Extract<StoredItem, { type: "assistant_message" }>; continued: boolean }
  | { kind: "tools"; key: string; calls: ToolCallItem[]; continued: boolean }
  | { kind: "command"; key: string; call: ToolCallItem; result?: ToolResultItem; continued: boolean }
  | { kind: "file"; key: string; call: ToolCallItem; result?: ToolResultItem; continued: boolean }
  | { kind: "tool"; key: string; call: ToolCallItem; result?: ToolResultItem; continued: boolean }
  | { kind: "plan"; key: string; item: Extract<StoredItem, { type: "todos_updated" }>; latest: boolean; continued: boolean }
  | { kind: "question"; key: string; item: Extract<StoredItem, { type: "question_asked" }>; result?: ToolResultItem; continued: boolean }
  | { kind: "proposal"; key: string; call: ToolCallItem; result?: ToolResultItem; continued: boolean }
  | { kind: "subagent"; key: string; items: StoredItem[]; continued: boolean }
  | { kind: "thinking"; key: string; item: Extract<StoredItem, { type: "thinking" }>; continued: boolean }
  | { kind: "turn"; key: string; item: Extract<StoredItem, { type: "turn_ended" }> }
  | { kind: "away"; key: string; item: Extract<StoredItem, { type: "away_summary" }> }
  | { kind: "notice"; key: string; item: Extract<StoredItem, { type: "notice" }> };

const GROUPED = new Set(["file_read", "search", "web"]);

export function buildRows(items: StoredItem[]): Row[] {
  const results = new Map<string, ToolResultItem>();
  for (const it of items) if (it.type === "tool_result") results.set(it.tool_use_id, it);
  const lastPlan = [...items].reverse().find((i) => i.type === "todos_updated")?.n;
  const questionIds = new Set(items.filter((i) => i.type === "question_asked").map((i) => (i as { tool_use_id: string }).tool_use_id));

  const rows: Row[] = [];
  // Whether the previous row belongs to the agent (to skip repeated headers).
  let agentTurn = false;
  const push = (row: Row) => rows.push(row);

  for (const it of items) {
    const key = `n${it.n}-${it.type}`;
    const sidechain = "sidechain" in it && it.sidechain;
    if (sidechain) {
      const last = rows[rows.length - 1];
      if (last?.kind === "subagent") last.items.push(it);
      else push({ kind: "subagent", key, items: [it], continued: agentTurn });
      agentTurn = true;
      continue;
    }
    switch (it.type) {
      case "user_message":
        push({ kind: "user", key, item: it });
        agentTurn = false;
        break;
      case "assistant_message":
        push({ kind: "assistant", key, item: it, continued: agentTurn });
        agentTurn = true;
        break;
      case "tool_call": {
        const result = results.get(it.tool_use_id);
        if (it.kind === "question" && questionIds.has(it.tool_use_id)) break;
        if (it.kind === "todo" && it.name === "TodoWrite") break;
        if (GROUPED.has(it.kind)) {
          const last = rows[rows.length - 1];
          if (last?.kind === "tools") last.calls.push(it);
          else push({ kind: "tools", key, calls: [it], continued: agentTurn });
        } else if (it.kind === "command") {
          push({ kind: "command", key, call: it, result, continued: agentTurn });
        } else if (it.kind === "file_modified") {
          push({ kind: "file", key, call: it, result, continued: agentTurn });
        } else if (it.kind === "plan" && it.plan) {
          push({ kind: "proposal", key, call: it, result, continued: agentTurn });
        } else {
          push({ kind: "tool", key, call: it, result, continued: agentTurn });
        }
        agentTurn = true;
        break;
      }
      case "thinking":
        push({ kind: "thinking", key, item: it, continued: agentTurn });
        agentTurn = true;
        break;
      case "todos_updated":
        push({ kind: "plan", key, item: it, latest: it.n === lastPlan, continued: agentTurn });
        agentTurn = true;
        break;
      case "question_asked":
        push({ kind: "question", key, item: it, result: results.get(it.tool_use_id), continued: agentTurn });
        agentTurn = true;
        break;
      case "turn_ended":
        push({ kind: "turn", key, item: it });
        agentTurn = false;
        break;
      case "away_summary":
        push({ kind: "away", key, item: it });
        break;
      case "notice":
        push({ kind: "notice", key, item: it });
        break;
      case "tool_result":
        break;
    }
  }
  return rows;
}
