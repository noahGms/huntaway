import { Sparkles, Hexagon, TerminalSquare } from "lucide-react";
import type { Attention } from "../../api/types";
import { askedYou } from "../../lib/conversations";

/** Colored dot for an agent state; animated while working. */
export function StatusDot({ attention, size = 8 }: { attention: Attention | null; size?: number }) {
  const color = !attention
    ? "bg-faint/60"
    : askedYou(attention)
      ? "bg-done"
      : attention.status === "blocked"
      ? "bg-blocked"
      : attention.status === "working"
        ? "bg-working animate-pulse-dot"
        : attention.status === "done"
          ? "bg-done"
          : "bg-faint";
  return <span className={`inline-block shrink-0 rounded-full ${color}`} style={{ width: size, height: size }} aria-hidden />;
}

export function AgentIcon({ kind, size = 14 }: { kind: string; size?: number }) {
  if (kind === "claude") return <Sparkles size={size} className="shrink-0 text-claude" aria-label="Claude" />;
  if (kind === "codex") return <Hexagon size={size} className="shrink-0 text-codex" aria-label="Codex" />;
  return <TerminalSquare size={size} className="shrink-0 text-muted" aria-label={kind} />;
}

export function agentLabel(kind: string): string {
  if (kind === "claude") return "Claude Code";
  if (kind === "codex") return "Codex";
  return kind.charAt(0).toUpperCase() + kind.slice(1);
}

export function Badge({ children, tone = "neutral" }: { children: React.ReactNode; tone?: "neutral" | "blocked" | "working" | "done" | "error" }) {
  const tones = {
    neutral: "bg-surface-high text-muted border-border",
    blocked: "bg-blocked/15 text-blocked border-blocked/30",
    working: "bg-working/12 text-working border-working/25",
    done: "bg-done/12 text-done border-done/25",
    error: "bg-error/12 text-error border-error/25",
  } as const;
  return <span className={`inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md border px-1.5 py-[1px] text-[11px] font-medium ${tones[tone]}`}>{children}</span>;
}

export function attentionTone(attention: Attention | null): "neutral" | "blocked" | "working" | "done" {
  if (!attention) return "neutral";
  if (askedYou(attention)) return "neutral";
  if (attention.status === "blocked") return "blocked";
  if (attention.status === "working") return "working";
  if (attention.status === "done") return "done";
  return "neutral";
}

/** Machine connection state. */
export function MachineDot({ state, slow }: { state: string; slow?: boolean }) {
  const color = state === "online" ? (slow ? "bg-blocked" : "bg-done") : state === "connecting" ? "bg-working animate-pulse-dot" : "bg-error";
  return <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${color}`} aria-hidden />;
}
