import { Bot, ChevronRight, Clock, FileCode2, FilePen, History, ListChecks, Loader2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { AgentView, QueuedMessage, Todo } from "../../api/types";
import { agentTitle, liveKey, needsYou, statusLabel } from "../../lib/conversations";
import { basename, dirname, duration, firstLine, parseTime, shortPath } from "../../lib/format";
import { useMachines } from "../../store/machines";
import { useUi } from "../../store/ui";
import { AgentIcon, StatusDot } from "../ui/Status";
import { ApprovalCard } from "./ApprovalCard";
import type { ToolCallItem, ToolResultItem } from "./rows";
import { Markdown } from "./Markdown";
import { CompactRows, PlanCard, RowView } from "./TimelineRows";
import { statsLabel, type FileSummary, type TurnRow } from "./turns";

/** Rows of a live work block shown before "Show earlier". */
const LIVE_TAIL = 8;

export function TurnRowView({ row, kind, machineId, agent }: { row: TurnRow; kind: string; machineId: string; agent?: AgentView }) {
  switch (row.kind) {
    case "work":
      return <WorkBlock row={row} kind={kind} />;
    case "agent":
      return <AgentLaunchCard call={row.call} result={row.result} machineId={machineId} parent={agent} />;
    case "files":
      return <FilesChanged files={row.files} />;
    default:
      return <RowView row={row} kind={kind} />;
  }
}

/** Seconds since `iso`, refreshed every second while mounted. */
function useElapsed(iso: string | null, on: boolean): number | null {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!on) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [on]);
  const t = parseTime(iso);
  return on && t !== null ? Math.max(0, now - t) : null;
}

/** Aligned with the agent's text. */
function Indented({ children, top = "pt-3" }: { children: React.ReactNode; top?: string }) {
  return <div className={`px-6 ${top}`}>{children}</div>;
}

function WorkBlock({ row, kind }: { row: Extract<TurnRow, { kind: "work" }>; kind: string }) {
  const [open, setOpen] = useState(row.live);
  const [showAll, setShowAll] = useState(false);
  const touched = useRef(false);
  // Opens while the agent works, folds when the turn ends (unless toggled by hand).
  useEffect(() => {
    if (!touched.current) setOpen(row.live);
  }, [row.live]);
  const elapsed = useElapsed(row.startedAt, row.live);
  const stats = statsLabel(row.stats);
  const time = row.live ? duration(elapsed) : row.durationMs ? duration(row.durationMs) : null;
  const label = row.live ? "Working" : time ? `Worked for ${time}` : "Worked";
  const hidden = row.live && !showAll ? Math.max(0, row.rows.length - LIVE_TAIL) : 0;
  const rows = hidden ? row.rows.slice(hidden) : row.rows;

  return (
    <Indented>
      <button
        onClick={() => {
          touched.current = true;
          setOpen(!open);
        }}
        className="group/work flex max-w-full items-center gap-2 py-1 text-left text-[13px]"
        aria-expanded={open}
      >
        <span className={`shrink-0 ${row.live ? "shimmer font-medium" : "text-muted group-hover/work:text-text"}`}>{label}</span>
        {row.live && time && <span className="shrink-0 tabular-nums text-faint">{time}</span>}
        {!row.live && stats && <span className="min-w-0 truncate text-faint">· {stats}</span>}
        <ChevronRight size={13} className={`shrink-0 text-faint transition-transform ${open ? "rotate-90" : ""}`} />
      </button>
      {open && rows.length > 0 && (
        <div className="mb-1 ml-[5px] mt-1 border-l border-border pl-4">
          {hidden > 0 && (
            <button onClick={() => setShowAll(true)} className="mb-1 text-[12px] text-faint hover:text-text">
              Show {hidden} earlier step{hidden > 1 ? "s" : ""}
            </button>
          )}
          <CompactRows.Provider value={true}>
            {rows.map((r) => (
              <RowView key={r.key} row={r} kind={kind} />
            ))}
          </CompactRows.Provider>
        </div>
      )}
      {/* Folded: what it is doing now; open, the last step says it. */}
      {row.live && !open && row.current && (
        <div className="ml-[5px] flex items-center gap-2 border-l border-transparent pl-4 pt-0.5 text-[12.5px]">
          <Loader2 size={12} className="shrink-0 animate-spin text-working" />
          <span className="selectable min-w-0 truncate font-mono text-[12px] text-faint">{row.current}</span>
        </div>
      )}
    </Indented>
  );
}

/** Child agent started by `call`: by pane, then by name, among the machine's live agents. */
function useLaunchedAgent(machineId: string, call: ToolCallItem, parent?: AgentView): AgentView | undefined {
  return useMachines((s) => {
    const agents = s.machines[machineId]?.snapshot?.agents ?? [];
    const launch = call.agent;
    if (!launch) return undefined;
    const pool = parent?.children.length ? agents.filter((a) => parent.children.includes(a.id)) : agents;
    return (
      pool.find((a) => launch.pane_id && a.pane_id === launch.pane_id) ??
      pool.find((a) => launch.name && a.name === launch.name) ??
      agents.find((a) => launch.pane_id && a.pane_id === launch.pane_id && a.parent_id === parent?.id)
    );
  });
}

function AgentLaunchCard({ call, result, machineId, parent }: { call: ToolCallItem; result?: ToolResultItem; machineId: string; parent?: AgentView }) {
  const child = useLaunchedAgent(machineId, call, parent);
  const select = useUi((s) => s.select);
  const launch = call.agent;
  const name = child ? agentTitle(child) : (launch?.name ?? "Agent");
  const kind = child?.kind ?? launch?.kind ?? "agent";
  const blocked = needsYou(child?.attention);
  return (
    <Indented top="pt-2">
      <div className={`overflow-hidden rounded-xl border ${blocked ? "border-blocked/45" : "border-border"} bg-surface`}>
        <div className="flex items-center gap-2 px-3.5 py-2.5">
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-border bg-bg">
            {child || launch?.kind ? <AgentIcon kind={kind} size={12} /> : <Bot size={12} className="text-muted" />}
          </span>
          <span className="min-w-0 truncate text-[13px] font-medium">{name}</span>
          {child ? (
            <span className="flex shrink-0 items-center gap-1.5 text-[11.5px] text-muted">
              <StatusDot attention={child.attention} size={7} />
              {statusLabel(child.attention)}
            </span>
          ) : (
            <span className="shrink-0 text-[11.5px] text-faint">{launch?.start ? (result ? "not running" : "starting…") : "prompted"}</span>
          )}
          <span className="flex-1" />
          {child && (
            <button onClick={() => select(liveKey(machineId, child.id))} className="shrink-0 rounded-md px-1.5 py-0.5 text-[11.5px] text-faint hover:bg-surface-high hover:text-text">
              Open →
            </button>
          )}
        </div>
        {(launch?.prompt || child?.summary) && (
          <div className="space-y-1 border-t border-border px-3.5 py-2 text-[12.5px]">
            {launch?.prompt && <div className="selectable line-clamp-2 text-[#cfcac2]">“{launch.prompt}”</div>}
            {child?.summary && <div className="selectable truncate text-faint">{firstLine(child.summary, 160)}</div>}
          </div>
        )}
        {child && blocked && child.interaction && (
          <div className="border-t border-blocked/20 pt-3">
            <ApprovalCard key={child.interaction.id} machineId={machineId} agent={child} embedded />
          </div>
        )}
      </div>
    </Indented>
  );
}

/** Files listed before "Show all". */
const FILES_SHOWN = 3;

function FilesChanged({ files }: { files: FileSummary[] }) {
  const focusFile = useUi((s) => s.focusFile);
  const setPanelTab = useUi((s) => s.setPanelTab);
  const [all, setAll] = useState(files.length <= FILES_SHOWN + 1);
  const additions = files.reduce((n, f) => n + f.additions, 0);
  const deletions = files.reduce((n, f) => n + f.deletions, 0);
  const shown = all ? files : files.slice(0, FILES_SHOWN);
  return (
    <Indented top="pt-4">
      <div className="overflow-hidden rounded-xl border border-border">
        <div className="flex items-center gap-2 border-b border-border px-3.5 py-2.5 text-[13px]">
          <span className="min-w-0 flex-1 truncate">
            Changed {files.length} file{files.length > 1 ? "s" : ""}
          </span>
          <button onClick={() => setPanelTab("files")} className="shrink-0 text-[12.5px] text-muted hover:text-text">
            Review
          </button>
        </div>
        {shown.map((f) => (
          <button
            key={f.path}
            onClick={() => focusFile(f.path)}
            className="flex w-full items-center gap-2.5 px-3.5 py-[7px] text-left text-[13px] hover:bg-surface"
            title={f.path}
          >
            {f.created ? <FileCode2 size={14} className="shrink-0 text-faint" /> : <FilePen size={14} className="shrink-0 text-faint" />}
            <span className="min-w-0 truncate">{basename(f.path)}</span>
            <span className="min-w-0 flex-1 truncate text-[12px] text-faint">{shortPath(dirname(f.path), 3)}</span>
            <Delta additions={f.additions} deletions={f.deletions} />
          </button>
        ))}
        {!all ? (
          <button onClick={() => setAll(true)} className="flex w-full items-center gap-2 px-3.5 py-[7px] text-left text-[13px] text-muted hover:bg-surface hover:text-text">
            <span className="flex-1">Show all</span>
            <Delta additions={additions} deletions={deletions} />
          </button>
        ) : (
          files.length > 1 && (
            <div className="flex items-center gap-2 px-3.5 py-[7px] text-[12px] text-faint">
              <span className="flex-1">Total</span>
              <Delta additions={additions} deletions={deletions} />
            </div>
          )
        )}
      </div>
    </Indented>
  );
}

function Delta({ additions, deletions }: { additions: number; deletions: number }) {
  return (
    <span className="shrink-0 font-mono text-[12px] tabular-nums">
      <span className="text-done">+{additions}</span>
      {deletions > 0 && <span className="text-error"> −{deletions}</span>}
    </span>
  );
}

/** Messages typed into the agent that its transcript does not show yet (waiting ones show above the composer). */
export function QueuedMessages({ queued, working }: { queued: QueuedMessage[]; working: boolean }) {
  return (
    <>
      {queued.map((q, i) => (
        <div key={`${q.at}-${i}`} className="flex flex-col items-end px-6 pt-8 opacity-70">
          <div className="selectable max-w-[85%] whitespace-pre-wrap break-words rounded-[18px] bg-surface-high px-4 py-2.5 text-[14.5px] leading-[1.6] text-[#ece8e1]">{q.text}</div>
          <div className="mt-1 flex items-center gap-1.5 text-[11.5px] text-faint">
            <Clock size={11} />
            {working ? "Sent: read after its current step" : "Sending…"}
          </div>
        </div>
      ))}
    </>
  );
}

/** Latest plan, pinned above the composer while it has unfinished tasks. */
/** The agent's recap after a pause, above the conversation. */
export function AwayBar({ text, onDismiss }: { text: string; onDismiss: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-b border-border bg-surface px-6 py-1.5">
      <div className="flex items-center gap-2 text-[12.5px]">
        <button onClick={() => setOpen(!open)} className="flex min-w-0 flex-1 items-center gap-2 text-left" aria-expanded={open}>
          <History size={13} className="shrink-0 text-muted" />
          <span className="shrink-0 text-muted">While you were away</span>
          {!open && <span className="min-w-0 flex-1 truncate text-text">{firstLine(text)}</span>}
          <ChevronRight size={13} className={`ml-auto shrink-0 text-faint transition-transform ${open ? "-rotate-90" : "rotate-90"}`} />
        </button>
        <button onClick={onDismiss} className="shrink-0 text-faint hover:text-text" aria-label="Dismiss">
          <X size={13} />
        </button>
      </div>
      {open && (
        <div className="selectable max-h-[40vh] overflow-y-auto pb-1 pt-1.5">
          <Markdown text={text} />
        </div>
      )}
    </div>
  );
}

export function PlanBar({ todos }: { todos: Todo[] }) {
  const [open, setOpen] = useState(false);
  const done = todos.filter((t) => t.status === "completed").length;
  const current = todos.find((t) => t.status === "in_progress") ?? todos.find((t) => t.status !== "completed");
  return (
    <div className="mx-auto w-full max-w-[800px] px-6 pb-2">
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 rounded-xl border border-border bg-surface px-3 py-1.5 text-left text-[12.5px] hover:border-[#3a414c]"
        aria-expanded={open}
      >
        <ListChecks size={13} className="shrink-0 text-muted" />
        <span className="shrink-0 tabular-nums text-muted">
          Plan {done}/{todos.length}
        </span>
        {current && <span className="min-w-0 flex-1 truncate text-text">{current.content}</span>}
        <ChevronRight size={13} className={`ml-auto shrink-0 text-faint transition-transform ${open ? "-rotate-90" : "rotate-90"}`} />
      </button>
      {open && <PlanCard todos={todos} />}
    </div>
  );
}
