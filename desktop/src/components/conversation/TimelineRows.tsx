import {
  Bot,
  Brain,
  Check,
  ChevronRight,
  CircleDashed,
  Copy,
  FileCode2,
  FilePen,
  FileSearch,
  Globe,
  ListChecks,
  Loader2,
  MessageCircleQuestion,
  Search,
  SquareTerminal,
  Wrench,
  X,
} from "lucide-react";
import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import type { StoredItem } from "../../api/types";
import { changeDiff } from "../../lib/diff";
import { clockTime, duration, shortPath } from "../../lib/format";
import { useUi } from "../../store/ui";
import { AgentIcon, agentLabel } from "../ui/Status";
import { DiffView } from "./DiffView";
import { Markdown } from "./Markdown";
import type { Row, ToolCallItem, ToolResultItem } from "./rows";

/** Rows inside a turn's work block: no avatar column, no header. */
export const CompactRows = createContext(false);

/** Avatar column + name/time header, as in the mockup. */
function Block({ who, kind, time, continued, children }: { who: "user" | "agent"; kind: string; time?: string; continued?: boolean; children: ReactNode }) {
  const compact = useContext(CompactRows);
  if (compact) return <div className="min-w-0 pt-0.5">{children}</div>;
  return (
    <div className={`flex gap-3.5 px-6 ${continued ? "pt-1.5" : "pt-5"}`}>
      <div className="w-8 shrink-0">
        {!continued &&
          (who === "user" ? (
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-user text-[11px] font-semibold text-accent">You</div>
          ) : (
            <div className="flex h-8 w-8 items-center justify-center rounded-full border border-border bg-surface">
              <AgentIcon kind={kind} size={15} />
            </div>
          ))}
      </div>
      <div className="min-w-0 flex-1">
        {!continued && (
          <div className="mb-1 flex items-baseline gap-2">
            <span className="text-[13px] font-semibold">{who === "user" ? "You" : agentLabel(kind)}</span>
            {time && <span className="text-[11.5px] text-faint">{clockTime(time)}</span>}
          </div>
        )}
        {children}
      </div>
    </div>
  );
}

function ResultIcon({ result }: { result?: ToolResultItem }) {
  if (!result) return <Loader2 size={13} className="animate-spin text-working" />;
  if (result.rejected) return <X size={13} className="text-blocked" />;
  if (result.is_error) return <X size={13} className="text-error" />;
  return <Check size={13} className="text-done" />;
}

function Card({ icon, title, right, children }: { icon: ReactNode; title: ReactNode; right?: ReactNode; children?: ReactNode }) {
  return (
    <div className="mt-2 overflow-hidden rounded-xl border border-border bg-surface">
      <div className="flex items-center gap-2 px-3.5 py-2.5">
        <span className="text-muted">{icon}</span>
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{title}</span>
        {right}
      </div>
      {children}
    </div>
  );
}

export function RowView({ row, kind }: { row: Row; kind: string }) {
  switch (row.kind) {
    case "user":
      return (
        <Block who="user" kind={kind} time={row.item.timestamp}>
          <div className="selectable whitespace-pre-wrap break-words text-[13.5px] leading-[1.6] text-[#e8e4dd]">{row.item.text}</div>
        </Block>
      );
    case "assistant":
      return (
        <Block who="agent" kind={kind} time={row.item.timestamp} continued={row.continued}>
          <Markdown text={row.item.text} />
        </Block>
      );
    case "tools":
      return (
        <Block who="agent" kind={kind} time={row.calls[0].timestamp} continued={row.continued}>
          <ToolGroup calls={row.calls} />
        </Block>
      );
    case "command":
      return (
        <Block who="agent" kind={kind} time={row.call.timestamp} continued={row.continued}>
          <CommandLine call={row.call} result={row.result} />
        </Block>
      );
    case "file":
      return (
        <Block who="agent" kind={kind} time={row.call.timestamp} continued={row.continued}>
          <FileCard call={row.call} result={row.result} />
        </Block>
      );
    case "tool":
      return (
        <Block who="agent" kind={kind} time={row.call.timestamp} continued={row.continued}>
          <ToolLine call={row.call} result={row.result} />
        </Block>
      );
    case "thinking":
      return (
        <Block who="agent" kind={kind} time={row.item.timestamp} continued={row.continued}>
          <Thinking text={row.item.text} />
        </Block>
      );
    case "plan":
      return (
        <Block who="agent" kind={kind} time={row.item.timestamp} continued={row.continued}>
          <PlanCard todos={row.item.todos} compact={!row.latest} />
        </Block>
      );
    case "question":
      return (
        <Block who="agent" kind={kind} time={row.item.timestamp} continued={row.continued}>
          {row.result ? (
            <div className="mt-1.5 space-y-0.5 rounded-xl border border-border bg-surface px-3.5 py-2.5 text-[12.5px]">
              {row.item.questions.map((q, i) => (
                <div key={i} className="flex items-start gap-2 text-muted">
                  <MessageCircleQuestion size={13} className="mt-[3px] shrink-0" />
                  <span className="selectable">{q.question}</span>
                </div>
              ))}
              <div className="selectable pl-5 text-text">→ {row.result.summary}</div>
            </div>
          ) : (
            <Card icon={<MessageCircleQuestion size={15} />} title="Question">
              <div className="space-y-3 border-t border-border px-3.5 py-3">
                {row.item.questions.map((q, i) => (
                  <div key={i}>
                    {q.header && <div className="mb-0.5 text-[11px] uppercase tracking-wider text-faint">{q.header}</div>}
                    <div className="selectable text-[13px]">{q.question}</div>
                    <ul className="mt-1 space-y-0.5 text-[12.5px] text-muted">
                      {q.options.map((o) => (
                        <li key={o.label}>
                          • {o.label}
                          {o.description && <span className="text-faint"> — {o.description}</span>}
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            </Card>
          )}
        </Block>
      );
    case "subagent":
      return (
        <Block who="agent" kind={kind} continued={row.continued}>
          <Subagent items={row.items} />
        </Block>
      );
    case "turn":
      return (
        <div className="flex items-center gap-3 px-6 pb-1 pt-5 text-[11px] text-faint">
          <span className="h-px flex-1 bg-border" />
          <span>Turn ended{row.item.duration_ms ? ` · ${duration(row.item.duration_ms)}` : ""}</span>
          <span className="h-px flex-1 bg-border" />
        </div>
      );
    case "away":
      return (
        <div className="px-6 pt-4">
          <div className="rounded-xl border border-border bg-surface px-3.5 py-2.5">
            <div className="mb-1 text-[11px] font-medium uppercase tracking-wider text-faint">While you were away</div>
            <Markdown text={row.item.text} />
          </div>
        </div>
      );
    case "notice":
      return <div className="selectable px-6 pt-3 text-center text-[12px] text-faint">{row.item.text}</div>;
  }
}

function Thinking({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-1">
      <button onClick={() => setOpen(!open)} className="flex items-center gap-1.5 text-[12.5px] text-muted hover:text-text">
        <ChevronRight size={13} className={`transition-transform ${open ? "rotate-90" : ""}`} />
        <Brain size={13} />
        Thinking
      </button>
      {open && (
        <div className="selectable ml-5 mt-1 whitespace-pre-wrap border-l border-border pl-3 text-[12.5px] italic leading-relaxed text-muted">{text}</div>
      )}
    </div>
  );
}

function ToolGroup({ calls }: { calls: ToolCallItem[] }) {
  const [open, setOpen] = useState(false);
  const reads = calls.filter((c) => c.kind === "file_read").length;
  const searches = calls.filter((c) => c.kind === "search").length;
  const web = calls.filter((c) => c.kind === "web").length;
  const parts = [
    reads && `read ${reads} file${reads > 1 ? "s" : ""}`,
    searches && `${searches} search${searches > 1 ? "es" : ""}`,
    web && `${web} web request${web > 1 ? "s" : ""}`,
  ].filter(Boolean);
  const label = parts.join(", ");
  return (
    <div className="mt-1">
      <button onClick={() => setOpen(!open)} className="flex items-center gap-1.5 text-[12.5px] text-muted hover:text-text">
        <ChevronRight size={13} className={`transition-transform ${open ? "rotate-90" : ""}`} />
        {reads ? <FileSearch size={13} /> : web ? <Globe size={13} /> : <Search size={13} />}
        <span>{label.charAt(0).toUpperCase() + label.slice(1)}</span>
      </button>
      {open && (
        <div className="ml-5 mt-1 space-y-0.5 border-l border-border pl-3">
          {calls.map((c) => (
            <div key={c.n} className="selectable truncate font-mono text-[11.5px] text-faint" title={c.summary}>
              {c.kind === "file_read" ? "read" : c.kind === "web" ? "web" : "search"} {c.summary}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function CommandLine({ call, result }: { call: ToolCallItem; result?: ToolResultItem }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-1.5 overflow-hidden rounded-[10px] border border-border bg-[#121418]">
      <button onClick={() => setOpen(!open)} className="flex w-full items-center gap-2 px-3 py-[7px] text-left">
        <SquareTerminal size={13} className="shrink-0 text-faint" />
        <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-[#d4cfc6]">
          <span className="text-faint">$ </span>
          {call.summary || call.name}
        </span>
        <ResultIcon result={result} />
      </button>
      {open && result && (
        <div className={`selectable border-t border-border px-3 py-2 font-mono text-[11.5px] ${result.is_error ? "text-[#e59a98]" : "text-muted"}`}>
          {result.summary || "(no output)"}
        </div>
      )}
    </div>
  );
}

/** Diffs longer than this start folded. */
const OPEN_DIFF_MAX_LINES = 60;

function FileCard({ call, result }: { call: ToolCallItem; result?: ToolResultItem }) {
  const [copied, setCopied] = useState(false);
  const focusFile = useUi((s) => s.focusFile);
  const diff = useMemo(() => (call.change ? changeDiff(call.change) : null), [call.change]);
  const [open, setOpen] = useState(() => !diff || diff.lines.length <= OPEN_DIFF_MAX_LINES);
  const path = call.change?.path ?? call.summary;
  const created = call.change && call.change.old === null && !call.change.new.startsWith("*** Begin Patch");
  return (
    <div className="mt-2 overflow-hidden rounded-xl border border-border bg-surface">
      <div className="flex items-center gap-2 px-3.5 py-2">
        <button onClick={() => setOpen(!open)} className="flex min-w-0 flex-1 items-center gap-2 text-left">
          <ChevronRight size={13} className={`shrink-0 text-faint transition-transform ${open ? "rotate-90" : ""}`} />
          {created ? <FileCode2 size={14} className="shrink-0 text-muted" /> : <FilePen size={14} className="shrink-0 text-muted" />}
          <span className="truncate font-mono text-[12px]" title={path}>
            {shortPath(path, 4)}
          </span>
        </button>
        {result?.rejected && <span className="text-[11px] text-blocked">denied</span>}
        {diff && (
          <span className="shrink-0 rounded-md bg-done/12 px-1.5 font-mono text-[11px] text-done">
            +{diff.additions}
            {diff.deletions > 0 && <span className="text-error"> −{diff.deletions}</span>}
          </span>
        )}
        <button
          onClick={() => {
            void navigator.clipboard.writeText(call.change?.new ?? path);
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          }}
          className="rounded-md p-1 text-faint hover:bg-surface-high hover:text-text"
          aria-label="Copy the content"
        >
          {copied ? <Check size={13} /> : <Copy size={13} />}
        </button>
        <button onClick={() => focusFile(path)} className="rounded-md px-1.5 py-0.5 text-[11px] text-faint hover:bg-surface-high hover:text-text">
          Open
        </button>
      </div>
      {open && diff && (
        <div className="border-t border-border">
          <DiffView diff={diff} maxHeight={320} />
          {call.change?.truncated && <div className="border-t border-border px-3 py-1 text-[11px] text-faint">Content truncated</div>}
        </div>
      )}
    </div>
  );
}

function ToolLine({ call, result }: { call: ToolCallItem; result?: ToolResultItem }) {
  const icon =
    call.kind === "subagent" ? <Bot size={13} /> : call.kind === "plan" ? <ListChecks size={13} /> : call.kind === "todo" ? <ListChecks size={13} /> : <Wrench size={13} />;
  const label = call.kind === "subagent" ? "Subagent" : call.kind === "plan" ? "Proposed plan" : call.name;
  return (
    <div className="mt-1 flex items-center gap-2 text-[12.5px] text-muted" title={result?.summary}>
      {icon}
      <span className="shrink-0">{label}</span>
      {call.summary && call.summary !== label && <span className="selectable min-w-0 truncate font-mono text-[11.5px] text-faint">{call.summary}</span>}
      <ResultIcon result={result} />
    </div>
  );
}

export function PlanCard({ todos, compact }: { todos: { content: string; status: string }[]; compact?: boolean }) {
  const done = todos.filter((t) => t.status === "completed").length;
  if (compact) {
    return (
      <div className="mt-1 flex items-center gap-2 text-[12.5px] text-muted">
        <ListChecks size={13} /> Plan updated · {done}/{todos.length}
      </div>
    );
  }
  return (
    <Card icon={<ListChecks size={15} className={done === todos.length ? "text-done" : ""} />} title="Plan" right={<span className="text-[11.5px] text-faint">{done}/{todos.length}</span>}>
      <ul className="space-y-1.5 border-t border-border px-3.5 py-3">
        {todos.map((t, i) => (
          <li key={i} className="flex items-start gap-2.5 text-[13px]">
            <TodoIcon status={t.status} />
            <span className={t.status === "completed" ? "text-muted" : t.status === "in_progress" ? "text-text" : "text-[#cfcac2]"}>{t.content}</span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

export function TodoIcon({ status }: { status: string }) {
  if (status === "completed")
    return (
      <span className="mt-[2px] flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-done">
        <Check size={11} strokeWidth={3} className="text-ink" />
      </span>
    );
  if (status === "in_progress") return <Loader2 size={16} className="mt-[2px] shrink-0 animate-spin text-blocked" />;
  return <CircleDashed size={16} className="mt-[2px] shrink-0 text-faint" />;
}

function Subagent({ items }: { items: StoredItem[] }) {
  const [open, setOpen] = useState(false);
  const calls = items.filter((i) => i.type === "tool_call").length;
  return (
    <div className="mt-1.5">
      <button onClick={() => setOpen(!open)} className="flex items-center gap-1.5 text-[12.5px] text-muted hover:text-text">
        <ChevronRight size={13} className={`transition-transform ${open ? "rotate-90" : ""}`} />
        <Bot size={13} />
        Subagent · {calls} action{calls > 1 ? "s" : ""}
      </button>
      {open && (
        <div className="ml-5 mt-1.5 space-y-1 border-l border-border pl-3">
          {items.map((i) =>
            i.type === "assistant_message" ? (
              <div key={i.n} className="text-[12.5px]">
                <Markdown text={i.text} />
              </div>
            ) : i.type === "tool_call" ? (
              <div key={i.n} className="selectable truncate font-mono text-[11.5px] text-faint">
                {i.name} {i.summary}
              </div>
            ) : null,
          )}
        </div>
      )}
    </div>
  );
}
