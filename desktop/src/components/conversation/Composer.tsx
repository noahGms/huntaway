import { getCurrentWebview } from "@tauri-apps/api/webview";
import { ArrowUp, AtSign, CornerDownLeft, FileText, Image as ImageIcon, ListOrdered, Paperclip, Pencil, Slash, Square, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { api, app, errorMessage } from "../../api/client";
import type { AgentView, FileMatch, QueuedMessage } from "../../api/types";
import { markSent, useStop } from "../../hooks/useStop";
import { basename } from "../../lib/format";
import { MOD } from "../../lib/keys";
import { useDrafts, type Attachment } from "../../store/drafts";
import { can, useMachines } from "../../store/machines";
import { useSettings } from "../../store/settings";
import { useUi } from "../../store/ui";
import { Spinner } from "../ui/Button";
import { AgentIcon } from "../ui/Status";

const QUICK_REPLIES = ["Continue", "Run the tests", "Explain what you just did", "Commit the changes"];

const SLASH: Record<string, [string, string][]> = {
  claude: [
    ["/compact", "Summarize the context"],
    ["/clear", "New conversation"],
    ["/cost", "Session cost"],
    ["/model", "Change model"],
    ["/review", "Review the changes"],
    ["/init", "Create CLAUDE.md"],
  ],
  codex: [
    ["/compact", "Summarize the context"],
    ["/new", "New conversation"],
    ["/model", "Change model"],
    ["/review", "Review the changes"],
    ["/diff", "Show the diff"],
    ["/status", "Session status"],
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

const NO_ATTACHMENTS: Attachment[] = [];

const isImage = (name: string) => /\.(png|jpe?g|gif|webp|heic|bmp)$/i.test(name);

export function Composer({ machineId, agent }: { machineId: string; agent: AgentView }) {
  const machine = useMachines((s) => s.machines[machineId]);
  const enterToSend = useSettings((s) => s.settings.enter_to_send);
  const toast = useUi((s) => s.toast);
  // Draft per conversation, kept in a store: switching conversations or an
  // upload finishing after the switch loses nothing.
  const draftKey = `${machineId}:${agent.id}`;
  const text = useDrafts((s) => s.drafts[draftKey]?.text ?? "");
  const attachments = useDrafts((s) => s.drafts[draftKey]?.attachments) ?? NO_ATTACHMENTS;
  const setText = useCallback((t: string) => useDrafts.getState().setText(draftKey, t), [draftKey]);
  const [sending, setSending] = useState(false);
  const { canStop, stopping, stop } = useStop(machineId, agent);
  const [mention, setMention] = useState<{ query: string; start: number } | null>(null);
  const [matches, setMatches] = useState<FileMatch[]>([]);
  const [active, setActive] = useState(0);
  // Esc closed the command popup: it stays closed until the text changes.
  const [slashClosed, setSlashClosed] = useState<string | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const online = machine?.status.state === "online";
  // Waiting on a prompt: a message denies it, with the message as the reason.
  const blocked = agent.attention.status === "blocked" && agent.attention.reason !== "explicit_question" && !!agent.interaction;
  const canDeny = can(machine, "agents.approve");
  const allowed = can(machine, "agents.message") && (!blocked || canDeny);
  const canReadFiles = can(machine, "files.read");
  const disabledReason = !allowed ? (blocked ? "This device can't answer prompts" : "This device can't send messages") : !online ? "Machine offline" : null;
  const idle = agent.attention.status === "idle" || agent.attention.status === "done";
  const waitingQueue = (agent.queued ?? []).filter((q) => q.state === "waiting");
  // Sent now, the message would interrupt the agent's turn: it waits in the queue.
  const queues = !blocked && (agent.attention.status === "working" || waitingQueue.length > 0);
  const slash =
    text.startsWith("/") && !text.includes(" ") && !text.includes("\n") && slashClosed !== text ? (SLASH[agent.kind] ?? []).filter(([c]) => c.startsWith(text)) : [];
  const popup: { label: string; hint?: string; value: string; icon: React.ReactNode }[] = mention
    ? matches.map((m) => ({ label: m.path, value: m.path, icon: <FileText size={13} /> }))
    : slash.map(([c, hint]) => ({ label: c, hint, value: c, icon: <Slash size={13} /> }));

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
  const mentionQuery = mention?.query ?? null;
  useEffect(() => {
    if (mentionQuery === null || !canReadFiles) {
      setMatches([]);
      return;
    }
    let alive = true;
    const timer = setTimeout(() => {
      api
        .files(machineId, agent.id, mentionQuery)
        .then((r) => {
          if (!alive) return;
          setMatches(r.files.slice(0, 12));
          setActive(0);
        })
        .catch(() => alive && setMatches([]));
    }, 120);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [mentionQuery, machineId, agent.id, canReadFiles]);

  const upload = useCallback(
    async (name: string, run: () => Promise<string>) => {
      const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
      const drafts = useDrafts.getState();
      drafts.addAttachment(draftKey, { id, name, path: null, image: isImage(name) });
      try {
        drafts.resolveAttachment(draftKey, id, await run());
      } catch (e) {
        drafts.resolveAttachment(draftKey, id, null);
        toast(`Couldn't upload ${name}: ${errorMessage(e)}`, "error");
      }
    },
    [toast, draftKey],
  );

  // Files dropped on the window, for the conversation on screen. One
  // listener per mount; the latest props are read through a ref.
  const dropTarget = useRef({ machineId, disabled: !!disabledReason, upload });
  dropTarget.current = { machineId, disabled: !!disabledReason, upload };
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void getCurrentWebview()
      .onDragDropEvent((event) => {
        const target = dropTarget.current;
        if (event.payload.type !== "drop" || target.disabled) return;
        for (const path of event.payload.paths) void target.upload(basename(path), () => app.uploadFile(target.machineId, path));
      })
      .then((u) => {
        // Unmounted before the listener was ready.
        if (cancelled) u();
        else unlisten = u;
      });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

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
      toast("Attachments are still uploading…");
      return;
    }
    const message = paths.length ? `${body}${body ? "\n\n" : ""}${paths.join(" ")}` : body;
    setSending(true);
    try {
      if (blocked && agent.interaction) {
        const r = await api.deny(machineId, agent.id, agent.interaction.id, message);
        if (message && r.message_sent === false) toast("Denied, but the explanation couldn't be typed: send it again", "error");
      } else {
        await api.sendMessage(machineId, agent.id, message);
      }
      markSent(machineId, agent.id);
      const drafts = useDrafts.getState();
      if (override) attachments.forEach((a) => drafts.removeAttachment(draftKey, a.id));
      else drafts.clear(draftKey);
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
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing)) {
        e.preventDefault();
        pick(popup[active]?.value ?? popup[0].value);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        if (mention) setMention(null);
        else setSlashClosed(text);
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
      {!text && !attachments.length && !disabledReason && idle && (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {QUICK_REPLIES.map((q) => (
            <button
              key={q}
              onClick={() => {
                setText(q);
                ref.current?.focus();
              }}
              title="Put in the message box"
              className="rounded-full border border-border bg-surface px-2.5 py-[3px] text-[11.5px] text-muted transition-colors hover:border-[#3a414c] hover:text-text"
            >
              {q}
            </button>
          ))}
        </div>
      )}
      {waitingQueue.length > 0 && (
        <MessageQueue
          machineId={machineId}
          agentId={agent.id}
          queued={waitingQueue}
          onEdit={(q) => {
            // Back in the box, before what is being typed.
            void api
              .removeQueued(machineId, agent.id, q.id)
              .then((r) => {
                setText(text ? `${r.text}\n${text}` : r.text);
                ref.current?.focus();
              })
              .catch((e) => toast(errorMessage(e), "error"));
          }}
        />
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
            {attachments.map((a) => (
              <span key={a.id} className="flex items-center gap-1.5 rounded-lg border border-border bg-bg px-2 py-1 text-[11.5px] text-muted">
                {a.path ? a.image ? <ImageIcon size={12} /> : <FileText size={12} /> : <Spinner className="h-3 w-3" />}
                <span className="max-w-[200px] truncate">{a.name}</span>
                <button onClick={() => useDrafts.getState().removeAttachment(draftKey, a.id)} className="text-faint hover:text-text" aria-label="Remove">
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
          placeholder={disabledReason ?? (blocked ? "Deny and say what to do instead… (or answer above)" : queues ? "Queue a message for when the agent finishes…" : "Message…  (@ file, / command)")}
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
            aria-label="Attach a file"
            title="Attach a file (or drop it, or paste an image)"
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
            disabled={!!disabledReason || !canReadFiles}
            className="rounded-lg p-1.5 text-faint hover:bg-surface-high hover:text-text disabled:opacity-40"
            aria-label="Mention a file"
            title="Mention a file"
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
            <span className="mr-1 flex items-center gap-1.5 rounded-lg border border-border px-2 py-1 text-[11.5px] text-muted" title="Model used by the agent">
              <AgentIcon kind={agent.kind} size={11} />
              {agent.model.replace(/^claude-/, "")}
            </span>
          )}
          {canStop && !text.trim() && !attachments.length ? (
            <button
              onClick={() => void stop()}
              disabled={stopping}
              className="flex h-8 w-8 items-center justify-center rounded-[10px] bg-accent text-on-accent transition-opacity hover:bg-[#fff3e2] disabled:opacity-30"
              aria-label="Stop"
              title={`Stop the agent (${MOD}.)`}
            >
              {stopping ? <Spinner /> : <Square size={12} strokeWidth={0} fill="currentColor" />}
            </button>
          ) : (
            <button
              onClick={() => void send()}
              disabled={!!disabledReason || sending || (!text.trim() && !attachments.length)}
              className="flex h-8 w-8 items-center justify-center rounded-[10px] bg-accent text-on-accent transition-opacity hover:bg-[#fff3e2] disabled:opacity-30"
              aria-label={blocked ? "Deny with this message" : queues ? "Queue" : "Send"}
              title={`${blocked ? "Deny with this message" : queues ? "Queue: sent when the agent finishes" : "Send"} (${enterToSend ? "Enter" : `${MOD} Enter`})`}
            >
              {sending ? <Spinner /> : <ArrowUp size={16} strokeWidth={2.5} />}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/** Messages held until the agent finishes its turn, sent one by one. */
function MessageQueue({ machineId, agentId, queued, onEdit }: { machineId: string; agentId: string; queued: QueuedMessage[]; onEdit: (q: QueuedMessage) => void }) {
  const toast = useUi((s) => s.toast);
  const run = (p: Promise<unknown>) => void p.catch((e) => toast(errorMessage(e), "error"));
  return (
    <div className="mb-2 overflow-hidden rounded-xl border border-border bg-surface">
      <div className="flex items-center gap-2 border-b border-border px-3 py-1.5 text-[11.5px] text-faint">
        <ListOrdered size={12} />
        {queued.length} queued · sent when the agent finishes
      </div>
      {queued.map((q, i) => (
        <div key={q.id} className="group flex items-start gap-2 px-3 py-1.5 text-[12.5px] [&+&]:border-t [&+&]:border-border">
          <span className="w-4 shrink-0 pt-px text-right font-mono text-[11px] text-faint">{i + 1}</span>
          <span className="selectable min-w-0 flex-1 whitespace-pre-wrap break-words text-text line-clamp-3">{q.text}</span>
          <span className="flex shrink-0 items-center gap-0.5 opacity-60 group-hover:opacity-100">
            <button
              onClick={() => run(api.sendQueuedNow(machineId, agentId, q.id))}
              className="rounded-md p-1 text-faint hover:bg-surface-high hover:text-text"
              title="Send now, without waiting for the agent to finish"
              aria-label="Send now"
            >
              <CornerDownLeft size={13} />
            </button>
            <button onClick={() => onEdit(q)} className="rounded-md p-1 text-faint hover:bg-surface-high hover:text-text" title="Edit" aria-label="Edit">
              <Pencil size={13} />
            </button>
            <button
              onClick={() => run(api.removeQueued(machineId, agentId, q.id))}
              className="rounded-md p-1 text-faint hover:bg-surface-high hover:text-error"
              title="Remove from the queue"
              aria-label="Remove"
            >
              <Trash2 size={13} />
            </button>
          </span>
        </div>
      ))}
    </div>
  );
}
