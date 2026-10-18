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
  return agent.tab_label ? `${kind} · tab ${agent.tab_label}` : kind;
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

export const projectKey = (machineId: string, project: string) => `${machineId}|${project}`;

export interface Group {
  id: string;
  label: string;
  items: Conversation[];
}

const DAY = 86_400_000;

/** Flat sidebar groups. Waiting agents always get their own group on top. */
export function groupConversations(list: Conversation[], by: "date" | "project", now = Date.now()): Group[] {
  const waiting = list.filter((c) => c.attention?.status === "blocked");
  const rest = list.filter((c) => c.attention?.status !== "blocked");
  const groups: Group[] = [];
  if (waiting.length) groups.push({ id: "waiting", label: "Waiting", items: waiting });
  if (by === "project") {
    const sorted = projectGroups(rest);
    // Same project name on two machines: say which one.
    const names = new Map<string, number>();
    for (const g of sorted) names.set(g.label, (names.get(g.label) ?? 0) + 1);
    for (const g of sorted) if ((names.get(g.label) ?? 0) > 1) g.label = `${g.label} · ${g.items[0].machineName}`;
    return groups.concat(sorted);
  }
  const today = startOfDay(now);
  const buckets: [string, string, (t: number) => boolean][] = [
    ["today", "Today", (t) => t >= today],
    ["yesterday", "Yesterday", (t) => t >= today - DAY],
    ["week", "This week", (t) => t >= today - 6 * DAY],
    ["month", "This month", (t) => t >= today - 30 * DAY],
    ["older", "Older", () => true],
  ];
  const byBucket = new Map<string, Conversation[]>();
  for (const c of rest) {
    const t = parseTime(c.lastActivity) ?? 0;
    const bucket = buckets.find(([, , test]) => test(t))!;
    const items = byBucket.get(bucket[0]) ?? [];
    items.push(c);
    byBucket.set(bucket[0], items);
  }
  for (const [id, label] of buckets) {
    const items = byBucket.get(id);
    if (items?.length) groups.push({ id, label, items });
  }
  return groups;
}

/** One group per (machine, project), most recent first; ids are `projectKey()`. */
function projectGroups(list: Conversation[]): Group[] {
  const map = new Map<string, Group>();
  for (const c of list) {
    const id = projectKey(c.machineId, c.project);
    let g = map.get(id);
    if (!g) {
      g = { id, label: c.project, items: [] };
      map.set(id, g);
    }
    g.items.push(c);
  }
  return [...map.values()].sort((a, b) => latest(b.items) - latest(a.items));
}

function latest(items: Conversation[]): number {
  let t = 0;
  for (const c of items) t = Math.max(t, parseTime(c.lastActivity) ?? 0);
  return t;
}

const isWaiting = (c: Conversation) => c.attention?.status === "blocked";

export type SidebarRow =
  | { type: "header"; id: string; label: string; waiting?: boolean }
  | { type: "machine"; id: string; machineId: string; name: string; count: number; waiting: number; collapsed: boolean }
  | { type: "project"; id: string; machineId: string; project: string; count: number; waiting: number; collapsed: boolean; favorite: boolean; depth: number }
  | { type: "conv"; id: string; conv: Conversation; depth: number; suffix?: string }
  | { type: "inactive"; id: string; hidden: number; showing: boolean };

export interface SidebarOptions {
  grouping: "date" | "project";
  /** Machines of the current space, in display order. */
  machines: { id: string; name: string }[];
  collapsed: ReadonlySet<string>;
  favorites: ReadonlySet<string>;
  /** Projects idle for this many days are hidden (0 = never). */
  inactiveDays: number;
  showInactive: boolean;
  now?: number;
}

/** Projects that are idle: no live agent, not a favorite, no activity for `days`. */
export function inactiveProjects(list: Conversation[], favorites: ReadonlySet<string>, days: number, now = Date.now()): Set<string> {
  const out = new Set<string>();
  if (days <= 0) return out;
  const cutoff = now - days * DAY;
  const active = new Set<string>();
  const seen = new Set<string>();
  for (const c of list) {
    const key = projectKey(c.machineId, c.project);
    seen.add(key);
    if (c.live || (parseTime(c.lastActivity) ?? 0) >= cutoff) active.add(key);
  }
  for (const key of seen) if (!active.has(key) && !favorites.has(key)) out.add(key);
  return out;
}

/**
 * Rows of the sidebar list. Waiting agents are pinned on top (across
 * machines); the rest is grouped by date, or as a Machine → Project tree
 * (the machine level is skipped when the space has a single machine).
 */
export function buildSidebarRows(list: Conversation[], opts: SidebarOptions): SidebarRow[] {
  const now = opts.now ?? Date.now();
  const multi = opts.machines.length > 1;
  const inactive = inactiveProjects(list, opts.favorites, opts.inactiveDays, now);
  const visible = opts.showInactive || !inactive.size ? list : list.filter((c) => !inactive.has(projectKey(c.machineId, c.project)));
  // Project (and machine) suffix, unless everything shown shares them.
  const oneProject = !multi && new Set(visible.map((c) => c.project)).size <= 1;
  const suffix = (c: Conversation) => (oneProject ? undefined : multi ? `${c.project} · ${c.machineName}` : c.project);
  const rows: SidebarRow[] = [];

  const waiting = visible.filter(isWaiting);
  if (waiting.length) {
    rows.push({ type: "header", id: "h-waiting", label: "Waiting", waiting: true });
    for (const c of waiting) rows.push({ type: "conv", id: `w-${c.key}`, conv: c, depth: 0, suffix: suffix(c) });
  }

  if (opts.grouping === "date") {
    for (const g of groupConversations(visible, "date", now)) {
      if (g.id === "waiting") continue;
      rows.push({ type: "header", id: `h-${g.id}`, label: g.label });
      for (const c of g.items) rows.push({ type: "conv", id: c.key, conv: c, depth: 0, suffix: suffix(c) });
    }
  } else {
    const byMachine = new Map<string, Conversation[]>();
    for (const c of visible) {
      const items = byMachine.get(c.machineId) ?? [];
      items.push(c);
      byMachine.set(c.machineId, items);
    }
    for (const m of opts.machines) {
      const items = byMachine.get(m.id) ?? [];
      const machineId = `m:${m.id}`;
      const machineCollapsed = multi && opts.collapsed.has(machineId);
      if (multi) {
        rows.push({ type: "machine", id: machineId, machineId: m.id, name: m.name, count: items.length, waiting: items.filter(isWaiting).length, collapsed: machineCollapsed });
        if (machineCollapsed) continue;
      }
      const depth = multi ? 1 : 0;
      const projects = projectGroups(items).sort((a, b) => Number(opts.favorites.has(b.id)) - Number(opts.favorites.has(a.id)));
      for (const p of projects) {
        const id = `p:${p.id}`;
        const collapsed = opts.collapsed.has(id);
        rows.push({ type: "project", id, machineId: m.id, project: p.label, count: p.items.length, waiting: p.items.filter(isWaiting).length, collapsed, favorite: opts.favorites.has(p.id), depth });
        if (!collapsed) for (const c of p.items) rows.push({ type: "conv", id: c.key, conv: c, depth: depth + 1 });
      }
    }
  }

  if (inactive.size) rows.push({ type: "inactive", id: "inactive", hidden: inactive.size, showing: opts.showInactive });
  return rows;
}

/** Conversations matching every word of the query (title, project, machine, agent). */
export function searchConversations(list: Conversation[], query: string, limit = Infinity): Conversation[] {
  const words = query.toLowerCase().split(/[\s@]+/).filter(Boolean);
  if (!words.length) return list.slice(0, limit);
  const out: Conversation[] = [];
  for (const c of list) {
    const text = `${c.title} ${c.project} ${c.machineName} ${c.kind}`.toLowerCase();
    if (words.every((w) => text.includes(w))) {
      out.push(c);
      if (out.length >= limit) break;
    }
  }
  return out;
}

export interface ProjectSummary {
  key: string;
  machineId: string;
  machineName: string;
  project: string;
  count: number;
  waiting: number;
  lastActivity: number;
  /** A live agent of the project (its workspace hosts new sessions). */
  agent?: AgentView;
}

/** Every (machine, project) pair, most recent first. */
export function projectsOf(list: Conversation[]): ProjectSummary[] {
  const map = new Map<string, ProjectSummary>();
  for (const c of list) {
    const key = projectKey(c.machineId, c.project);
    let p = map.get(key);
    if (!p) {
      p = { key, machineId: c.machineId, machineName: c.machineName, project: c.project, count: 0, waiting: 0, lastActivity: 0 };
      map.set(key, p);
    }
    p.count++;
    if (isWaiting(c)) p.waiting++;
    p.lastActivity = Math.max(p.lastActivity, parseTime(c.lastActivity) ?? 0);
    if (!p.agent && c.agent) p.agent = c.agent;
  }
  return [...map.values()].sort((a, b) => b.lastActivity - a.lastActivity);
}

/** `now`, `5m`, `3h`, `2d`, `3w`, `Oct 12`: fits a narrow fixed-width column. */
export function compactAge(iso: string | null | undefined, now = Date.now()): string {
  const t = parseTime(iso);
  if (t === null) return "";
  const s = Math.max(0, (now - t) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h`;
  if (s < 7 * 86_400) return `${Math.floor(s / 86_400)}d`;
  if (s < 35 * 86_400) return `${Math.floor(s / (7 * 86_400))}w`;
  return new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** `Oct 12, 2026, 2:28 PM`. */
export function longDate(iso: string | null | undefined): string {
  const t = parseTime(iso);
  if (t === null) return "";
  return new Date(t).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
}

export function statusLabel(attention: Attention | null): string {
  if (!attention) return "Archived";
  switch (attention.status) {
    case "blocked":
      return {
        approval: "Needs approval",
        question: "Question",
        plan: "Plan to review",
        explicit_question: "Asked you something",
        prompt: "Waiting",
      }[attention.reason];
    case "working":
      return "Working";
    case "done":
      return "Done";
    case "idle":
      return "Idle";
    default:
      return "Unknown";
  }
}
