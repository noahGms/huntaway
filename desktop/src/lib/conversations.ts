// Conversations shown in the sidebar: live agents of every machine, plus
// recent past conversations (history) that no agent is running.

import type { AgentView, Attention, HistoryEntry, MachineView } from "../api/types";
import { firstLine, humanizeSlug, parseTime, startOfDay } from "./format";

export interface Conversation {
  key: string;
  machineId: string;
  machineName: string;
  local: boolean;
  live: boolean;
  agentId?: string;
  historyId?: string;
  kind: string;
  title: string;
  project: string;
  cwd: string | null;
  attention: Attention | null;
  lastActivity: string | null;
  agent?: AgentView;
  history?: HistoryEntry;
}

export const liveKey = (machineId: string, agentId: string) => `live|${machineId}|${agentId}`;
export const historyKey = (machineId: string, historyId: string) => `hist|${machineId}|${historyId}`;

export function parseKey(key: string): { live: boolean; machineId: string; id: string } | null {
  const [kind, machineId, ...rest] = key.split("|");
  if (!machineId || rest.length === 0) return null;
  return { live: kind === "live", machineId, id: rest.join("|") };
}

export function agentTitle(agent: AgentView): string {
  if (agent.name) return agent.name;
  if (agent.title) return humanizeSlug(agent.title);
  if (agent.summary) return firstLine(agent.summary, 80);
  const kind = agent.kind.charAt(0).toUpperCase() + agent.kind.slice(1);
  return agent.tab_label ? `${kind} · onglet ${agent.tab_label}` : kind;
}

export function fromAgent(machine: MachineView, agent: AgentView): Conversation {
  return {
    key: liveKey(machine.record.machine_id, agent.id),
    machineId: machine.record.machine_id,
    machineName: machine.record.name,
    local: machine.record.local,
    live: true,
    agentId: agent.id,
    kind: agent.kind,
    title: agentTitle(agent),
    project: agent.workspace_label || agent.project || "—",
    cwd: agent.cwd,
    attention: agent.attention,
    lastActivity: agent.last_activity_at,
    agent,
  };
}

export function fromHistory(machine: MachineView, entry: HistoryEntry): Conversation {
  return {
    key: historyKey(machine.record.machine_id, entry.id),
    machineId: machine.record.machine_id,
    machineName: machine.record.name,
    local: machine.record.local,
    live: false,
    historyId: entry.id,
    kind: entry.kind,
    title: humanizeSlug(entry.title),
    project: entry.project || "—",
    cwd: entry.cwd,
    attention: null,
    lastActivity: entry.last_activity_at,
    history: entry,
  };
}

export function buildConversations(machines: MachineView[], history: Record<string, HistoryEntry[]>): Conversation[] {
  const out: Conversation[] = [];
  for (const machine of machines) {
    const agents = machine.snapshot?.agents ?? [];
    const running = new Set(agents.map((a) => a.native_session).filter(Boolean));
    for (const agent of agents) out.push(fromAgent(machine, agent));
    for (const entry of history[machine.record.machine_id] ?? []) {
      if (entry.live_agent_id || running.has(entry.session_id)) continue;
      out.push(fromHistory(machine, entry));
    }
  }
  out.sort(compareConversations);
  return out;
}

/** Waiting agents first, then working, then by last activity. */
export function compareConversations(a: Conversation, b: Conversation): number {
  const rank = (c: Conversation) => {
    if (!c.attention) return 6;
    switch (c.attention.status) {
      case "blocked":
        return 0;
      case "working":
        return 1;
      default:
        return 2;
    }
  };
  const r = rank(a) - rank(b);
  if (r !== 0 && (rank(a) <= 1 || rank(b) <= 1)) return r;
  return (parseTime(b.lastActivity) ?? 0) - (parseTime(a.lastActivity) ?? 0);
}

export interface Group {
  id: string;
  label: string;
  items: Conversation[];
}

/** Sidebar groups. Waiting agents always get their own group on top. */
export function groupConversations(list: Conversation[], by: "date" | "project", now = Date.now()): Group[] {
  const waiting = list.filter((c) => c.attention?.status === "blocked");
  const rest = list.filter((c) => c.attention?.status !== "blocked");
  const groups: Group[] = [];
  if (waiting.length) groups.push({ id: "waiting", label: "En attente", items: waiting });
  if (by === "project") {
    const map = new Map<string, Group>();
    for (const c of rest) {
      const id = `${c.machineId}|${c.project}`;
      let g = map.get(id);
      if (!g) {
        g = { id, label: c.project, items: [] };
        map.set(id, g);
      }
      g.items.push(c);
    }
    const sorted = [...map.values()].sort(
      (a, b) => (parseTime(b.items[0]?.lastActivity) ?? 0) - (parseTime(a.items[0]?.lastActivity) ?? 0),
    );
    // Same project name on two machines: say which one.
    const names = new Map<string, number>();
    for (const g of sorted) names.set(g.label, (names.get(g.label) ?? 0) + 1);
    for (const g of sorted) if ((names.get(g.label) ?? 0) > 1) g.label = `${g.label} · ${g.items[0].machineName}`;
    return groups.concat(sorted);
  }
  const today = startOfDay(now);
  const buckets: [string, string, (t: number) => boolean][] = [
    ["today", "Aujourd'hui", (t) => t >= today],
    ["yesterday", "Hier", (t) => t >= today - 86_400_000],
    ["week", "Cette semaine", (t) => t >= today - 6 * 86_400_000],
    ["month", "Ce mois-ci", (t) => t >= today - 30 * 86_400_000],
    ["older", "Plus ancien", () => true],
  ];
  const by_bucket = new Map<string, Conversation[]>();
  for (const c of rest) {
    const t = parseTime(c.lastActivity) ?? 0;
    const bucket = buckets.find(([, , test]) => test(t))!;
    const items = by_bucket.get(bucket[0]) ?? [];
    items.push(c);
    by_bucket.set(bucket[0], items);
  }
  for (const [id, label] of buckets) {
    const items = by_bucket.get(id);
    if (items?.length) groups.push({ id, label, items });
  }
  return groups;
}

export function statusLabel(attention: Attention | null): string {
  if (!attention) return "Archivée";
  switch (attention.status) {
    case "blocked":
      return {
        approval: "Approbation requise",
        question: "Question",
        plan: "Plan à valider",
        explicit_question: "T'a posé une question",
        prompt: "En attente",
      }[attention.reason];
    case "working":
      return "En cours";
    case "done":
      return "Terminé";
    case "idle":
      return "Inactif";
    default:
      return "Inconnu";
  }
}
