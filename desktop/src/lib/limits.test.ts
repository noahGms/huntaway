import { describe, expect, it } from "vitest";
import type { ProviderLimits } from "../api/types";
import { limitTone, liveWindows, machinePeak, peakWindow, resetLabel } from "./limits";

const now = 1_800_000_000;
const provider = (kind: string, windows: [string, number, number | null][]): ProviderLimits => ({
  kind,
  plan: null,
  windows: windows.map(([id, used_percent, resets_at]) => ({ id, label: id, used_percent, window_minutes: null, resets_at })),
  updated_at: null,
  source: "api",
  error: null,
});

describe("plan limits", () => {
  it("reads windows past their reset as 0 %", () => {
    const w = liveWindows(provider("claude", [["five_hour", 80, now - 1], ["week", 40, now + 60]]), now);
    expect(w.map((x) => [x.used_percent, x.resets_at])).toEqual([[0, null], [40, now + 60]]);
  });

  it("takes the most used window, per provider and per machine", () => {
    const claude = provider("claude", [["five_hour", 7, now + 600], ["week", 49, now + 9000]]);
    const codex = provider("codex", [["five_hour", 95, now - 5]]);
    expect(peakWindow(claude, now)?.id).toBe("week");
    expect(machinePeak({ providers: [claude, codex] }, now)).toBe(49);
    expect(machinePeak(undefined, now)).toBeNull();
  });

  it("tones and reset labels", () => {
    expect([limitTone(10), limitTone(70), limitTone(90)]).toEqual(["ok", "warn", "high"]);
    expect(resetLabel(null, now)).toBeNull();
    expect(resetLabel(now + 30, now)).toBe("resets in 1m");
    expect(resetLabel(now + 100 * 60, now)).toBe("resets in 1h 40m");
    expect(resetLabel(now + 3 * 3600, now)).toBe("resets in 3h");
    expect(resetLabel(now + 3 * 86_400, now)).toMatch(/^resets \w{3} \d\d:\d\d$/);
  });
});
