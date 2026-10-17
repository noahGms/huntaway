import { Hand, ListChecks, MessageCircleQuestion, ShieldAlert, SquareTerminal } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api, errorMessage, isApiError } from "../../api/client";
import type { AgentView, ScreenOption } from "../../api/types";
import { changeDiff } from "../../lib/diff";
import { can } from "../../store/machines";
import { useMachines } from "../../store/machines";
import { useUi } from "../../store/ui";
import { Button, Kbd } from "../ui/Button";
import { DiffView } from "./DiffView";
import { CodeBlock, Markdown } from "./Markdown";

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

export function ApprovalCard({ machineId, agent }: { machineId: string; agent: AgentView }) {
  const interaction = agent.interaction!;
  const machine = useMachines((s) => s.machines[machineId]);
  const toast = useUi((s) => s.toast);
  const setPanelTab = useUi((s) => s.setPanelTab);
  const [busy, setBusy] = useState<number | "deny" | null>(null);
  const [denyText, setDenyText] = useState("");
  const [showDeny, setShowDeny] = useState(false);
  const [freeText, setFreeText] = useState("");
  const allowed = can(machine, "agents.approve");
  const options = interaction.options;
  const typeOption = options.find((o) => TYPE_SOMETHING.test(o.label));

  const run = async (what: number | "deny", fn: () => Promise<unknown>) => {
    setBusy(what);
    try {
      await fn();
      setShowDeny(false);
      setDenyText("");
      setFreeText("");
    } catch (e) {
      if (isApiError(e) && e.code === "already_resolved") toast("Déjà répondu (depuis un autre appareil ou le terminal)");
      else toast(errorMessage(e), "error");
    } finally {
      setBusy(null);
    }
  };
  const choose = (o: ScreenOption, text?: string) => run(o.number, () => api.choose(machineId, agent.id, o.number, text));
  const deny = () => run("deny", () => api.deny(machineId, agent.id, denyText.trim() || undefined));

  // 1–9 pick an option, Esc refuses (when no text field has focus).
  useEffect(() => {
    if (!allowed) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (e.metaKey || e.ctrlKey || e.altKey || busy !== null) return;
      const n = Number(e.key);
      if (n >= 1 && n <= 9) {
        const o = options.find((x) => x.number === n);
        if (o) {
          e.preventDefault();
          void choose(o);
        }
      } else if (e.key === "Escape" && interaction.reason === "approval") {
        e.preventDefault();
        void deny();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const header = useMemo(() => {
    switch (interaction.reason) {
      case "approval":
        return { icon: <ShieldAlert size={16} />, title: "Approbation requise" };
      case "question":
        return { icon: <MessageCircleQuestion size={16} />, title: "L'agent te pose une question" };
      case "plan":
        return { icon: <ListChecks size={16} />, title: "Plan à valider" };
      default:
        return { icon: <Hand size={16} />, title: "L'agent attend une réponse" };
    }
  }, [interaction.reason]);

  const plan = interaction.reason === "plan" ? ((interaction.tool?.input as { plan?: string } | null)?.plan ?? null) : null;

  return (
    <div className="mx-6 mb-3 overflow-hidden rounded-2xl border border-blocked/45 bg-[#1d1a16] shadow-[0_0_0_4px_rgba(227,155,75,0.06)] animate-fade-in">
      <div className="flex items-center gap-2 border-b border-blocked/20 px-4 py-2.5 text-blocked">
        {header.icon}
        <span className="text-[13px] font-semibold">{header.title}</span>
        {interaction.tool && interaction.reason === "approval" && (
          <span className="ml-1 truncate font-mono text-[12px] text-[#d9b48a]">
            {interaction.tool.name}
            {interaction.tool.summary && ` · ${interaction.tool.summary}`}
          </span>
        )}
      </div>
      <div className="max-h-[38vh] space-y-3 overflow-y-auto px-4 py-3">
        {interaction.reason === "approval" && interaction.tool && toolPreview(interaction.tool.input)}
        {interaction.questions.map((q, i) => (
          <div key={i}>
            {q.header && <div className="mb-0.5 text-[11px] uppercase tracking-wider text-faint">{q.header}</div>}
            <div className="selectable text-[13.5px]">{q.question}</div>
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
          <div className="rounded-xl border border-border bg-surface px-3.5 py-3">
            <Markdown text={plan} />
          </div>
        )}
        {interaction.reason === "prompt" && options.length === 0 && (
          <p className="text-[12.5px] text-muted">Le menu n'a pas pu être lu. Réponds depuis le terminal.</p>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2 border-t border-blocked/20 px-4 py-3">
        {!allowed && <span className="text-[12px] text-muted">Cet appareil n'a pas la permission de répondre.</span>}
        {allowed &&
          options
            .filter((o) => o !== typeOption)
            .map((o, i) => (
              <Button
                key={o.number}
                size="sm"
                variant={i === 0 ? "primary" : "secondary"}
                loading={busy === o.number}
                disabled={busy !== null}
                onClick={() => void choose(o)}
                title={o.detail ?? undefined}
              >
                <Kbd>{o.number}</Kbd>
                <span className="max-w-[320px] truncate">{o.label}</span>
              </Button>
            ))}
        {allowed && options.length === 0 && interaction.reason !== "prompt" && <span className="text-[12px] text-muted">Lecture du menu…</span>}
        <div className="flex-1" />
        <Button size="sm" variant="ghost" icon={<SquareTerminal size={13} />} onClick={() => setPanelTab("terminal")}>
          Terminal
        </Button>
        {allowed && interaction.reason === "approval" && !showDeny && (
          <Button size="sm" variant="danger" disabled={busy !== null} onClick={() => setShowDeny(true)}>
            Refuser… <Kbd>Esc</Kbd>
          </Button>
        )}
      </div>

      {allowed && typeOption && (
        <form
          className="flex gap-2 border-t border-blocked/20 px-4 py-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (freeText.trim()) void choose(typeOption, freeText.trim());
          }}
        >
          <input
            value={freeText}
            onChange={(e) => setFreeText(e.target.value)}
            placeholder="Autre réponse…"
            className="flex-1 rounded-[10px] border border-border bg-bg px-3 py-1.5 text-[13px] placeholder:text-faint focus:outline-none"
          />
          <Button size="sm" type="submit" disabled={!freeText.trim() || busy !== null} loading={busy === typeOption.number}>
            Répondre
          </Button>
        </form>
      )}

      {showDeny && (
        <form
          className="flex gap-2 border-t border-blocked/20 px-4 py-3"
          onSubmit={(e) => {
            e.preventDefault();
            void deny();
          }}
        >
          <input
            autoFocus
            value={denyText}
            onChange={(e) => setDenyText(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && setShowDeny(false)}
            placeholder="Pourquoi ? Que doit-il faire à la place ? (facultatif)"
            className="flex-1 rounded-[10px] border border-border bg-bg px-3 py-1.5 text-[13px] placeholder:text-faint focus:outline-none"
          />
          <Button size="sm" variant="danger" type="submit" loading={busy === "deny"}>
            Refuser
          </Button>
        </form>
      )}
    </div>
  );
}
