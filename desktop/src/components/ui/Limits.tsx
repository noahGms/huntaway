import * as Tooltip from "@radix-ui/react-tooltip";
import { useEffect, useState, type ReactNode } from "react";
import type { MachineLimits, ProviderLimits } from "../../api/types";
import { compactAge } from "../../lib/conversations";
import { limitTone, liveWindows, peakWindow, percentLabel, resetLabel, toneBar, toneText } from "../../lib/limits";
import { useLimits } from "../../store/limits";
import { AgentIcon, agentLabel } from "./Status";

/** Re-renders every minute: resets and countdowns move on their own. */
function useMinute() {
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((n) => n + 1), 60_000);
    return () => clearInterval(timer);
  }, []);
}

/** Providers with something to show. */
const shown = (limits: MachineLimits | undefined) => (limits?.providers ?? []).filter((p) => p.windows.length > 0 || p.error);

function Bar({ percent, className = "w-10" }: { percent: number; className?: string }) {
  return (
    <span className={`relative h-1.5 shrink-0 overflow-hidden rounded-full bg-surface-high ${className}`}>
      <span className={`absolute inset-y-0 left-0 rounded-full ${toneBar[limitTone(percent)]}`} style={{ width: `${Math.min(100, Math.max(2, percent))}%` }} />
    </span>
  );
}

/** Detail of every window, per provider. */
export function LimitsDetails({ limits, title }: { limits: MachineLimits | undefined; title?: ReactNode }) {
  const providers = shown(limits);
  return (
    <div className="w-[270px] space-y-3">
      {title && <div className="text-[12px] font-medium text-text">{title}</div>}
      {providers.length === 0 && <div className="text-[12px] text-muted">No plan limits known on this machine.</div>}
      {providers.map((p) => (
        <ProviderDetails key={p.kind} p={p} />
      ))}
    </div>
  );
}

export function ProviderDetails({ p }: { p: ProviderLimits }) {
  const updated = p.updated_at ? compactAge(new Date(p.updated_at * 1000).toISOString()) : null;
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1.5 text-[12px]">
        <AgentIcon kind={p.kind} size={12} />
        <span className="font-medium text-text">{agentLabel(p.kind)}</span>
        {p.plan && <span className="text-faint">· {p.plan}</span>}
        {updated && <span className="ml-auto text-[11px] text-faint">{p.source === "session" ? `last used ${updated} ago` : `${updated} ago`}</span>}
      </div>
      {liveWindows(p).map((w) => (
        <div key={w.id} className="flex items-center gap-2 text-[11.5px]">
          <span className="w-[86px] shrink-0 truncate text-muted">{w.label}</span>
          <Bar percent={w.used_percent} className="flex-1" />
          <span className={`w-9 shrink-0 text-right tabular-nums ${toneText[limitTone(w.used_percent)]}`}>{percentLabel(w.used_percent)}</span>
          <span className="w-[104px] shrink-0 truncate text-right text-faint">{resetLabel(w.resets_at) ?? ""}</span>
        </div>
      ))}
      {p.error && <div className="text-[11px] text-blocked">{p.error}</div>}
    </div>
  );
}

/** Hover card with the details. */
export function LimitsTooltip({ limits, title, children }: { limits: MachineLimits | undefined; title?: ReactNode; children: ReactNode }) {
  return (
    <Tooltip.Provider delayDuration={150}>
      <Tooltip.Root>
        <Tooltip.Trigger asChild>{children}</Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Content side="right" align="start" sideOffset={8} className="z-50 rounded-xl border border-border bg-surface p-3 shadow-[0_16px_40px_rgba(0,0,0,0.45)] animate-fade-in">
            <LimitsDetails limits={limits} title={title} />
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>
    </Tooltip.Provider>
  );
}

/** Peak use per provider (`✦ 49%  ⬡ 0%`), details on hover. `bars` adds a
 * gauge next to each percentage. */
export function LimitsGauge({ machineId, title, bars = false }: { machineId: string; title?: ReactNode; bars?: boolean }) {
  useMinute();
  const limits = useLimits((s) => s.byMachine[machineId]);
  const providers = shown(limits);
  if (providers.length === 0) return null;
  return (
    <LimitsTooltip limits={limits} title={title}>
      <span className="flex shrink-0 cursor-default items-center gap-2" aria-label="Plan limits">
        {providers.map((p) => {
          const peak = peakWindow(p);
          return (
            <span key={p.kind} className="flex items-center gap-1">
              <AgentIcon kind={p.kind} size={11} />
              {peak ? (
                <>
                  {bars && <Bar percent={peak.used_percent} />}
                  <span className={`text-[11px] tabular-nums ${toneText[limitTone(peak.used_percent)]}`}>{percentLabel(peak.used_percent)}</span>
                </>
              ) : (
                <span className="text-[11px] text-faint">—</span>
              )}
            </span>
          );
        })}
      </span>
    </LimitsTooltip>
  );
}

/** Worst use over several machines, each one's details on hover. */
export function MachinesLimitsGauge({ machines }: { machines: { id: string; name: string }[] }) {
  useMinute();
  const byMachine = useLimits((s) => s.byMachine);
  const known = machines.filter((m) => shown(byMachine[m.id]).length > 0);
  if (known.length === 0) return null;
  if (known.length === 1) return <LimitsGauge machineId={known[0].id} title={known[0].name} />;
  // Peak per provider kind over the machines.
  const peaks = new Map<string, number>();
  for (const m of known)
    for (const p of shown(byMachine[m.id])) {
      const w = peakWindow(p);
      if (w) peaks.set(p.kind, Math.max(peaks.get(p.kind) ?? 0, w.used_percent));
    }
  return (
    <Tooltip.Provider delayDuration={150}>
      <Tooltip.Root>
        <Tooltip.Trigger asChild>
          <span className="flex shrink-0 cursor-default items-center gap-2" aria-label="Plan limits">
            {[...peaks].map(([kind, percent]) => (
              <span key={kind} className="flex items-center gap-1">
                <AgentIcon kind={kind} size={11} />
                <span className={`text-[11px] tabular-nums ${toneText[limitTone(percent)]}`}>{percentLabel(percent)}</span>
              </span>
            ))}
          </span>
        </Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Content side="right" align="start" sideOffset={8} className="z-50 max-h-[70vh] space-y-4 overflow-y-auto rounded-xl border border-border bg-surface p-3 shadow-[0_16px_40px_rgba(0,0,0,0.45)] animate-fade-in">
            {known.map((m) => (
              <LimitsDetails key={m.id} limits={byMachine[m.id]} title={m.name} />
            ))}
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>
    </Tooltip.Provider>
  );
}
