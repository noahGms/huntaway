// Machines, their state and conversation timelines, kept in sync with the
// Tauri backend events (`machine-status`, `machine-snapshot`, `machine-event`).

import { listen } from "@tauri-apps/api/event";
import { create } from "zustand";
import { api, app } from "../api/client";
import type { AgentView, Envelope, HistoryEntry, MachineStatus, MachineView, StateSnapshot, StoredItem, TimelinePage } from "../api/types";
import { liveKey, parseKey } from "../lib/conversations";

export interface TimelineState {
  items: StoredItem[];
  hasMore: boolean;
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
  ready: boolean;
  init: () => Promise<() => void>;
  refresh: () => Promise<void>;
  loadHistory: (machineId: string) => Promise<void>;
  loadTimeline: (key: string, older?: boolean) => Promise<void>;
  agent: (machineId: string, agentId: string) => AgentView | undefined;
}

const emptyTimeline: TimelineState = { items: [], hasMore: false, loading: false, loaded: false, error: null };

function mergeItems(existing: StoredItem[], incoming: StoredItem[]): StoredItem[] {
  if (!existing.length) return incoming;
  const seen = new Set(existing.map((i) => i.n));
  const merged = existing.concat(incoming.filter((i) => !seen.has(i.n)));
  merged.sort((a, b) => a.n - b.n);
  return merged;
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
          // Another agent took the pane: reload its conversation.
          set((s) => ({ timelines: { ...s.timelines, [key]: { ...emptyTimeline } } }));
          void get().loadTimeline(key);
        } else if (tl?.loaded && tl.items.length === 0 && agent.item_count > 0) {
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
        if (!tl?.loaded) break;
        const item = event.data as StoredItem;
        set((s) => ({ timelines: { ...s.timelines, [key]: { ...tl, items: mergeItems(tl.items, [item]) } } }));
        break;
      }
      case "workspaces.updated":
        setMachine(machineId, (m) =>
          m.snapshot ? { ...m, snapshot: { ...m.snapshot, workspaces: (event.data as { workspaces: StateSnapshot["workspaces"] }).workspaces } } : m,
        );
        break;
      case "sessions.updated":
        setMachine(machineId, (m) =>
          m.snapshot ? { ...m, snapshot: { ...m.snapshot, sessions: (event.data as { sessions: StateSnapshot["sessions"] }).sessions } } : m,
        );
        break;
    }
  };

  return {
    machines: {},
    history: {},
    timelines: {},
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
          // Events may have been missed: reload the open live timelines of this machine.
          for (const [key, tl] of Object.entries(get().timelines)) {
            const k = parseKey(key);
            if (k?.live && k.machineId === machine_id && tl.loaded) void get().loadTimeline(key);
          }
        }),
        listen<{ machine_id: string; event: Envelope }>("machine-event", (e) => onEvent(e.payload.machine_id, e.payload.event)),
        listen("machines-changed", () => void get().refresh()),
      ]);
      await get().refresh();
      return () => unlisten.forEach((u) => u());
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
      const current = get().timelines[key] ?? emptyTimeline;
      if (current.loading) return;
      const before = older ? current.items[0]?.n : undefined;
      if (older && (!current.hasMore || before === undefined)) return;
      set((s) => ({ timelines: { ...s.timelines, [key]: { ...current, loading: true, error: null } } }));
      try {
        const page: TimelinePage = k.live
          ? await api.timeline(k.machineId, k.id, before)
          : await api.historyTimeline(k.machineId, k.id, before);
        const instance = k.live ? get().agent(k.machineId, k.id)?.instance_id : undefined;
        set((s) => {
          const base = s.timelines[key] ?? emptyTimeline;
          const kept = base.instance === instance ? base.items : [];
          const items = older ? mergeItems(page.items, base.items) : mergeItems(kept, page.items);
          // Older pages already loaded keep their own "has more".
          const keptOlder = kept.length > 0 && kept[0].n < (page.items[0]?.n ?? Infinity);
          const hasMore = older ? page.has_more : keptOlder ? base.hasMore : page.has_more;
          return { timelines: { ...s.timelines, [key]: { items, hasMore, loading: false, loaded: true, error: null, instance } } };
        });
      } catch (e) {
        const message = typeof e === "object" && e && "message" in e ? String((e as { message: string }).message) : String(e);
        set((s) => ({ timelines: { ...s.timelines, [key]: { ...(s.timelines[key] ?? emptyTimeline), loading: false, loaded: true, error: message } } }));
      }
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
