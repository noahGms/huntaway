import { Bot, Check, Cpu, FilePen, FileSearch, Folder, Globe, Loader2, MessageSquare, Server, SquareTerminal, Timer, X } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import type { RateWindow, Usage } from "../../api/types";
import { computeActivity } from "../../lib/activity";
import { statusLabel, type Conversation } from "../../lib/conversations";
import { clockTime, duration, fullDate, LOCALE, parseTime, tokens, usd } from "../../lib/format";
import { useMachines } from "../../store/machines";
import { useSettings } from "../../store/settings";
import { Badge, attentionTone, MachineDot } from "../ui/Status";
import { TodoIcon } from "../conversation/TimelineRows";

function Section({ title, right, children }: { title: string; right?: ReactNode; children: ReactNode }) {
  return (
    <section className="px-5 pt-5">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-[13px] font-semibold">{title}</h3>
        {right}
      </div>
      <div className="rounded-xl border border-border bg-bg/40">{children}</div>
    </section>
  );
}

function Line({ icon, label, value }: { icon: ReactNode; label: string; value: ReactNode }) {
  return (
    <div className="flex items-center gap-2.5 py-[5px] text-[12.5px]">
      <span className="text-faint">{icon}</span>
      <span className="w-[86px] shrink-0 text-muted">{label}</span>
      <span className="min-w-0 truncate text-text">{value}</span>
    </div>
  );
}

export function ActivityTab({ conv }: { conv: Conversation }) {
  const timeline = useMachines((s) => s.timelines[conv.key]);
  const machineState = useMachines((s) => s.machines[conv.machineId]?.status.state ?? "offline");
  const showCost = useSettings((s) => s.settings.show_cost);
  const [allCommands, setAllCommands] = useState(false);
  const activity = useMemo(() => computeActivity(timeline?.items ?? []), [timeline?.items]);
  const agent = conv.agent;
  const usage = agent?.usage ?? null;
  const model = agent?.model ?? conv.history?.model ?? usage?.model ?? null;
  const started = agent?.started_at ?? conv.history?.started_at ?? activity.startedAt;
  // Whole conversation when its start and last activity are known; else the loaded items.
  const last = agent?.last_activity_at ?? conv.history?.last_activity_at ?? null;
  const span = parseTime(started) !== null && parseTime(last) !== null ? parseTime(last)! - parseTime(started)! : activity.durationMs;
  // Only the latest page of a long conversation is loaded: counts are about it.
  const partial = !!timeline?.hasMore;
  const loaded = timeline?.items.length ?? 0;
  const commands = allCommands ? [...activity.commands].reverse() : activity.commands.slice(-5).reverse();
  const counts = activity.toolCounts;
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

  const tools: { icon: ReactNode; label: string; value: string; show: boolean }[] = [
    { icon: <FilePen size={14} />, label: "File edits", value: `${plural(activity.files.length, "file")} changed`, show: (counts.file_modified ?? 0) > 0 },
    { icon: <SquareTerminal size={14} />, label: "Terminal", value: plural(counts.command ?? 0, "command"), show: (counts.command ?? 0) > 0 },
    { icon: <FileSearch size={14} />, label: "Reads and searches", value: plural((counts.file_read ?? 0) + (counts.search ?? 0), "call"), show: (counts.file_read ?? 0) + (counts.search ?? 0) > 0 },
    { icon: <Globe size={14} />, label: "Web", value: plural(counts.web ?? 0, "request"), show: (counts.web ?? 0) > 0 },
    { icon: <Bot size={14} />, label: "Subagents", value: `${counts.subagent ?? 0}`, show: (counts.subagent ?? 0) > 0 },
  ];
  const partialNote = partial ? <span className="text-[11.5px] text-faint" title="Older items aren't loaded yet: scroll up in the conversation to load them.">last {loaded} events</span> : undefined;

  return (
    <div className="pb-6">
      <Section title="Session">
        <div className="border-b border-border px-3.5 py-3">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="truncate text-[13px] font-medium">{conv.title}</div>
              <div className="mt-0.5 text-[11.5px] text-faint">Started {fullDate(started)}</div>
            </div>
            <Badge tone={attentionTone(conv.attention)}>{statusLabel(conv.attention)}</Badge>
          </div>
        </div>
        <div className="px-3.5 py-2">
          <Line icon={<Timer size={14} />} label="Duration" value={duration(span)} />
          <Line
            icon={<MessageSquare size={14} />}
            label="Messages"
            value={partial ? <span title="Counted in the loaded part of the conversation">{activity.messages}+ <span className="text-faint">(last {loaded} events)</span></span> : activity.messages}
          />
          <Line icon={<Cpu size={14} />} label="Model" value={model ?? "—"} />
          <Line
            icon={<Server size={14} />}
            label="Server"
            value={
              <span className="flex items-center gap-1.5" title={machineState}>
                <MachineDot state={machineState} />
                {conv.machineName}
              </span>
            }
          />
          <Line icon={<Folder size={14} />} label="Project" value={<span title={conv.cwd ?? undefined}>{conv.project}</span>} />
        </div>
      </Section>

      {activity.todos.length > 0 && (
        <Section title="Tasks" right={<span className="text-[11.5px] text-faint">{activity.todos.filter((t) => t.status === "completed").length}/{activity.todos.length}</span>}>
          <ul className="space-y-2 px-3.5 py-3">
            {activity.todos.map((t, i) => (
              <li key={i} className="flex items-start gap-2.5 text-[12.5px]">
                <TodoIcon status={t.status} />
                <span className={t.status === "completed" ? "text-muted" : "text-text"}>
                  {t.content}
                  {t.status === "in_progress" && <span className="block text-[11px] text-faint">In progress…</span>}
                </span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {tools.some((t) => t.show) && (
        <Section title="Tools used" right={partialNote}>
          <div className="px-3.5 py-2">
            {tools
              .filter((t) => t.show)
              .map((t) => (
                <div key={t.label} className="flex items-center gap-2.5 py-[5px] text-[12.5px]">
                  <span className="text-faint">{t.icon}</span>
                  <span className="flex-1 text-text">{t.label}</span>
                  <span className="text-[11.5px] text-muted">{t.value}</span>
                </div>
              ))}
          </div>
        </Section>
      )}

      {activity.commands.length > 0 && (
        <Section
          title="Recent commands"
          right={
            activity.commands.length > 5 && (
              <button className="text-[11.5px] text-blocked hover:underline" onClick={() => setAllCommands(!allCommands)}>
                {allCommands ? "Show less" : "Show all"}
              </button>
            )
          }
        >
          <ul className="max-h-[320px] space-y-1 overflow-y-auto px-3.5 py-2.5">
            {commands.map((c) => (
              <li key={c.toolUseId} className="flex items-center gap-2.5 text-[12px]" title={c.output ?? undefined}>
                {c.ok === null ? (
                  <Loader2 size={13} className="shrink-0 animate-spin text-working" />
                ) : c.ok ? (
                  <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-[4px] bg-done">
                    <Check size={10} strokeWidth={3} className="text-ink" />
                  </span>
                ) : (
                  <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-[4px] bg-error">
                    <X size={10} strokeWidth={3} className="text-ink" />
                  </span>
                )}
                <span className="selectable min-w-0 flex-1 truncate font-mono text-[11.5px]">{c.command}</span>
                <span className="shrink-0 text-[11px] text-faint">{clockTime(c.timestamp)}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {usage && <UsageSection usage={usage} showCost={showCost} />}
    </div>
  );
}

function UsageSection({ usage, showCost }: { usage: Usage; showCost: boolean }) {
  const total = usage.input_tokens + usage.output_tokens + usage.cache_read_tokens + usage.cache_write_tokens;
  const pct = usage.context_window ? Math.min(100, Math.round((usage.context_tokens / usage.context_window) * 100)) : null;
  const limits = usage.rate_limits;
  return (
    <Section title="Usage">
      <div className="grid grid-cols-2 gap-x-4 gap-y-2 px-3.5 py-3 text-[12.5px]">
        <div className="flex justify-between">
          <span className="text-muted">Tokens</span>
          <span title={`input ${tokens(usage.input_tokens)} · output ${tokens(usage.output_tokens)} · cache read ${tokens(usage.cache_read_tokens)} · cache write ${tokens(usage.cache_write_tokens)}`}>{tokens(total)}</span>
        </div>
        {showCost && (
          <div className="flex justify-between" title="Estimate at public API prices; subscriptions are billed differently.">
            <span className="text-muted">Estimated cost</span>
            <span>{usd(usage.cost_usd)}</span>
          </div>
        )}
        <div className="flex justify-between">
          <span className="text-muted">Context</span>
          <span className={pct !== null && pct >= 80 ? "text-blocked" : "text-done"}>{pct !== null ? `${pct}%` : "—"}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted">Window</span>
          <span>{usage.context_window ? `${tokens(usage.context_window)} tokens` : "—"}</span>
        </div>
        {pct !== null && (
          <div className="col-span-2 h-1.5 overflow-hidden rounded-full bg-surface-high">
            <div className={`h-full rounded-full ${pct >= 80 ? "bg-blocked" : "bg-done"}`} style={{ width: `${Math.max(2, pct)}%` }} />
          </div>
        )}
      </div>
      {limits && (limits.primary || limits.secondary) && (
        <div className="space-y-2.5 border-t border-border px-3.5 py-3">
          <div className="text-[11.5px] text-faint">Plan limits{limits.plan_type ? ` (${limits.plan_type})` : ""}</div>
          {limits.primary && <Limit label="Short window" w={limits.primary} />}
          {limits.secondary && <Limit label="Weekly" w={limits.secondary} />}
        </div>
      )}
    </Section>
  );
}

function Limit({ label, w }: { label: string; w: RateWindow }) {
  const pct = Math.round(w.used_percent);
  const reset = w.resets_at ? new Date(w.resets_at * 1000).toLocaleString(LOCALE, { weekday: "short", hour: "2-digit", minute: "2-digit" }) : null;
  return (
    <div>
      <div className="mb-1 flex justify-between text-[12px]">
        <span className="text-muted">
          {label}
          {w.window_minutes && w.window_minutes < 1440 ? ` (${Math.round(w.window_minutes / 60)} h)` : ""}
        </span>
        <span className={pct >= 80 ? "text-blocked" : ""}>
          {pct}%{reset && <span className="text-faint"> · resets {reset}</span>}
        </span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-surface-high">
        <div className={`h-full rounded-full ${pct >= 80 ? "bg-blocked" : "bg-working"}`} style={{ width: `${Math.max(2, pct)}%` }} />
      </div>
    </div>
  );
}
