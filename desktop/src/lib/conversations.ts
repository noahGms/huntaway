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

/** Identifies a conversation for archiving: the agent's session, so it stays
 * archived once the agent stops and it moves to the history. */
export function archiveId(c: Conversation): string {
  const session = c.agent?.native_session ?? c.history?.session_id;
  return session ? `${c.machineId}|${c.kind}:${session}` : c.key;
}

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

/**
 * Projects in a fixed order, so the list does not move under the cursor:
 * favorites, then the user's order, then by name.
 */
export function sortProjects(groups: Group[], favorites: ReadonlySet<string>, order: readonly string[]): Group[] {
  const rank = (id: string) => {
    const i = order.indexOf(id);
    return i === -1 ? Infinity : i;
  };
  return [...groups].sort(
    (a, b) =>
      Number(favorites.has(b.id)) - Number(favorites.has(a.id)) ||
      (rank(a.id) === rank(b.id) ? 0 : rank(a.id) < rank(b.id) ? -1 : 1) ||
      a.label.localeCompare(b.label, undefined, { sensitivity: "base" }) ||
      a.id.localeCompare(b.id),
  );
}

/**
 * Fixed order inside a project: live agents, newest started first, then past
 * conversations, most recent first. A status change moves nothing (the
 * Waiting section and the status dots show what needs attention).
 */
export function compareStable(a: Conversation, b: Conversation): number {
  if (a.live !== b.live) return a.live ? -1 : 1;
  // An agent without a start date yet is new: on top.
  const time = (c: Conversation) => parseTime(c.live ? (c.agent?.started_at ?? null) : c.lastActivity) ?? Number.MAX_SAFE_INTEGER;
  return time(b) - time(a) || a.key.localeCompare(b.key);
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
  | {
      type: "project";
      id: string;
      machineId: string;
      project: string;
      count: number;
      waiting: number;
      collapsed: boolean;
      favorite: boolean;
      depth: number;
      /** `projectKey()` of the machine's projects, in display order (to move this one). */
      siblings: string[];
    }
  | { type: "conv"; id: string; conv: Conversation; depth: number; suffix?: string; tree?: ConvTree }
  | { type: "inactive"; id: string; hidden: number; showing: boolean };

export interface SidebarOptions {
  grouping: "date" | "project";
  /** Machines of the current space, in display order. */
  machines: { id: string; name: string }[];
  collapsed: ReadonlySet<string>;
  favorites: ReadonlySet<string>;
  /** `projectKey()` in the order set by the user; others follow by name. */
  projectOrder?: readonly string[];
  /** Projects idle for this many days are hidden (0 = never). */
  inactiveDays: number;
  showInactive: boolean;
  now?: number;
}

/** Agents started by an agent shown in the list, under that agent. */
export interface ConvTree {
  children: Conversation[];
  /** Descendants, all levels. */
  total: number;
  expanded: boolean;
  /** Most urgent state of the conversation and its descendants. */
  rollup: Attention | null;
}

const urgency = (a: Attention | null | undefined) => (!a ? 9 : a.status === "blocked" ? 0 : a.status === "working" ? 1 : 5);

/** The most urgent of two states (blocked, then working). */
export function moreUrgent(a: Attention | null, b: Attention | null): Attention | null {
  return urgency(b) < urgency(a) ? b : a;
}

/**
 * Splits live conversations into roots and children: an agent whose
 * `parent_id` names another live agent of the list goes under it.
 */
export function nestConversations(list: Conversation[]): { roots: Conversation[]; childrenOf: Map<string, Conversation[]> } {
  const keys = new Set(list.map((c) => c.key));
  const childrenOf = new Map<string, Conversation[]>();
  const roots: Conversation[] = [];
  for (const c of list) {
    const parent = c.agent?.parent_id ? liveKey(c.machineId, c.agent.parent_id) : null;
    if (parent && parent !== c.key && keys.has(parent)) {
      const items = childrenOf.get(parent) ?? [];
      items.push(c);
      childrenOf.set(parent, items);
    } else {
      roots.push(c);
    }
  }
  // A cycle leaves its members without a root: show them at the top level.
  const reachable = new Set<string>();
  const visit = (k: string) => {
    if (reachable.has(k)) return;
    reachable.add(k);
    for (const c of childrenOf.get(k) ?? []) visit(c.key);
  };
  for (const r of roots) visit(r.key);
  for (const c of list) if (!reachable.has(c.key)) roots.push(c);
  return { roots, childrenOf };
}

/** Collapsed state of a conversation's children: `c:` = collapsed, `x:` = expanded by the user. */
export const treeCollapsedId = (key: string) => `c:${key}`;
export const treeExpandedId = (key: string) => `x:${key}`;

function treeOf(c: Conversation, childrenOf: Map<string, Conversation[]>, collapsed: ReadonlySet<string>, seen = new Set<string>()): ConvTree | undefined {
  const children = childrenOf.get(c.key);
  if (!children?.length || seen.has(c.key)) return undefined;
  seen.add(c.key);
  let total = 0;
  let rollup: Attention | null = c.attention;
  let childAttention: Attention | null = null;
  for (const child of children) {
    const sub = treeOf(child, childrenOf, collapsed, seen);
    total += 1 + (sub?.total ?? 0);
    const r = sub?.rollup ?? child.attention;
    rollup = moreUrgent(rollup, r);
    childAttention = moreUrgent(childAttention, r);
  }
  // Open by default while a child needs attention.
  const expanded = collapsed.has(treeExpandedId(c.key)) || (!collapsed.has(treeCollapsedId(c.key)) && childAttention?.status === "blocked");
  return { children, total, expanded, rollup };
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
export function buildSidebarRows(all: Conversation[], opts: SidebarOptions): SidebarRow[] {
  const now = opts.now ?? Date.now();
  const multi = opts.machines.length > 1;
  const { roots: list, childrenOf } = nestConversations(all);
  const trees = new Map<string, ConvTree>();
  for (const c of all) {
    const t = treeOf(c, childrenOf, opts.collapsed);
    if (t) trees.set(c.key, t);
  }
  const isWaiting = (c: Conversation) => (trees.get(c.key)?.rollup ?? c.attention)?.status === "blocked";
  const inactive = inactiveProjects(list, opts.favorites, opts.inactiveDays, now);
  const visible = opts.showInactive || !inactive.size ? list : list.filter((c) => !inactive.has(projectKey(c.machineId, c.project)));
  // Project (and machine) suffix, unless everything shown shares them.
  const oneProject = !multi && new Set(visible.map((c) => c.project)).size <= 1;
  const suffix = (c: Conversation) => (oneProject ? undefined : multi ? `${c.project} · ${c.machineName}` : c.project);
  const rows: SidebarRow[] = [];
  /** The conversation, then its children when expanded. */
  const pushConv = (c: Conversation, id: string, depth: number, sfx?: string, seen = new Set<string>()) => {
    const tree = trees.get(c.key);
    rows.push({ type: "conv", id, conv: c, depth, suffix: sfx, tree });
    if (!tree?.expanded || seen.has(c.key)) return;
    seen.add(c.key);
    for (const child of tree.children) pushConv(child, `${id}>${child.key}`, depth + 1, undefined, seen);
  };

  const waiting = visible.filter(isWaiting);
  if (waiting.length) {
    rows.push({ type: "header", id: "h-waiting", label: "Waiting", waiting: true });
    for (const c of waiting) pushConv(c, `w-${c.key}`, 0, suffix(c));
  }

  if (opts.grouping === "date") {
    for (const g of groupConversations(visible, "date", now)) {
      const items = g.items.filter((c) => !isWaiting(c));
      if (g.id === "waiting" || !items.length) continue;
      rows.push({ type: "header", id: `h-${g.id}`, label: g.label });
      for (const c of items) pushConv(c, c.key, 0, suffix(c));
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
      const projects = sortProjects(projectGroups(items), opts.favorites, opts.projectOrder ?? []);
      const siblings = projects.map((p) => p.id);
      for (const p of projects) {
        const id = `p:${p.id}`;
        const collapsed = opts.collapsed.has(id);
        rows.push({
          type: "project",
          id,
          machineId: m.id,
          project: p.label,
          count: p.items.length,
          waiting: p.items.filter(isWaiting).length,
          collapsed,
          favorite: opts.favorites.has(p.id),
          depth,
          siblings,
        });
        if (!collapsed) for (const c of [...p.items].sort(compareStable)) pushConv(c, c.key, depth + 1);
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
