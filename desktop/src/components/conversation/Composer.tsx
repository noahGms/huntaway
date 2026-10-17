import { getCurrentWebview } from "@tauri-apps/api/webview";
import { ArrowUp, AtSign, FileText, Image as ImageIcon, Paperclip, Slash, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { api, app, errorMessage } from "../../api/client";
import type { AgentView, FileMatch } from "../../api/types";
import { basename } from "../../lib/format";
import { can, useMachines } from "../../store/machines";
import { useSettings } from "../../store/settings";
import { useUi } from "../../store/ui";
import { Spinner } from "../ui/Button";
import { AgentIcon } from "../ui/Status";

interface Attachment {
  name: string;
  /** Path on the machine, once uploaded. */
  path: string | null;
  image: boolean;
}

const QUICK_REPLIES = ["Continue", "Lance les tests", "Explique ce que tu viens de faire", "Fais un commit"];

const SLASH: Record<string, [string, string][]> = {
  claude: [
    ["/compact", "Résumer le contexte"],
    ["/clear", "Nouvelle conversation"],
    ["/cost", "Coût de la session"],
    ["/model", "Changer de modèle"],
    ["/review", "Relire les changements"],
    ["/init", "Créer CLAUDE.md"],
  ],
  codex: [
    ["/compact", "Résumer le contexte"],
    ["/new", "Nouvelle conversation"],
    ["/model", "Changer de modèle"],
    ["/review", "Relire les changements"],
    ["/diff", "Voir le diff"],
    ["/status", "État de la session"],
  ],
};

function readAsBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

const isImage = (name: string) => /\.(png|jpe?g|gif|webp|heic|bmp)$/i.test(name);

export function Composer({ machineId, agent }: { machineId: string; agent: AgentView }) {
  const machine = useMachines((s) => s.machines[machineId]);
  const enterToSend = useSettings((s) => s.settings.enter_to_send);
  const toast = useUi((s) => s.toast);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [mention, setMention] = useState<{ query: string; start: number } | null>(null);
  const [matches, setMatches] = useState<FileMatch[]>([]);
  const [active, setActive] = useState(0);
  const ref = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const online = machine?.status.state === "online";
  const blocked = agent.attention.status === "blocked" && agent.attention.reason !== "explicit_question";
  const allowed = can(machine, "agents.message");
  const disabledReason = !allowed
    ? "Cet appareil ne peut pas envoyer de messages"
    : !online
      ? "Machine hors ligne"
      : blocked
        ? "Réponds d'abord à la demande ci-dessus"
        : null;
  const slash = text.startsWith("/") && !text.includes(" ") && !text.includes("\n") ? (SLASH[agent.kind] ?? []).filter(([c]) => c.startsWith(text)) : [];
  const popup: { label: string; hint?: string; value: string; icon: React.ReactNode }[] = mention
    ? matches.map((m) => ({ label: m.path, value: m.path, icon: <FileText size={13} /> }))
    : slash.map(([c, hint]) => ({ label: c, hint, value: c, icon: <Slash size={13} /> }));

  // Draft per conversation.
  const draftKey = `draft:${machineId}:${agent.id}`;
  useEffect(() => {
    setText(sessionStorage.getItem(draftKey) ?? "");
    setAttachments([]);
  }, [draftKey]);
  useEffect(() => {
    if (text) sessionStorage.setItem(draftKey, text);
    else sessionStorage.removeItem(draftKey);
  }, [text, draftKey]);

  // Auto height.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  }, [text]);

  // Focus the input when the conversation opens.
  useEffect(() => {
    if (!disabledReason) ref.current?.focus();
  }, [agent.id, disabledReason]);

  // File search for @ mentions.
  useEffect(() => {
    if (!mention || !can(machine, "files.read")) {
      setMatches([]);
      return;
    }
    const timer = setTimeout(() => {
      api
        .files(machineId, agent.id, mention.query)
        .then((r) => {
          setMatches(r.files.slice(0, 12));
          setActive(0);
        })
        .catch(() => setMatches([]));
    }, 120);
    return () => clearTimeout(timer);
  }, [mention, machineId, agent.id, machine]);

  const upload = useCallback(
    async (name: string, run: () => Promise<string>) => {
      const placeholder: Attachment = { name, path: null, image: isImage(name) };
      setAttachments((a) => [...a, placeholder]);
      try {
        const path = await run();
        setAttachments((a) => a.map((x) => (x === placeholder ? { ...x, path } : x)));
      } catch (e) {
        setAttachments((a) => a.filter((x) => x !== placeholder));
        toast(`Envoi de ${name} impossible : ${errorMessage(e)}`, "error");
      }
    },
    [toast],
  );

  // Files dropped on the window.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void getCurrentWebview()
      .onDragDropEvent((event) => {
        if (event.payload.type !== "drop" || disabledReason) return;
        for (const path of event.payload.paths) void upload(basename(path), () => app.uploadFile(machineId, path));
      })
      .then((u) => (unlisten = u));
    return () => unlisten?.();
  }, [machineId, upload, disabledReason]);

  const updateMention = (value: string, caret: number) => {
    const before = value.slice(0, caret);
    const m = /(^|\s)@([^\s@]*)$/.exec(before);
    setMention(m ? { query: m[2], start: caret - m[2].length - 1 } : null);
  };

  const pick = (value: string) => {
    if (mention) {
      const caret = ref.current?.selectionStart ?? text.length;
      const next = `${text.slice(0, mention.start)}@${value} ${text.slice(caret)}`;
      setText(next);
      setMention(null);
    } else {
      setText(`${value} `);
    }
    ref.current?.focus();
  };

  const send = async (override?: string) => {
    const body = (override ?? text).trim();
    const paths = attachments.filter((a) => a.path).map((a) => a.path!);
    if ((!body && !paths.length) || sending || disabledReason) return;
    if (attachments.some((a) => !a.path)) {
      toast("Envoi des pièces jointes en cours…");
      return;
    }
    const message = paths.length ? `${body}${body ? "\n\n" : ""}${paths.join(" ")}` : body;
    setSending(true);
    try {
      await api.sendMessage(machineId, agent.id, message);
      if (!override) setText("");
      setAttachments([]);
      setMention(null);
    } catch (e) {
      toast(errorMessage(e), "error");
    } finally {
      setSending(false);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (popup.length) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActive((a) => (a + 1) % popup.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setActive((a) => (a - 1 + popup.length) % popup.length);
        return;
      }
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey && mention)) {
        e.preventDefault();
        pick(popup[active]?.value ?? popup[0].value);
        return;
      }
      if (e.key === "Escape") {
        setMention(null);
        return;
      }
    }
    const submit = enterToSend ? e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing : e.key === "Enter" && (e.metaKey || e.ctrlKey);
    if (submit) {
      e.preventDefault();
      void send();
    }
  };

  return (
    <div className="px-6 pb-4">
      {!text && !attachments.length && !disabledReason && (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {QUICK_REPLIES.map((q) => (
            <button
              key={q}
              onClick={() => void send(q)}
              className="rounded-full border border-border bg-surface px-2.5 py-[3px] text-[11.5px] text-muted transition-colors hover:border-[#3a414c] hover:text-text"
            >
              {q}
            </button>
          ))}
        </div>
      )}
      <div className={`relative rounded-2xl border bg-surface transition-colors ${disabledReason ? "border-border opacity-70" : "border-border focus-within:border-[#3a414c]"}`}>
        {popup.length > 0 && (
          <div className="absolute bottom-full left-0 right-0 mb-2 max-h-[280px] overflow-y-auto rounded-xl border border-border bg-surface p-1 shadow-[0_-12px_30px_rgba(0,0,0,0.4)]">
            {popup.map((p, i) => (
              <button
                key={p.value}
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(p.value);
                }}
                onMouseEnter={() => setActive(i)}
                className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[12.5px] ${i === active ? "bg-surface-high" : ""}`}
              >
                <span className="text-faint">{p.icon}</span>
                <span className="truncate font-mono">{p.label}</span>
                {p.hint && <span className="ml-auto text-[11.5px] text-faint">{p.hint}</span>}
              </button>
            ))}
          </div>
        )}
        {attachments.length > 0 && (
          <div className="flex flex-wrap gap-1.5 px-3 pt-3">
            {attachments.map((a, i) => (
              <span key={i} className="flex items-center gap-1.5 rounded-lg border border-border bg-bg px-2 py-1 text-[11.5px] text-muted">
                {a.path ? a.image ? <ImageIcon size={12} /> : <FileText size={12} /> : <Spinner className="h-3 w-3" />}
                <span className="max-w-[200px] truncate">{a.name}</span>
                <button onClick={() => setAttachments((x) => x.filter((_, j) => j !== i))} className="text-faint hover:text-text" aria-label="Retirer">
                  <X size={11} />
                </button>
              </span>
            ))}
          </div>
        )}
        <textarea
          ref={ref}
          rows={1}
          value={text}
          disabled={!!disabledReason}
          placeholder={disabledReason ?? "Écrire un message…  (@ fichier, / commande)"}
          onChange={(e) => {
            setText(e.target.value);
            updateMention(e.target.value, e.target.selectionStart);
          }}
          onKeyDown={onKeyDown}
          onPaste={(e) => {
            const files = [...e.clipboardData.files];
            if (!files.length) return;
            e.preventDefault();
            for (const f of files) {
              const name = f.name && f.name !== "image.png" ? f.name : `capture-${Date.now()}.${f.type.split("/")[1] || "png"}`;
              void upload(name, async () => app.uploadData(machineId, name, await readAsBase64(f)));
            }
          }}
          className="block max-h-[240px] w-full resize-none bg-transparent px-4 pb-1 pt-3 text-[13.5px] leading-[1.55] text-text placeholder:text-faint focus:outline-none disabled:cursor-not-allowed"
        />
        <div className="flex items-center gap-1 px-2 pb-2">
          <button
            onClick={() => fileInput.current?.click()}
            disabled={!!disabledReason}
            className="rounded-lg p-1.5 text-faint hover:bg-surface-high hover:text-text disabled:opacity-40"
            aria-label="Joindre un fichier"
            title="Joindre un fichier (ou glisser-déposer, ou coller une image)"
          >
            <Paperclip size={15} />
          </button>
          <button
            onClick={() => {
              const caret = ref.current?.selectionStart ?? text.length;
              const next = `${text.slice(0, caret)}${caret > 0 && !/\s$/.test(text.slice(0, caret)) ? " " : ""}@`;
              setText(next + text.slice(caret));
              updateMention(next, next.length);
              ref.current?.focus();
            }}
            disabled={!!disabledReason || !can(machine, "files.read")}
            className="rounded-lg p-1.5 text-faint hover:bg-surface-high hover:text-text disabled:opacity-40"
            aria-label="Mentionner un fichier"
            title="Mentionner un fichier"
          >
            <AtSign size={15} />
          </button>
          <input
            ref={fileInput}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              for (const f of [...(e.target.files ?? [])]) void upload(f.name, async () => app.uploadData(machineId, f.name, await readAsBase64(f)));
              e.target.value = "";
            }}
          />
          <div className="flex-1" />
          {agent.model && (
            <span className="mr-1 flex items-center gap-1.5 rounded-lg border border-border px-2 py-1 text-[11.5px] text-muted" title="Modèle utilisé par l'agent">
              <AgentIcon kind={agent.kind} size={11} />
              {agent.model.replace(/^claude-/, "")}
            </span>
          )}
          <button
            onClick={() => void send()}
            disabled={!!disabledReason || sending || (!text.trim() && !attachments.length)}
            className="flex h-8 w-8 items-center justify-center rounded-[10px] bg-accent text-on-accent transition-opacity hover:bg-[#fff3e2] disabled:opacity-30"
            aria-label="Envoyer"
            title={enterToSend ? "Envoyer (Entrée)" : "Envoyer (⌘ Entrée)"}
          >
            {sending ? <Spinner /> : <ArrowUp size={16} strokeWidth={2.5} />}
          </button>
        </div>
      </div>
    </div>
  );
}
