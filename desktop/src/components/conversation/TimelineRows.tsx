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
import { clockTime, shortPath } from "../../lib/format";
import { useUi } from "../../store/ui";
import { DiffView } from "./DiffView";
import { Markdown } from "./Markdown";
import type { Row, ToolCallItem, ToolResultItem } from "./rows";

/** Rows inside a turn's work block: one line per step, no message frame. */
export const CompactRows = createContext(false);

/** User messages longer than this start folded. */
const USER_FOLD_CHARS = 1200;
const USER_FOLD_LINES = 14;

/**
 * A message: the user's in a bubble on the right, the agent's as plain text.
 * `copy`: text of the copy action shown on hover, with the time.
 */
function Block({ who, time, copy, continued, children }: { who: "user" | "agent"; time?: string; copy?: string; continued?: boolean; children: ReactNode }) {
  const compact = useContext(CompactRows);
  if (compact) return <div className="min-w-0">{children}</div>;
  if (who === "user")
    return (
      <div className="group flex flex-col items-end px-6 pt-8">
        <div className="max-w-[85%] rounded-[18px] bg-surface-high px-4 py-2.5">{children}</div>
        <MessageActions text={copy} time={time} />
      </div>
    );
  return (
    <div className={`group px-6 ${continued ? "pt-2" : "pt-4"}`}>
      {children}
      {copy !== undefined && <MessageActions text={copy} time={time} />}
    </div>
  );
}

function MessageActions({ text, time }: { text?: string; time?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="mt-1 flex h-6 items-center gap-0.5 text-faint opacity-0 transition-opacity group-hover:opacity-100">
      {text && (
        <button
          onClick={() => {
            void navigator.clipboard.writeText(text);
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          }}
          className="rounded-md p-1 hover:bg-surface-high hover:text-text"
          aria-label="Copy"
          title="Copy"
        >
          {copied ? <Check size={13} /> : <Copy size={13} />}
        </button>
      )}
      {time && <span className="px-1 text-[11.5px]">{clockTime(time)}</span>}
    </div>
  );
}

function UserText({ text }: { text: string }) {
  const long = text.length > USER_FOLD_CHARS || text.split("\n").length > USER_FOLD_LINES;
  const [open, setOpen] = useState(!long);
  return (
    <>
      <div className={`selectable whitespace-pre-wrap break-words text-[14.5px] leading-[1.6] text-[#ece8e1] ${open ? "" : "line-clamp-[10]"}`}>{text}</div>
      {long && (
        <button onClick={() => setOpen(!open)} className="mt-1 text-[12.5px] text-muted hover:text-text">
          {open ? "Show less" : "Show more"}
        </button>
      )}
    </>
  );
}

/**
 * One step of the agent's work: "Ran npm test", "Read 3 files". Clicking it
 * shows `children` (output, diff, list) when there are any.
 */
function Step({ icon, verb, detail, status, right, children }: { icon?: ReactNode; verb: ReactNode; detail?: ReactNode; status?: ReactNode; right?: ReactNode; children?: ReactNode }) {
  const [open, setOpen] = useState(false);
  const expandable = !!children;
  return (
    <div className="group/step">
      <div className="flex min-h-[26px] items-center gap-2">
        <button
          onClick={() => expandable && setOpen(!open)}
          className={`flex min-w-0 flex-1 items-center gap-2 text-left text-[13px] ${expandable ? "cursor-pointer" : "cursor-default"}`}
          aria-expanded={expandable ? open : undefined}
        >
          {icon && <span className="shrink-0 text-faint">{icon}</span>}
          <span className="shrink-0 text-muted group-hover/step:text-text">{verb}</span>
          {detail && <span className="selectable min-w-0 truncate font-mono text-[12px] text-faint">{detail}</span>}
          {status}
          {expandable && <ChevronRight size={12} className={`shrink-0 text-faint transition-transform ${open ? "rotate-90" : "opacity-0 group-hover/step:opacity-100"}`} />}
        </button>
        {right}
      </div>
      {open && children && <div className="mb-2 mt-1">{children}</div>}
    </div>
  );
}

/** Only failures and calls still running are worth a mark. */
function StepStatus({ result }: { result?: ToolResultItem }) {
  if (!result) return <Loader2 size={12} className="shrink-0 animate-spin text-working" />;
  if (result.rejected) return <span className="shrink-0 text-[11.5px] text-blocked">denied</span>;
  if (result.is_error) return <X size={13} className="shrink-0 text-error" />;
  return null;
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

export function RowView({ row }: { row: Row; kind?: string }) {
  switch (row.kind) {
    case "user":
      return (
        <Block who="user" time={row.item.timestamp} copy={row.item.text}>
          <UserText text={row.item.text} />
        </Block>
      );
    case "assistant":
      return <AssistantText text={row.item.text} time={row.item.timestamp} continued={row.continued} />;
    case "tools":
      return (
        <Block who="agent" continued={row.continued}>
          <ToolGroup calls={row.calls} />
        </Block>
      );
    case "command":
      return (
        <Block who="agent" continued={row.continued}>
          <CommandLine call={row.call} result={row.result} />
        </Block>
      );
    case "file":
      return (
        <Block who="agent" continued={row.continued}>
          <FileCard call={row.call} result={row.result} />
        </Block>
      );
    case "tool":
      return (
        <Block who="agent" continued={row.continued}>
          <ToolLine call={row.call} result={row.result} />
        </Block>
      );
    case "thinking":
      return (
        <Block who="agent" continued={row.continued}>
          <Thinking text={row.item.text} />
        </Block>
      );
    case "plan":
      return (
        <Block who="agent" continued={row.continued}>
          <PlanCard todos={row.item.todos} compact={!row.latest} />
        </Block>
      );
    case "proposal":
      return (
        <Block who="agent" continued={row.continued}>
          <PlanProposal plan={row.call.plan ?? ""} result={row.result} />
        </Block>
      );
    case "question":
      return (
        <Block who="agent" continued={row.continued}>
          {row.result ? (
            <div className="mt-1 space-y-1 rounded-xl border border-border px-3.5 py-2.5 text-[13px]">
              {row.item.questions.map((q, i) => (
                <div key={i} className="flex items-start gap-2 text-muted">
                  <MessageCircleQuestion size={13} className="mt-[4px] shrink-0" />
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
                    <div className="selectable text-[13.5px]">{q.question}</div>
                    <ul className="mt-1 space-y-0.5 text-[13px] text-muted">
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
        <Block who="agent" continued={row.continued}>
          <Subagent items={row.items} />
        </Block>
      );
    case "turn":
      return null;
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
      return (
        <div className="flex items-center gap-3 px-6 pt-6 text-[12px] text-faint">
          <span className="h-px flex-1 bg-border" />
          <span className="selectable">{row.item.text}</span>
          <span className="h-px flex-1 bg-border" />
        </div>
      );
  }
}

/** The agent's text; between two steps of its work, a little smaller. */
function AssistantText({ text, time, continued }: { text: string; time?: string; continued: boolean }) {
  const compact = useContext(CompactRows);
  if (compact)
    return (
      <div className="py-1.5 [&_.md]:text-[#d4cfc6]">
        <Markdown text={text} small />
      </div>
    );
  return (
    <Block who="agent" time={time} copy={text} continued={continued}>
      <Markdown text={text} />
    </Block>
  );
}

function Thinking({ text }: { text: string }) {
  return (
    <Step icon={<Brain size={13} />} verb="Thought">
      <div className="selectable ml-[21px] whitespace-pre-wrap border-l border-border pl-3 text-[12.5px] italic leading-relaxed text-muted">{text}</div>
    </Step>
  );
}

function ToolGroup({ calls }: { calls: ToolCallItem[] }) {
  const reads = calls.filter((c) => c.kind === "file_read").length;
  const searches = calls.filter((c) => c.kind === "search").length;
  const web = calls.filter((c) => c.kind === "web").length;
  const parts = [
    reads && `read ${reads} file${reads > 1 ? "s" : ""}`,
    searches && `${searches} search${searches > 1 ? "es" : ""}`,
    web && `${web} web request${web > 1 ? "s" : ""}`,
  ].filter(Boolean);
  const label = parts.join(", ");
  const single = calls.length === 1 ? calls[0] : null;
  return (
    <Step
      icon={reads ? <FileSearch size={13} /> : web ? <Globe size={13} /> : <Search size={13} />}
      verb={single ? (single.kind === "file_read" ? "Read" : single.kind === "web" ? "Fetched" : "Searched") : label.charAt(0).toUpperCase() + label.slice(1)}
      detail={single?.summary}
    >
      {!single && (
        <div className="ml-[21px] space-y-0.5 border-l border-border pl-3">
          {calls.map((c) => (
            <div key={c.n} className="selectable truncate font-mono text-[11.5px] text-faint" title={c.summary}>
              {c.kind === "file_read" ? "read" : c.kind === "web" ? "web" : "search"} {c.summary}
            </div>
          ))}
        </div>
      )}
    </Step>
  );
}

function CommandLine({ call, result }: { call: ToolCallItem; result?: ToolResultItem }) {
  return (
    <Step icon={<SquareTerminal size={13} />} verb="Ran" detail={call.summary || call.name} status={<StepStatus result={result} />}>
      {result && (
        <div
          className={`selectable ml-[21px] overflow-x-auto whitespace-pre-wrap rounded-lg border border-border bg-[#121418] px-3 py-2 font-mono text-[11.5px] ${result.is_error ? "text-[#e59a98]" : "text-muted"}`}
        >
          {result.summary || "(no output)"}
        </div>
      )}
    </Step>
  );
}

function FileCard({ call, result }: { call: ToolCallItem; result?: ToolResultItem }) {
  const focusFile = useUi((s) => s.focusFile);
  const diff = useMemo(() => (call.change ? changeDiff(call.change) : null), [call.change]);
  const path = call.change?.path ?? call.summary;
  const created = call.change && call.change.old === null && !call.change.new.startsWith("*** Begin Patch");
  return (
    <Step
      icon={created ? <FileCode2 size={13} /> : <FilePen size={13} />}
      verb={created ? "Created" : "Edited"}
      detail={<span title={path}>{shortPath(path, 3)}</span>}
      status={
        <>
          {diff && (
            <span className="shrink-0 font-mono text-[11.5px] text-done">
              +{diff.additions}
              {diff.deletions > 0 && <span className="text-error"> −{diff.deletions}</span>}
            </span>
          )}
          <StepStatus result={result} />
        </>
      }
      right={
        <button
          onClick={() => focusFile(path)}
          className="shrink-0 rounded-md px-1.5 py-0.5 text-[11.5px] text-faint opacity-0 hover:bg-surface-high hover:text-text group-hover/step:opacity-100"
        >
          Open
        </button>
      }
    >
      {diff && (
        <div className="ml-[21px] overflow-hidden rounded-lg border border-border">
          <DiffView diff={diff} maxHeight={320} />
          {call.change?.truncated && <div className="border-t border-border px-3 py-1 text-[11px] text-faint">Content truncated</div>}
        </div>
      )}
    </Step>
  );
}

function ToolLine({ call, result }: { call: ToolCallItem; result?: ToolResultItem }) {
  const icon =
    call.kind === "subagent" ? <Bot size={13} /> : call.kind === "plan" ? <ListChecks size={13} /> : call.kind === "todo" ? <ListChecks size={13} /> : <Wrench size={13} />;
  const label = call.kind === "subagent" ? "Subagent" : call.kind === "plan" ? "Proposed plan" : call.name;
  return (
    <Step icon={icon} verb={label} detail={call.summary && call.summary !== label ? call.summary : undefined} status={<StepStatus result={result} />}>
      {result?.summary && <div className="selectable ml-[21px] border-l border-border pl-3 font-mono text-[11.5px] text-faint">{result.summary}</div>}
    </Step>
  );
}

/** Plan the agent proposed (`ExitPlanMode`), folded past a few screens of text. */
export function PlanProposal({ plan, result }: { plan: string; result?: ToolResultItem }) {
  const long = plan.length > 1500 || plan.split("\n").length > 24 || !result;
  // Waiting for review: the approval card below shows it in full.
  const [open, setOpen] = useState(!long && !!result);
  const [copied, setCopied] = useState(false);
  const status = !result ? (
    <span className="text-[11.5px] text-blocked">Waiting for review</span>
  ) : result.rejected ? (
    <span className="text-[11.5px] text-blocked">Kept planning</span>
  ) : result.is_error ? (
    <span className="text-[11.5px] text-error">Not applied</span>
  ) : (
    <span className="flex items-center gap-1 text-[11.5px] text-done">
      <Check size={12} /> Approved
    </span>
  );
  return (
    <Card
      icon={<ListChecks size={15} />}
      title="Proposed plan"
      right={
        <div className="flex items-center gap-2">
          {status}
          <button
            onClick={() => {
              void navigator.clipboard.writeText(plan);
              setCopied(true);
              setTimeout(() => setCopied(false), 1200);
            }}
            className="rounded-md p-1 text-faint hover:bg-surface-high hover:text-text"
            aria-label="Copy the plan"
          >
            {copied ? <Check size={13} /> : <Copy size={13} />}
          </button>
        </div>
      }
    >
      <div className={`relative border-t border-border px-3.5 py-3 ${open ? "" : "max-h-[280px] overflow-hidden"}`}>
        <Markdown text={plan} />
        {!open && <div className="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-surface to-transparent" />}
      </div>
      {long && (
        <button onClick={() => setOpen(!open)} className="w-full border-t border-border px-3.5 py-1.5 text-left text-[12px] text-muted hover:bg-surface-high hover:text-text">
          {open ? "Show less" : "Show the full plan"}
        </button>
      )}
    </Card>
  );
}

export function PlanCard({ todos, compact }: { todos: { content: string; status: string }[]; compact?: boolean }) {
  const done = todos.filter((t) => t.status === "completed").length;
  if (compact) {
    return (
      <Step icon={<ListChecks size={13} />} verb="Updated the plan" detail={`${done}/${todos.length}`} />
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
  const calls = items.filter((i) => i.type === "tool_call").length;
  return (
    <Step icon={<Bot size={13} />} verb="Subagent" detail={`${calls} action${calls > 1 ? "s" : ""}`}>
      <div className="ml-[21px] space-y-1 border-l border-border pl-3">
        {items.map((i) =>
          i.type === "assistant_message" ? (
            <Markdown key={i.n} text={i.text} small />
          ) : i.type === "tool_call" ? (
            <div key={i.n} className="selectable truncate font-mono text-[11.5px] text-faint">
              {i.name} {i.summary}
            </div>
          ) : null,
        )}
      </div>
    </Step>
  );
}
