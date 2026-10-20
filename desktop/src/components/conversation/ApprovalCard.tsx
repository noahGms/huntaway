import { Hand, ListChecks, Maximize2, MessageCircleQuestion, Minimize2, ShieldAlert, SquareTerminal } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api, errorMessage, isApiError } from "../../api/client";
import type { AgentView, ScreenOption } from "../../api/types";
import { changeDiff } from "../../lib/diff";
import { overlayOpen } from "../../lib/platform";
import { can, useMachines } from "../../store/machines";
import { useUi } from "../../store/ui";
import { Button, Kbd, Spinner } from "../ui/Button";
import { agentLabel } from "../ui/Status";
import { DiffView } from "./DiffView";
import { CodeBlock, Markdown } from "./Markdown";

// Matches the agent's own menu labels (Claude Code can run in French).
const TYPE_SOMETHING = /type something|autre réponse|other/i;

function toolPreview(input: unknown) {
  const i = (input ?? {}) as Record<string, unknown>;
  if (typeof i.command === "string") return <CodeBlock code={i.command} lang="bash" maxHeight={180} />;
  if (Array.isArray(i.cmd)) return <CodeBlock code={(i.cmd as string[]).join(" ")} lang="bash" maxHeight={180} />;
  if (typeof i.cmd === "string") return <CodeBlock code={i.cmd} lang="bash" maxHeight={180} />;
  if (typeof i.file_path === "string" && (typeof i.new_string === "string" || typeof i.content === "string")) {
    const diff = changeDiff({
      path: i.file_path,
      old: typeof i.old_string === "string" ? i.old_string : null,
      new: (typeof i.new_string === "string" ? i.new_string : i.content) as string,
      truncated: false,
    });
    return (
      <div className="overflow-hidden rounded-[10px] border border-border">
        <div className="border-b border-border bg-surface px-3 py-1.5 font-mono text-[11.5px] text-muted">{i.file_path}</div>
        <DiffView diff={diff} maxHeight={220} />
      </div>
    );
  }
  if (typeof input === "string" && input.length) return <CodeBlock code={input.slice(0, 4000)} maxHeight={180} />;
  const json = JSON.stringify(input, null, 2);
  if (!json || json === "{}" || json === "null") return null;
  return <CodeBlock code={json.slice(0, 4000)} lang="json" maxHeight={180} />;
}

/** Before "Couldn't read the menu". */
const MENU_WAIT_MS = 5_000;

/** `Run npm test?`, `Edit session.ts?`, `Allow WebFetch?`. */
function approvalTitle(name: string | undefined, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  const path = typeof i.file_path === "string" ? i.file_path.split("/").pop() : null;
  if (typeof i.command === "string" || Array.isArray(i.cmd) || typeof i.cmd === "string") return "Run this command?";
  if (path && (name === "Write" || typeof i.content === "string")) return `Create ${path}?`;
  if (path) return `Edit ${path}?`;
  return name ? `Allow ${name}?` : "Approval needed";
}

/**
 * Card for the prompt the agent shows; mount it with `key={interaction.id}`.
 * `embedded`: inside another card (an agent started by this one), without
 * its own frame and keyboard shortcuts.
 */
export function ApprovalCard({ machineId, agent, embedded = false }: { machineId: string; agent: AgentView; embedded?: boolean }) {
  const interaction = agent.interaction!;
  const machine = useMachines((s) => s.machines[machineId]);
  const toast = useUi((s) => s.toast);
  const setPanelTab = useUi((s) => s.setPanelTab);
  const [busy, setBusy] = useState<number | "deny" | null>(null);
  const [denyText, setDenyText] = useState("");
  const [showDeny, setShowDeny] = useState(false);
  const [freeText, setFreeText] = useState("");
  const [expanded, setExpanded] = useState(false);
  const allowed = can(machine, "agents.approve");
  const options = interaction.options;
  const typeOption = options.find((o) => TYPE_SOMETHING.test(o.label));

  // Answered: the card stays disabled until the agent moves on (a new card
  // replaces this one), so a second click can't answer the next prompt.
  useEffect(() => {
    if (busy === null) return;
    const timer = setTimeout(() => setBusy(null), 8_000);
    return () => clearTimeout(timer);
  }, [busy]);

  const run = async (what: number | "deny", fn: () => Promise<unknown>) => {
    setBusy(what);
    try {
      await fn();
      setShowDeny(false);
    } catch (e) {
      setBusy(null);
      if (isApiError(e) && e.code === "already_resolved") toast("Already answered (from another device or the terminal)");
      else if (isApiError(e) && e.code === "interaction_changed") toast("The agent is now asking something else");
      else toast(errorMessage(e), "error");
    }
  };
  const choose = (o: ScreenOption, text?: string) => run(o.number, () => api.choose(machineId, agent.id, interaction.id, o.number, text));
  const deny = () => run("deny", () => api.deny(machineId, agent.id, interaction.id, denyText.trim() || undefined));

  // 1–9 pick an option, Esc opens the deny form (when no text field has focus
  // and no menu or dialog takes the keys).
  useEffect(() => {
    if (!allowed || embedded) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || overlayOpen()) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
      if (e.metaKey || e.ctrlKey || e.altKey || busy !== null) return;
      const n = Number(e.key);
      if (n >= 1 && n <= 9) {
        const o = options.find((x) => x.number === n);
        if (o) {
          e.preventDefault();
          void choose(o);
        }
      } else if (e.key === "Escape" && interaction.reason === "approval" && !showDeny) {
        e.preventDefault();
        setShowDeny(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // Also when the prompt wasn't matched to the call (reason `prompt`): the
  // plan is what the menu is about.
  const plan =
    interaction.reason === "plan" || interaction.tool?.name === "ExitPlanMode"
      ? ((interaction.tool?.input as { plan?: string } | null)?.plan?.trim() || null)
      : null;

  // Says what is asked, not just that something is.
  const header = useMemo(() => {
    if (plan) return { icon: <ListChecks size={16} />, title: "Plan to review" };
    const tool = interaction.tool;
    switch (interaction.reason) {
      case "approval":
        return { icon: <ShieldAlert size={16} />, title: approvalTitle(tool?.name, tool?.input) };
      case "question":
        return { icon: <MessageCircleQuestion size={16} />, title: interaction.questions.length > 1 ? `${interaction.questions.length} questions for you` : "Question for you" };
      case "plan":
        return { icon: <ListChecks size={16} />, title: "Plan to review" };
      default:
        return { icon: <Hand size={16} />, title: `${agentLabel(agent.kind)} shows a menu` };
    }
  }, [interaction.reason, interaction.tool, interaction.questions.length, plan, agent.kind]);

  // The menu is read from the screen: give it a moment before saying it couldn't be.
  const [unreadable, setUnreadable] = useState(false);
  useEffect(() => {
    if (options.length) return;
    const timer = setTimeout(() => setUnreadable(true), MENU_WAIT_MS);
    return () => clearTimeout(timer);
  }, [options.length]);

  return (
    <div
      className={
        embedded
          ? "overflow-hidden bg-surface"
          : "overflow-hidden rounded-[18px] border border-blocked/35 bg-surface shadow-[0_10px_30px_rgba(0,0,0,0.28)] animate-fade-in"
      }
    >
      <div className="flex items-center gap-2 px-4 pb-1 pt-3 text-blocked">
        {header.icon}
        <span className="text-[13.5px] font-medium">{header.title}</span>
        {interaction.tool && interaction.reason === "approval" && (
          <span className="ml-1 truncate font-mono text-[12px] text-muted">
            {interaction.tool.name}
            {interaction.tool.summary && ` · ${interaction.tool.summary}`}
          </span>
        )}
        {plan && (
          <button
            onClick={() => setExpanded(!expanded)}
            className="ml-auto flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[12px] text-muted hover:bg-surface-high hover:text-text"
          >
            {expanded ? <Minimize2 size={12} /> : <Maximize2 size={12} />}
            {expanded ? "Less" : "Full plan"}
          </button>
        )}
      </div>
      <div className={`${expanded ? "max-h-[72vh]" : plan ? "max-h-[50vh]" : "max-h-[38vh]"} space-y-3 overflow-y-auto px-4 py-2.5`}>
        {interaction.reason === "approval" && interaction.tool && toolPreview(interaction.tool.input)}
        {interaction.questions.map((q, i) => (
          <div key={i}>
            {q.header && <div className="mb-0.5 text-[11px] uppercase tracking-wider text-faint">{q.header}</div>}
            <div className="selectable text-[14px]">{q.question}</div>
            {options.length === 0 && (
              <ul className="mt-1.5 space-y-1 text-[12.5px] text-muted">
                {q.options.map((o) => (
                  <li key={o.label}>
                    • {o.label}
                    {o.description && <span className="text-faint"> — {o.description}</span>}
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))}
        {plan && (
          <div className="rounded-xl border border-border bg-bg px-4 py-3">
            <Markdown text={plan} />
          </div>
        )}
        {options.length === 0 && (interaction.reason === "prompt" || unreadable) && (
          <p className="text-[13px] text-muted">Couldn't read the menu. Answer from the terminal.</p>
        )}
      </div>

      {/* The agent's choices, one per line as in its menu: 1–9 pick, Esc denies. */}
      <div className="space-y-0.5 px-2 pb-1 pt-1">
        {!allowed && <p className="px-2 py-1.5 text-[12.5px] text-muted">This device isn't allowed to answer.</p>}
        {allowed &&
          options
            .filter((o) => o !== typeOption)
            .map((o, i) => (
              <button
                key={o.number}
                disabled={busy !== null}
                onClick={() => void choose(o)}
                className={`group flex w-full items-center gap-3 rounded-xl px-2.5 py-2 text-left transition-colors disabled:opacity-50 ${i === 0 ? "bg-accent text-on-accent hover:bg-[#fff3e2]" : "hover:bg-surface-high"}`}
              >
                <span
                  className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-md font-mono text-[11px] ${i === 0 ? "bg-on-accent/10" : "border border-border text-faint group-hover:text-muted"}`}
                >
                  {busy === o.number ? <Spinner className="h-3 w-3" /> : o.number}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13.5px]">{o.label}</span>
                  {o.detail && <span className={`block truncate text-[12px] ${i === 0 ? "opacity-70" : "text-faint"}`}>{o.detail}</span>}
                </span>
              </button>
            ))}
        {allowed && options.length === 0 && interaction.reason !== "prompt" && !unreadable && (
          <p className="flex items-center gap-2 px-2 py-1.5 text-[12.5px] text-muted">
            <Spinner className="h-3 w-3" /> Reading the menu…
          </p>
        )}
      </div>
      <div className="flex items-center gap-2 px-4 pb-3 pt-1">
        <Button size="sm" variant="ghost" icon={<SquareTerminal size={13} />} onClick={() => setPanelTab("terminal", "agent")}>
          Terminal
        </Button>
        <div className="flex-1" />
        {allowed && interaction.reason === "approval" && !showDeny && (
          <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => setShowDeny(true)}>
            Deny… {!embedded && <Kbd>Esc</Kbd>}
          </Button>
        )}
      </div>

      {allowed && typeOption && (
        <form
          className="flex gap-2 border-t border-border px-4 py-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (freeText.trim()) void choose(typeOption, freeText.trim());
          }}
        >
          <input
            value={freeText}
            onChange={(e) => setFreeText(e.target.value)}
            placeholder="Other answer…"
            className="flex-1 rounded-[10px] border border-border bg-bg px-3 py-1.5 text-[13px] placeholder:text-faint focus:outline-none"
          />
          <Button size="sm" type="submit" disabled={!freeText.trim() || busy !== null} loading={busy === typeOption.number}>
            Reply
          </Button>
        </form>
      )}

      {showDeny && (
        <form
          className="flex gap-2 border-t border-border px-4 py-3"
          onSubmit={(e) => {
            e.preventDefault();
            void deny();
          }}
        >
          <input
            autoFocus
            value={denyText}
            onChange={(e) => setDenyText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== "Escape") return;
              e.preventDefault();
              setShowDeny(false);
            }}
            placeholder="Why? What should it do instead? (optional)"
            className="flex-1 rounded-[10px] border border-border bg-bg px-3 py-1.5 text-[13px] placeholder:text-faint focus:outline-none"
          />
          <Button size="sm" variant="danger" type="submit" loading={busy === "deny"} disabled={busy !== null}>
            Deny
          </Button>
        </form>
      )}
    </div>
  );
}
