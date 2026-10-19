// Plan limits of the agents on a machine (`GET /v1/limits`): what to show
// once time passed (a window past its reset is back to 0 %) and how.

import type { LimitWindow, MachineLimits, ProviderLimits } from "../api/types";

export type LimitTone = "ok" | "warn" | "high";

const nowSecs = () => Date.now() / 1000;

/** Windows as they are now: past their reset, back to 0 %. */
export function liveWindows(p: ProviderLimits, now = nowSecs()): LimitWindow[] {
  return p.windows.map((w) => (w.resets_at !== null && w.resets_at <= now ? { ...w, used_percent: 0, resets_at: null } : w));
}

/** The most used window of a provider. */
export function peakWindow(p: ProviderLimits, now = nowSecs()): LimitWindow | null {
  let peak: LimitWindow | null = null;
  for (const w of liveWindows(p, now)) if (!peak || w.used_percent > peak.used_percent) peak = w;
  return peak;
}

/** Highest use over every provider of a machine (null: nothing known). */
export function machinePeak(limits: MachineLimits | undefined, now = nowSecs()): number | null {
  let peak: number | null = null;
  for (const p of limits?.providers ?? []) {
    const w = peakWindow(p, now);
    if (w && (peak === null || w.used_percent > peak)) peak = w.used_percent;
  }
  return peak;
}

export const limitTone = (percent: number): LimitTone => (percent >= 90 ? "high" : percent >= 70 ? "warn" : "ok");

export const toneText: Record<LimitTone, string> = { ok: "text-muted", warn: "text-blocked", high: "text-error" };
export const toneBar: Record<LimitTone, string> = { ok: "bg-muted", warn: "bg-blocked", high: "bg-error" };

export const percentLabel = (percent: number) => `${Math.round(percent)}%`;

/** `resets in 1h 40m`, or the day and time beyond a day. */
export function resetLabel(resetsAt: number | null, now = nowSecs()): string | null {
  if (resetsAt === null) return null;
  const secs = Math.max(0, Math.round(resetsAt - now));
  if (secs < 3600) return `resets in ${Math.max(1, Math.round(secs / 60))}m`;
  if (secs < 86_400) {
    const h = Math.floor(secs / 3600);
    const m = Math.round((secs % 3600) / 60);
    return `resets in ${h}h${m ? ` ${m}m` : ""}`;
  }
  const d = new Date(resetsAt * 1000);
  const day = d.toLocaleDateString("en-US", { weekday: "short" });
  const time = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  return `resets ${day} ${time}`;
}
