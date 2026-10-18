import { Search } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Virtuoso } from "react-virtuoso";
import { api } from "../api/client";
import type { HistoryEntry } from "../api/types";
import { Spinner } from "../components/ui/Button";
import { inputClass } from "../components/ui/Dialog";
import { AgentIcon, StatusDot } from "../components/ui/Status";
import { compactAge, historyKey, liveKey, longDate } from "../lib/conversations";
import { humanizeSlug, parseTime } from "../lib/format";
import { can, machineList, useMachines } from "../store/machines";
import { useUi } from "../store/ui";
import { PageHeader } from "./ServersPage";

interface Row {
  machineId: string;
  machineName: string;
  entry: HistoryEntry;
}

/** Past conversations of every machine, merged by date. */
export function HistoryPage() {
  const machines = machineList(useMachines((s) => s.machines)).filter((m) => m.status.state === "online" && (can(m, "history.read") || m.record.local));
  const select = useUi((s) => s.select);
  const [q, setQ] = useState("");
  const [machineId, setMachineId] = useState<string>("");
  const [kind, setKind] = useState<string>("");
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(false);
  const cursors = useRef<Record<string, { before?: number; done: boolean }>>({});
  const generation = useRef(0);
  const busy = useRef(0);
  // Read through a ref: a machine going online or offline must not reset the list.
  const machinesRef = useRef(machines);
  machinesRef.current = machines;
  const machineKey = machines.map((m) => m.record.machine_id).join(",");

  /** Next page of each machine (`only`: just these machines, e.g. one that came online). */
  const loadMore = useCallback(
    async (reset: boolean, only?: string[]) => {
      const gen = reset ? ++generation.current : generation.current;
      if (reset) {
        cursors.current = {};
        setRows([]);
      }
      const targets = machinesRef.current.filter((m) => (!machineId || m.record.machine_id === machineId) && (!only || only.includes(m.record.machine_id)));
      busy.current++;
      setLoading(true);
      const pages = await Promise.all(
        targets.map(async (m) => {
          const c = cursors.current[m.record.machine_id] ?? { done: false };
          if (c.done) return [];
          try {
            const page = await api.history(m.record.machine_id, { before: c.before, limit: 40, q: q || undefined, kind: kind || undefined });
            const last = page.entries[page.entries.length - 1];
            if (gen === generation.current) {
              cursors.current[m.record.machine_id] = {
                before: last ? last.modified_at : c.before,
                done: !page.has_more,
              };
            }
            return page.entries.map((entry) => ({ machineId: m.record.machine_id, machineName: m.record.name, entry }));
          } catch {
            // Offline or no history: try again when it comes back.
            return [];
          }
        }),
      );
      busy.current--;
      if (gen !== generation.current) return;
      setRows((prev) => {
        const seen = new Set(prev.map((r) => `${r.machineId}|${r.entry.id}`));
        const merged = [...prev, ...pages.flat().filter((r) => !seen.has(`${r.machineId}|${r.entry.id}`))];
        merged.sort((a, b) => (parseTime(b.entry.last_activity_at) ?? 0) - (parseTime(a.entry.last_activity_at) ?? 0));
        return merged;
      });
      if (!busy.current) setLoading(false);
    },
    [machineId, kind, q],
  );

  useEffect(() => {
    const t = setTimeout(() => void loadMore(true), q ? 250 : 0);
    return () => clearTimeout(t);
  }, [loadMore, q]);

  // A machine that comes online: load its first page, keep the rest.
  const known = useRef(new Set<string>());
  useEffect(() => {
    const ids = machineKey ? machineKey.split(",") : [];
    const added = ids.filter((id) => !known.current.has(id) && !cursors.current[id]);
    known.current = new Set(ids);
    if (added.length && generation.current > 0) void loadMore(false, added);
  }, [machineKey]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="flex h-full flex-col">
      <PageHeader title="History" subtitle="Past conversations of every machine" />
      <div className="flex items-center gap-2 border-b border-border px-6 py-3">
        <div className="relative min-w-0 flex-1">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-faint" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search titles, messages, folders…" className={`${inputClass} pl-8`} />
        </div>
        <select value={machineId} onChange={(e) => setMachineId(e.target.value)} className={`${inputClass} !w-[180px] shrink-0`}>
          <option value="">All machines</option>
          {machines.map((m) => (
            <option key={m.record.machine_id} value={m.record.machine_id}>
              {m.record.name}
            </option>
          ))}
        </select>
        <select value={kind} onChange={(e) => setKind(e.target.value)} className={`${inputClass} !w-[150px] shrink-0`}>
          <option value="">All agents</option>
          <option value="claude">Claude Code</option>
          <option value="codex">Codex</option>
        </select>
      </div>
      <div className="min-h-0 flex-1">
        {rows.length === 0 && !loading ? (
          <p className="p-6 text-[13px] text-muted">{machines.length === 0 ? "No online machine with history." : "No conversations found."}</p>
        ) : (
          <Virtuoso
            data={rows}
            endReached={() => !loading && void loadMore(false)}
            computeItemKey={(_, r) => `${r.machineId}|${r.entry.id}`}
            components={{ Footer: () => (loading ? <div className="flex justify-center p-4 text-muted"><Spinner /></div> : <div className="h-6" />) }}
            itemContent={(_, r) => (
              <button
                onClick={() => select(r.entry.live_agent_id ? liveKey(r.machineId, r.entry.live_agent_id) : historyKey(r.machineId, r.entry.id))}
                className="flex w-full items-center gap-3 border-b border-border px-6 py-3 text-left hover:bg-surface/70"
              >
                <AgentIcon kind={r.entry.kind} size={15} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px]">{humanizeSlug(r.entry.title)}</span>
                  <span className="mt-0.5 block truncate text-[11.5px] text-faint">
                    {r.entry.project || "—"} · {r.machineName}
                    {r.entry.model && ` · ${r.entry.model}`}
                  </span>
                </span>
                {r.entry.live_agent_id && (
                  <span className="flex items-center gap-1.5 text-[11.5px] text-done">
                    <StatusDot attention={{ status: "done" }} size={6} /> running
                  </span>
                )}
                <span className="w-[70px] shrink-0 text-right text-[11.5px] tabular-nums text-faint" title={longDate(r.entry.last_activity_at)}>{compactAge(r.entry.last_activity_at)}</span>
              </button>
            )}
          />
        )}
      </div>
    </div>
  );
}
