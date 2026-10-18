import { openPath } from "@tauri-apps/plugin-opener";
import { ArrowDown, Copy, FolderOpen, History, MoreHorizontal, PanelRight, Play, RefreshCw, Square, SquareTerminal } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import { api, app, errorMessage } from "../../api/client";
import type { MachineView } from "../../api/types";
import { useStop } from "../../hooks/useStop";
import { historyKey, liveKey, statusLabel, type Conversation } from "../../lib/conversations";
import { ALT, MOD } from "../../lib/keys";
import { modPressed, overlayOpen } from "../../lib/platform";
import { can, touchTimeline, useMachines } from "../../store/machines";
import { useUi } from "../../store/ui";
import { Button, IconButton, Kbd, Spinner } from "../ui/Button";
import { Menu, MenuItem, MenuSeparator } from "../ui/Menu";
import { AgentIcon, Badge, attentionTone, StatusDot } from "../ui/Status";
import { ApprovalCard } from "./ApprovalCard";
import { Composer } from "./Composer";
import { buildRows } from "./rows";
import { RowView } from "./TimelineRows";

const BASE_INDEX = 1_000_000;

export function ConversationView({ conv }: { conv: Conversation }) {
  const timeline = useMachines((s) => s.timelines[conv.key]);
  const loadTimeline = useMachines((s) => s.loadTimeline);
  const machine = useMachines((s) => s.machines[conv.machineId]);
  const agent = conv.agent;

  useEffect(() => touchTimeline(conv.key), [conv.key]);
  useEffect(() => {
    if (!timeline?.loaded && !timeline?.loading) void loadTimeline(conv.key);
  }, [conv.key, timeline?.loaded, timeline?.loading, loadTimeline]);

  // Notifications for the conversation on screen are skipped.
  useEffect(() => {
    void app.setFocus(conv.live ? conv.machineId : null, conv.live ? (conv.agentId ?? null) : null);
    return () => void app.setFocus(null, null);
  }, [conv.machineId, conv.agentId, conv.live]);

  const items = timeline?.items ?? [];
  const rows = useMemo(() => buildRows(items), [items]);
  const retry = () => void loadTimeline(conv.key);
  const showApproval = !!agent?.interaction && agent.attention.status === "blocked";
  const working = agent?.attention.status === "working";

  return (
    <div className="flex h-full min-w-0 flex-col">
      <Header conv={conv} />
      <div className="relative min-h-0 flex-1">
        {!timeline?.loaded && <div className="flex h-full items-center justify-center text-muted"><Spinner className="h-5 w-5" /></div>}
        {timeline?.loaded && timeline.error && items.length === 0 && (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-10 text-center text-[13px] text-muted">
            <span>Couldn't load the conversation: {timeline.error}</span>
            <Button size="sm" icon={<RefreshCw size={13} />} loading={timeline.loading} onClick={retry}>
              Retry
            </Button>
          </div>
        )}
        {timeline?.loaded && !timeline.error && items.length === 0 && (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-10 text-center">
            <AgentIcon kind={conv.kind} size={22} />
            <p className="text-[13px] text-muted">
              {agent && !agent.has_transcript
                ? agent.warnings.includes("missing_herdr_integration")
                  ? `Can't read this conversation: install the Herdr integration for this agent (herdr integration install ${agent.kind}), then restart it.`
                  : "No conversation yet. Send a first message."
                : "No messages yet."}
            </p>
          </div>
        )}
        {timeline?.loaded && timeline.error && items.length > 0 && (
          <div className="absolute inset-x-0 top-0 z-10 flex items-center gap-2 border-b border-border bg-surface px-6 py-1.5 text-[12px] text-muted">
            <span className="min-w-0 flex-1 truncate">Couldn't refresh the conversation: {timeline.error}</span>
            <button onClick={retry} disabled={timeline.loading} className="shrink-0 text-blocked hover:underline disabled:opacity-50">
              Retry
            </button>
          </div>
        )}
        {items.length > 0 && (
          <TimelineList
            convKey={conv.key}
            rows={rows}
            kind={conv.kind}
            working={working}
            approval={showApproval}
            hasMore={!!timeline?.hasMore}
            loadingOlder={!!timeline?.loading}
            onTop={() => void loadTimeline(conv.key, true)}
          />
        )}
      </div>
      {agent && showApproval && <ApprovalCard key={agent.interaction!.id} machineId={conv.machineId} agent={agent} />}
      {agent && agent.attention.status === "blocked" && agent.attention.reason === "explicit_question" && (
        <div className="mx-6 mb-2 flex items-center gap-2 text-[12px] text-blocked">
          <StatusDot attention={agent.attention} /> The agent asked you something: reply below.
        </div>
      )}
      {agent ? (
        <Composer machineId={conv.machineId} agent={agent} />
      ) : conv.history ? (
        <ResumeBar conv={conv} />
      ) : null}
      {machine && machine.status.state !== "online" && <OfflineBanner machine={machine} />}
    </div>
  );
}

/** Machine offline: when the next attempt comes, and a way to try now. */
function OfflineBanner({ machine }: { machine: MachineView }) {
  const { state, error, retry_in_ms } = machine.status;
  // Deadline of the next attempt, from the status that announced it.
  const [deadline, setDeadline] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());
  useEffect(() => setDeadline(retry_in_ms !== null && state === "offline" ? Date.now() + retry_in_ms : null), [machine.status, retry_in_ms, state]);
  useEffect(() => {
    if (deadline === null) return;
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, [deadline]);
  const seconds = deadline !== null ? Math.max(0, Math.ceil((deadline - now) / 1000)) : null;
  const next = state === "connecting" || seconds === 0 ? "reconnecting…" : seconds !== null ? `retrying in ${seconds} s` : "reconnecting automatically";

  return (
    <div className="flex items-center gap-3 border-t border-border bg-surface px-6 py-2 text-[12px] text-muted">
      <span className="min-w-0 flex-1 truncate">
        {machine.record.name} is offline{error ? ` (${error})` : ""}: {next}
      </span>
      {state === "offline" && (
        <button onClick={() => void app.reconnectMachine(machine.record.machine_id).catch(() => {})} className="shrink-0 text-blocked hover:underline">
          Reconnect now
        </button>
      )}
    </div>
  );
}

/** Passed to the list header and footer, defined once so Virtuoso keeps them mounted. */
interface ListContext {
  hasMore: boolean;
  loadingOlder: boolean;
  working: boolean;
}

function ListHeader({ context }: { context?: ListContext }) {
  return (
    <div className="flex h-10 items-end justify-center pb-1 text-[11.5px] text-faint">
      {context?.hasMore ? context.loadingOlder ? <Spinner /> : "…" : "Start of the conversation"}
    </div>
  );
}

function ListFooter({ context }: { context?: ListContext }) {
  return (
    <div className="px-6 pb-6 pt-3">
      {context?.working && (
        <div className="ml-[46px] flex items-center gap-2 text-[12.5px] text-working">
          <span className="flex gap-1">
            <span className="h-1.5 w-1.5 animate-pulse-dot rounded-full bg-working" />
            <span className="h-1.5 w-1.5 animate-pulse-dot rounded-full bg-working [animation-delay:200ms]" />
            <span className="h-1.5 w-1.5 animate-pulse-dot rounded-full bg-working [animation-delay:400ms]" />
          </span>
          Thinking…
        </div>
      )}
    </div>
  );
}

const LIST_COMPONENTS = { Header: ListHeader, Footer: ListFooter };

function TimelineList({
  convKey,
  rows,
  kind,
  working,
  approval,
  hasMore,
  loadingOlder,
  onTop,
}: {
  convKey: string;
  rows: ReturnType<typeof buildRows>;
  kind: string;
  working: boolean;
  /** The approval card shows under the list (and shrinks it). */
  approval: boolean;
  hasMore: boolean;
  loadingOlder: boolean;
  onTop: () => void;
}) {
  const ref = useRef<VirtuosoHandle>(null);
  const [atBottom, setAtBottom] = useState(true);
  const atBottomRef = useRef(true);
  atBottomRef.current = atBottom;
  // Rows prepended since the first load shift the first index, so Virtuoso
  // keeps the scroll position when older pages arrive.
  const anchor = useRef<{ conv: string; key: string } | null>(null);
  if (!anchor.current || anchor.current.conv !== convKey || !rows.some((r) => r.key === anchor.current!.key)) {
    anchor.current = { conv: convKey, key: rows[0]?.key ?? "" };
  }
  const prepended = Math.max(0, rows.findIndex((r) => r.key === anchor.current!.key));
  const firstItemIndex = BASE_INDEX - prepended;
  const context = useMemo(() => ({ hasMore, loadingOlder, working }), [hasMore, loadingOlder, working]);

  // "Thinking…" or the approval card appearing must not push the last
  // messages out of view: stay at the bottom if we were there.
  useEffect(() => {
    if (!atBottomRef.current) return;
    const frame = requestAnimationFrame(() => ref.current?.scrollToIndex({ index: "LAST", align: "end" }));
    return () => cancelAnimationFrame(frame);
  }, [working, approval]);

  return (
    <>
      <Virtuoso
        key={convKey}
        ref={ref}
        className="h-full"
        data={rows}
        context={context}
        firstItemIndex={firstItemIndex}
        initialTopMostItemIndex={rows.length - 1}
        computeItemKey={(_, row) => row.key}
        followOutput={(bottom) => (bottom ? "smooth" : false)}
        atBottomStateChange={setAtBottom}
        atBottomThreshold={80}
        startReached={() => hasMore && !loadingOlder && onTop()}
        increaseViewportBy={{ top: 600, bottom: 300 }}
        components={LIST_COMPONENTS}
        itemContent={(_, row) => (
          <div className="mx-auto max-w-[920px]">
            <RowView row={row} kind={kind} />
          </div>
        )}
      />
      {!atBottom && (
        <button
          onClick={() => ref.current?.scrollToIndex({ index: "LAST", behavior: "smooth" })}
          className="absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-border bg-surface-high px-3 py-1.5 text-[12px] text-muted shadow-lg hover:text-text"
        >
          <ArrowDown size={13} /> Latest messages
        </button>
      )}
    </>
  );
}

function Header({ conv }: { conv: Conversation }) {
  const { togglePanel, showPanel, setPanelTab, toast } = useUi();
  const online = useMachines((s) => s.machines[conv.machineId]?.status.state === "online");
  const agent = conv.agent;
  const { canStop, stopping, stop, allowed } = useStop(conv.machineId, agent);

  // ⌘. (Ctrl+. elsewhere) interrupts the agent on screen.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "." || !modPressed(e) || e.defaultPrevented || overlayOpen()) return;
      e.preventDefault();
      void stop();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const subtitle = [conv.project, conv.machineName, agent ? `session ${agent.session}` : "archived"].filter(Boolean).join(" · ");
  // An offline machine's agents keep their last known state: shown greyed.
  const stale = !!agent && !online;

  return (
    <div className="drag flex h-[52px] shrink-0 items-center gap-3 border-b border-border px-5">
      <div className="no-drag flex min-w-0 flex-1 items-center gap-3">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-border bg-surface">
          <AgentIcon kind={conv.kind} size={15} />
        </span>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h1 className="truncate text-[14.5px] font-semibold">{conv.title}</h1>
            <span className={stale ? "opacity-40 grayscale" : ""}>
              <StatusDot attention={conv.attention} />
            </span>
          </div>
          <div className="truncate text-[11.5px] text-faint">{subtitle}</div>
        </div>
      </div>
      <div className="no-drag flex shrink-0 items-center gap-2">
        {stale ? <Badge>Offline</Badge> : <Badge tone={attentionTone(conv.attention)}>{statusLabel(conv.attention)}</Badge>}
        {agent && allowed && (
          <Button
            size="md"
            variant="secondary"
            icon={<Square size={13} />}
            disabled={!canStop}
            loading={stopping}
            onClick={() => void stop()}
            title={agent.attention.status === "blocked" ? "The agent is waiting for an answer: approve or deny it" : `Stop the agent (${MOD}.)`}
          >
            Stop
          </Button>
        )}
        <Menu
          trigger={
            <button className="flex h-9 w-9 items-center justify-center rounded-[10px] border border-border text-muted hover:bg-surface-high hover:text-text" aria-label="More actions">
              <MoreHorizontal size={16} />
            </button>
          }
        >
          {agent && (
            <MenuItem icon={<SquareTerminal size={14} />} onSelect={() => setPanelTab("terminal")}>
              Open terminal
            </MenuItem>
          )}
          {conv.local && conv.cwd && (
            <MenuItem icon={<FolderOpen size={14} />} onSelect={() => void openPath(conv.cwd!).catch((e) => toast(errorMessage(e), "error"))}>
              Open project folder
            </MenuItem>
          )}
          {agent?.native_session && (
            <MenuItem
              icon={<History size={14} />}
              onSelect={() => useUi.getState().select(historyKey(conv.machineId, `${agent.kind}:${agent.native_session}`))}
            >
              Show in history
            </MenuItem>
          )}
          <MenuItem
            icon={<Copy size={14} />}
            onSelect={() => {
              void navigator.clipboard.writeText(agent?.native_session ? `${agent.kind} --resume ${agent.native_session}` : (conv.agentId ?? conv.historyId ?? ""));
              toast("Copied");
            }}
          >
            {agent?.native_session ? "Copy resume command" : "Copy ID"}
          </MenuItem>
          <MenuSeparator />
          <MenuItem icon={<PanelRight size={14} />} onSelect={togglePanel}>
            {showPanel ? "Hide panel" : "Show panel"} <span className="ml-auto pl-4"><Kbd>{MOD}{ALT}B</Kbd></span>
          </MenuItem>
        </Menu>
        {!showPanel && (
          <IconButton label="Show panel" onClick={togglePanel}>
            <PanelRight size={15} />
          </IconButton>
        )}
      </div>
    </div>
  );
}

function ResumeBar({ conv }: { conv: Conversation }) {
  const machine = useMachines((s) => s.machines[conv.machineId]);
  const expect = useMachines((s) => s.expect);
  const { select, toast } = useUi();
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const allowed = can(machine, "agents.resume");
  const online = machine?.status.state === "online";

  const resume = async () => {
    if (!conv.historyId) return;
    setBusy(true);
    try {
      const r = await api.resume(conv.machineId, conv.historyId, { prompt: prompt.trim() });
      toast(r.already_running ? "This conversation is already running" : "Conversation resumed in Herdr", "success");
      const key = liveKey(conv.machineId, r.agent_id);
      expect(key);
      select(key);
    } catch (e) {
      toast(errorMessage(e), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="px-6 pb-4">
      <form
        className="flex items-center gap-2 rounded-2xl border border-border bg-surface p-2 pl-4"
        onSubmit={(e) => {
          e.preventDefault();
          void resume();
        }}
      >
        <History size={15} className="shrink-0 text-faint" />
        <input
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          disabled={!allowed || !online}
          placeholder={
            !allowed ? "This device can't resume conversations" : !online ? "Machine offline" : "Archived conversation: resume it, with a message if you like…"
          }
          className="flex-1 bg-transparent text-[13px] placeholder:text-faint focus:outline-none"
        />
        <Button type="submit" variant="primary" icon={<Play size={14} />} loading={busy} disabled={!allowed || !online}>
          Resume
        </Button>
      </form>
    </div>
  );
}
