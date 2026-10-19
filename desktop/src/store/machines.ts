// Machines, their state and conversation timelines, kept in sync with the
// Tauri backend events (`machine-status`, `machine-snapshot`, `machine-event`).

import { listen } from "@tauri-apps/api/event";
import { create } from "zustand";
import { api, app } from "../api/client";
import type { AgentView, Envelope, HistoryEntry, MachineLimits, MachineStatus, MachineView, StateSnapshot, StoredItem, TimelinePage } from "../api/types";
import { liveKey, parseKey } from "../lib/conversations";
import { useLimits } from "./limits";
import { useProjects } from "./projects";

export interface TimelineState {
  items: StoredItem[];
  hasMore: boolean;
  /** The start of a live conversation is only in the history. */
  olderInHistory?: boolean;
  loading: boolean;
  loaded: boolean;
  error: string | null;
  /** Agent instance the items belong to (a new occupant resets them). */
  instance?: string;
}

interface MachinesState {
  machines: Record<string, MachineView>;
  /** Recent past conversations per machine, for the sidebar. */
  history: Record<string, HistoryEntry[]>;
  timelines: Record<string, TimelineState>;
  /** Live agents just created or resumed from this app, with the time until
   * which their conversation shows "Starting…" before they show up. */
  expected: Record<string, number>;
  ready: boolean;
  init: () => Promise<() => void>;
  refresh: () => Promise<void>;
  loadHistory: (machineId: string) => Promise<void>;
  loadTimeline: (key: string, older?: boolean) => Promise<void>;
  /** Marks a live conversation as started from here (see `expected`). */
  expect: (key: string) => void;
  agent: (machineId: string, agentId: string) => AgentView | undefined;
}

const emptyTimeline: TimelineState = { items: [], hasMore: false, loading: false, loaded: false, error: null };

/** How long a created agent may take to show up. */
export const START_TIMEOUT_MS = 20_000;
/** Timelines kept in memory; the least recently opened ones are dropped. */
const MAX_TIMELINES = 20;

export function mergeItems(existing: StoredItem[], incoming: StoredItem[]): StoredItem[] {
  if (!existing.length) return incoming;
  if (!incoming.length) return existing;
  // Common case: new items after the last one (live events), or a page before the first.
  const last = existing[existing.length - 1].n;
  if (incoming.every((i, j) => i.n > last && (j === 0 || i.n > incoming[j - 1].n))) return existing.concat(incoming);
  const first = existing[0].n;
  if (incoming.every((i, j) => i.n < first && (j === 0 || i.n > incoming[j - 1].n))) return incoming.concat(existing);
  const seen = new Set(existing.map((i) => i.n));
  const fresh = incoming.filter((i) => !seen.has(i.n));
  if (!fresh.length) return existing;
  const merged = existing.concat(fresh);
  merged.sort((a, b) => a.n - b.n);
  return merged;
}

// Bookkeeping outside the state (no re-render).
/** Live items received while the first page loads, merged when it arrives. */
const buffered = new Map<string, StoredItem[]>();
/** A reload was asked while a load was in flight: run it after. */
const reloadAfter = new Set<string>();
/** Bumped when a timeline is reset: older loads in flight are discarded. */
const generation = new Map<string, number>();
/** Timeline keys, least recently opened first. */
const recent: string[] = [];
/** Timelines reloaded once after a load because items were missing. */
const gapRetried = new Set<string>();
/** Item filter last sent per machine (sorted agent ids). */
const sentItems = new Map<string, string>();

/** Number of the last item of a timeline, -1 when empty. */
const lastN = (tl: TimelineState) => (tl.items.length ? tl.items[tl.items.length - 1].n : -1);

/** Live agents whose timeline is in memory, per machine (the others' items are not streamed). */
export function streamedAgents(machineIds: string[], timelineKeys: string[]): Record<string, string[]> {
  const byMachine: Record<string, string[]> = {};
  for (const id of machineIds) byMachine[id] = [];
  for (const key of timelineKeys) {
    const k = parseKey(key);
    if (k?.live && byMachine[k.machineId]) byMachine[k.machineId].push(k.id);
  }
  for (const ids of Object.values(byMachine)) ids.sort();
  return byMachine;
}

/** Marks a timeline as opened (kept in memory over older ones). */
export function touchTimeline(key: string) {
  const i = recent.indexOf(key);
  if (i !== -1) recent.splice(i, 1);
  recent.push(key);
}

export const useMachines = create<MachinesState>((set, get) => {
  const setMachine = (id: string, update: (m: MachineView) => MachineView) =>
    set((s) => (s.machines[id] ? { machines: { ...s.machines, [id]: update(s.machines[id]) } } : s));

  const onEvent = (machineId: string, event: Envelope) => {
    const agentId = event.agent_id;
    switch (event.type) {
      case "agent.updated": {
        const agent = event.data as AgentView;
        setMachine(machineId, (m) => {
          if (!m.snapshot) return m;
          const agents = m.snapshot.agents.some((a) => a.id === agent.id)
            ? m.snapshot.agents.map((a) => (a.id === agent.id ? agent : a))
            : [...m.snapshot.agents, agent];
          return { ...m, snapshot: { ...m.snapshot, agents, seq: event.seq } };
        });
        const key = liveKey(machineId, agent.id);
        const tl = get().timelines[key];
        if (tl?.instance && tl.instance !== agent.instance_id) {
          // Another agent took the pane (or `/clear`): its items are numbered from 0 again.
          resetTimeline(key);
          void get().loadTimeline(key);
        } else if (tl?.loaded && !tl.loading && lastN(tl) < agent.item_count - 1) {
          // Items missing (not streamed while it was being opened, history attached late): fetch them.
          void get().loadTimeline(key);
        }
        break;
      }
      case "agent.removed":
        if (!agentId) break;
        setMachine(machineId, (m) =>
          m.snapshot ? { ...m, snapshot: { ...m.snapshot, agents: m.snapshot.agents.filter((a) => a.id !== agentId) } } : m,
        );
        // Its transcript is now a past conversation.
        void get().loadHistory(machineId);
        break;
      case "agent.item": {
        if (!agentId) break;
        const key = liveKey(machineId, agentId);
        const tl = get().timelines[key];
        const item = event.data as StoredItem;
        if (tl?.loading) {
          // Not in the page being loaded, maybe: merged when it arrives.
          buffered.set(key, [...(buffered.get(key) ?? []), item]);
          break;
        }
        if (!tl?.loaded) break;
        const items = mergeItems(tl.items, [item]);
        if (items !== tl.items) set((s) => ({ timelines: { ...s.timelines, [key]: { ...tl, items } } }));
        break;
      }
      case "workspaces.updated":
        setMachine(machineId, (m) =>
          m.snapshot ? { ...m, snapshot: { ...m.snapshot, workspaces: (event.data as { workspaces: StateSnapshot["workspaces"] }).workspaces } } : m,
        );
        break;
      case "scripts.updated":
      case "shells.updated":
        useProjects.getState().onEvent(machineId, event);
        break;
      case "limits.updated":
        useLimits.getState().set(machineId, event.data as MachineLimits);
        break;
      case "sessions.updated":
        setMachine(machineId, (m) =>
          m.snapshot ? { ...m, snapshot: { ...m.snapshot, sessions: (event.data as { sessions: StateSnapshot["sessions"] }).sessions } } : m,
        );
        break;
    }
  };

  /** Forgets the items of a timeline (another agent instance). */
  const resetTimeline = (key: string) => {
    generation.set(key, (generation.get(key) ?? 0) + 1);
    buffered.delete(key);
    reloadAfter.delete(key);
    set((s) => ({ timelines: { ...s.timelines, [key]: { ...emptyTimeline } } }));
  };

  /** Drops the least recently opened timelines beyond `MAX_TIMELINES`. */
  const evict = () => {
    if (recent.length <= MAX_TIMELINES) return;
    const dropped = recent.splice(0, recent.length - MAX_TIMELINES);
    for (const key of dropped) {
      buffered.delete(key);
      reloadAfter.delete(key);
      generation.set(key, (generation.get(key) ?? 0) + 1);
    }
    set((s) => {
      const timelines = { ...s.timelines };
      for (const key of dropped) delete timelines[key];
      return { timelines };
    });
  };

  return {
    machines: {},
    history: {},
    timelines: {},
    expected: {},
    ready: false,

    async refresh() {
      const views = await app.listMachines();
      const machines: Record<string, MachineView> = {};
      for (const v of views) machines[v.record.machine_id] = v;
      set({ machines, ready: true });
      for (const v of views) if (!get().history[v.record.machine_id]) void get().loadHistory(v.record.machine_id);
    },

    async init() {
      const unlisten = await Promise.all([
        listen<{ machine_id: string; status: MachineStatus }>("machine-status", (e) => {
          const { machine_id, status } = e.payload;
          if (!get().machines[machine_id]) {
            void get().refresh();
            return;
          }
          const wasOffline = get().machines[machine_id].status.state !== "online";
          setMachine(machine_id, (m) => ({ ...m, status }));
          if (wasOffline && status.state === "online") void get().loadHistory(machine_id);
        }),
        listen<{ machine_id: string; snapshot: StateSnapshot }>("machine-snapshot", (e) => {
          const { machine_id, snapshot } = e.payload;
          if (!get().machines[machine_id]) {
            void get().refresh();
            return;
          }
          setMachine(machine_id, (m) => ({ ...m, snapshot }));
          useProjects.getState().reloadMachine(machine_id);
          void useLimits.getState().load(machine_id);
          // Events may have been missed: reload the open live timelines of this machine.
          for (const [key, tl] of Object.entries(get().timelines)) {
            const k = parseKey(key);
            if (!k?.live || k.machineId !== machine_id || !(tl.loaded || tl.loading)) continue;
            const agent = snapshot.agents.find((a) => a.id === k.id);
            if (agent && tl.instance && tl.instance !== agent.instance_id) resetTimeline(key);
            void get().loadTimeline(key);
          }
        }),
        listen<{ machine_id: string; event: Envelope }>("machine-event", (e) => onEvent(e.payload.machine_id, e.payload.event)),
        listen("machines-changed", () => {
          // Reconnected machines start with every item streamed: send the filter again.
          sentItems.clear();
          void get().refresh();
        }),
      ]);
      // Only the items of the timelines in memory are streamed. The filter
      // is sent as soon as a timeline starts loading, before its first page
      // is fetched; an item that still slips between the two is caught by
      // the gap check (`item_count` of `agent.updated`).
      const syncItems = () => {
        const s = get();
        for (const [machineId, ids] of Object.entries(streamedAgents(Object.keys(s.machines), Object.keys(s.timelines)))) {
          const sig = ids.join(",");
          if (sentItems.get(machineId) === sig) continue;
          sentItems.set(machineId, sig);
          void app.setStreamItems(machineId, ids).catch(() => sentItems.delete(machineId));
        }
      };
      const unsubscribe = useMachines.subscribe((s, prev) => {
        if (s.timelines !== prev.timelines || s.machines !== prev.machines) syncItems();
      });
      await get().refresh();
      return () => {
        unsubscribe();
        unlisten.forEach((u) => u());
      };
    },

    async loadHistory(machineId) {
      const m = get().machines[machineId];
      if (!m?.record.permissions.includes("history.read") && !m?.record.local) return;
      try {
        const page = await api.history(machineId, { limit: 40 });
        set((s) => ({ history: { ...s.history, [machineId]: page.entries } }));
      } catch {
        // Older daemon without history: nothing to show.
      }
    },

    async loadTimeline(key, older = false) {
      const k = parseKey(key);
      if (!k) return;
      if (!recent.includes(key)) touchTimeline(key);
      const current = get().timelines[key] ?? emptyTimeline;
      if (current.loading) {
        // Newer state wanted (resync): reload once this load is done.
        if (!older) reloadAfter.add(key);
        return;
      }
      const before = older ? current.items[0]?.n : undefined;
      if (older && (!current.hasMore || before === undefined)) return;
      const gen = generation.get(key) ?? 0;
      set((s) => ({ timelines: { ...s.timelines, [key]: { ...current, loading: true, error: null } } }));
      evict();
      try {
        const page: TimelinePage = k.live
          ? await api.timeline(k.machineId, k.id, before)
          : await api.historyTimeline(k.machineId, k.id, before);
        if ((generation.get(key) ?? 0) !== gen) return;
        const instance = k.live ? get().agent(k.machineId, k.id)?.instance_id : undefined;
        const live = buffered.get(key) ?? [];
        buffered.delete(key);
        set((s) => {
          const base = s.timelines[key] ?? emptyTimeline;
          const kept = base.instance === instance ? base.items : [];
          let items = older ? mergeItems(page.items, base.items) : mergeItems(kept, page.items);
          items = mergeItems(items, live);
          // Older pages already loaded keep their own "has more".
          const keptOlder = kept.length > 0 && kept[0].n < (page.items[0]?.n ?? Infinity);
          const hasMore = older ? page.has_more : keptOlder ? base.hasMore : page.has_more;
          const olderInHistory = older || !keptOlder ? !!page.older_in_history : base.olderInHistory;
          return { timelines: { ...s.timelines, [key]: { items, hasMore, olderInHistory, loading: false, loaded: true, error: null, instance } } };
        });
        // Items emitted before the stream filter took effect: fetch them once.
        const count = k.live ? get().agent(k.machineId, k.id)?.item_count : undefined;
        const tl = get().timelines[key];
        if (count !== undefined && tl && lastN(tl) < count - 1 && !gapRetried.has(key)) {
          gapRetried.add(key);
          reloadAfter.add(key);
        } else {
          gapRetried.delete(key);
        }
      } catch (e) {
        if ((generation.get(key) ?? 0) !== gen) return;
        const live = buffered.get(key) ?? [];
        buffered.delete(key);
        const message = typeof e === "object" && e && "message" in e ? String((e as { message: string }).message) : String(e);
        set((s) => {
          const base = s.timelines[key] ?? emptyTimeline;
          // Items already shown stay, with the live ones received meanwhile.
          const items = base.loaded ? mergeItems(base.items, live) : base.items;
          return { timelines: { ...s.timelines, [key]: { ...base, items, loading: false, loaded: true, error: message } } };
        });
      }
      if (reloadAfter.delete(key)) void get().loadTimeline(key);
    },

    expect(key) {
      set((s) => ({ expected: { ...s.expected, [key]: Date.now() + START_TIMEOUT_MS } }));
    },

    agent(machineId, agentId) {
      return get().machines[machineId]?.snapshot?.agents.find((a) => a.id === agentId);
    },
  };
});

export function machineList(machines: Record<string, MachineView>): MachineView[] {
  return Object.values(machines).sort(
    (a, b) => Number(b.record.local) - Number(a.record.local) || a.record.name.localeCompare(b.record.name),
  );
}

export function can(machine: MachineView | undefined, permission: string): boolean {
  return !!machine?.record.permissions.includes(permission);
}
