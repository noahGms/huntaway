import { openPath } from "@tauri-apps/plugin-opener";
import { Archive, ArchiveRestore, ArrowDown, ChevronDown, ChevronRight, Copy, FolderOpen, History, MessageCircleReply, Monitor, PanelRight, Play, RefreshCw, SquareArrowOutUpRight, SquareTerminal } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import { api, app, errorMessage } from "../../api/client";
import type { AgentView, MachineView, QueuedMessage } from "../../api/types";
import { useStop } from "../../hooks/useStop";
import { agentTitle, archiveId, askedYou, historyKey, liveKey, needsYou, statusLabel, type Conversation } from "../../lib/conversations";
import { ALT, MOD } from "../../lib/keys";
import { modPressed, overlayOpen } from "../../lib/platform";
import { useDrafts } from "../../store/drafts";
import { can, touchTimeline, useMachines } from "../../store/machines";
import { usePrefs } from "../../store/prefs";
import { useSeen } from "../../store/seen";
import { useUi } from "../../store/ui";
import { Button, IconButton, Kbd, Spinner } from "../ui/Button";
import { Menu, MenuItem, MenuSeparator } from "../ui/Menu";
import { AgentIcon, Badge } from "../ui/Status";
import { openInTerminal } from "../panel/TerminalTab";
import { ApprovalCard } from "./ApprovalCard";
import { Composer } from "./Composer";
import { buildTurns, type TurnRow } from "./turns";
import { AwayBar, PlanBar, QueuedMessages, TurnRowView } from "./TurnRows";

const BASE_INDEX = 1_000_000;

/** Away summaries closed by the user (`<conversation>:<item n>`), until restart. */
const dismissedAway = new Set<string>();

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
  const working = agent?.attention.status === "working";
  const rows = useMemo(() => buildTurns(items, working), [items, working]);
  const retry = () => void loadTimeline(conv.key);
  const showApproval = !!agent?.interaction && needsYou(agent.attention);
  // The turn ended on a question: the answer is a message, no card.
  const asked = !!agent && askedYou(agent.attention);

  // On screen in the focused window: read up to its last activity.
  const markSeen = useSeen((s) => s.markSeen);
  const seenId = archiveId(conv);
  useEffect(() => {
    const at = conv.lastActivity;
    if (!at) return;
    const mark = () => document.hasFocus() && markSeen(seenId, at);
    mark();
    window.addEventListener("focus", mark);
    return () => window.removeEventListener("focus", mark);
  }, [seenId, conv.lastActivity, markSeen]);
  // Waiting ones show above the composer; sent ones until the transcript has them.
  const queued = useMemo(() => (agent?.queued ?? []).filter((q) => q.state !== "waiting"), [agent?.queued]);
  // Latest plan, pinned while it has unfinished tasks.
  const plan = useMemo(() => {
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i];
      if (it.type === "todos_updated") return it.todos;
    }
    return null;
  }, [items]);
  const showPlan = !!agent && !!plan?.length && plan.some((t) => t.status !== "completed");
  // Latest recap, until the user writes again or closes it.
  const [, setDismissed] = useState(0);
  const away = useMemo(() => {
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i];
      if (it.type === "user_message") return null;
      if (it.type === "away_summary") return it;
    }
    return null;
  }, [items]);
  const awayId = away ? `${conv.key}:${away.n}` : null;

  return (
    <div className="flex h-full min-w-0 flex-col">
      <Header conv={conv} />
      {away && awayId && !dismissedAway.has(awayId) && (
        <AwayBar
          key={awayId}
          text={away.text}
          onDismiss={() => {
            dismissedAway.add(awayId);
            setDismissed((d) => d + 1);
          }}
        />
      )}
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
        {timeline?.loaded && !timeline.error && items.length === 0 && queued.length === 0 && !showApproval && (
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
        {(items.length > 0 || queued.length > 0 || showApproval) && (
          <TimelineList
            convKey={conv.key}
            rows={rows}
            kind={conv.kind}
            machineId={conv.machineId}
            agent={agent}
            working={working}
            approval={showApproval}
            asked={asked}
            queued={queued}
            hasMore={!!timeline?.hasMore}
            olderInHistory={!!timeline?.olderInHistory}
            loadingOlder={!!timeline?.loading}
            onTop={() => void loadTimeline(conv.key, true)}
          />
        )}
      </div>
      {showPlan && <PlanBar todos={plan!} />}
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
  olderInHistory: boolean;
  loadingOlder: boolean;
  working: boolean;
  machineId: string;
  agent?: AgentView;
  approval: boolean;
  asked: boolean;
  queued: QueuedMessage[];
}

function ListHeader({ context }: { context?: ListContext }) {
  const agent = context?.agent;
  const history = !context?.hasMore && context?.olderInHistory && agent?.native_session;
  return (
    <div className="flex h-10 items-end justify-center pb-1 text-[11.5px] text-faint">
      {context?.hasMore ? (
        context.loadingOlder ? <Spinner /> : "…"
      ) : history ? (
        <button onClick={() => useUi.getState().select(historyKey(context.machineId, `${agent.kind}:${agent.native_session}`))} className="hover:text-text">
          Earlier messages are in the history →
        </button>
      ) : (
        "Start of the conversation"
      )}
    </div>
  );
}

/** End of the conversation: messages waiting to be read, then the agent's prompt. */
function ListFooter({ context }: { context?: ListContext }) {
  const agent = context?.agent;
  return (
    <div className="pb-6">
      <div className="mx-auto max-w-[800px]">
        {context && <QueuedMessages queued={context.queued} working={context.working} />}
        {context?.asked && !context.queued.length && (
          <div className="flex items-center gap-1.5 px-6 pt-3 text-[12.5px] text-muted">
            <MessageCircleReply size={13} />
            Your turn: answer below
          </div>
        )}
        {agent && context?.approval && agent.interaction && (
          <div className="px-6 pt-4">
            <ApprovalCard key={agent.interaction.id} machineId={context.machineId} agent={agent} />
          </div>
        )}
      </div>
    </div>
  );
}

const LIST_COMPONENTS = { Header: ListHeader, Footer: ListFooter };

function TimelineList({
  convKey,
  rows,
  kind,
  machineId,
  agent,
  working,
  approval,
  asked,
  queued,
  hasMore,
  olderInHistory,
  loadingOlder,
  onTop,
}: {
  convKey: string;
  rows: TurnRow[];
  kind: string;
  machineId: string;
  agent?: AgentView;
  working: boolean;
  /** The agent's prompt shows at the end of the list. */
  approval: boolean;
  asked: boolean;
  queued: QueuedMessage[];
  hasMore: boolean;
  olderInHistory: boolean;
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
  const context = useMemo(
    () => ({ hasMore, olderInHistory, loadingOlder, working, machineId, agent, approval, asked, queued }),
    [hasMore, olderInHistory, loadingOlder, working, machineId, agent, approval, asked, queued],
  );

  // Rows are measured after they render (markdown, open work blocks), so the
  // first position is only an estimate: keep pinning the bottom after opening
  // a conversation until the user scrolls.
  const settling = useRef(true);
  useEffect(() => {
    settling.current = true;
  }, [convKey]);
  const toBottom = () => ref.current?.scrollTo({ top: Number.MAX_SAFE_INTEGER });
  const stopSettling = () => {
    settling.current = false;
  };

  // The prompt or a queued message appearing must not push the last
  // messages out of view: stay at the bottom if we were there.
  useEffect(() => {
    if (!atBottomRef.current && !settling.current) return;
    const frame = requestAnimationFrame(toBottom);
    return () => cancelAnimationFrame(frame);
  }, [working, approval, asked, queued.length]);

  return (
    <>
      <Virtuoso
        key={convKey}
        ref={ref}
        className="h-full"
        data={rows}
        context={context}
        firstItemIndex={firstItemIndex}
        initialTopMostItemIndex={{ index: "LAST", align: "end" }}
        computeItemKey={(_, row) => row.key}
        followOutput={(bottom) => (bottom ? "smooth" : false)}
        // Rows growing (a long answer rendered, the live work block) keep the bottom in view.
        totalListHeightChanged={() => {
          if (settling.current || atBottomRef.current) requestAnimationFrame(toBottom);
        }}
        onWheel={stopSettling}
        onTouchMove={stopSettling}
        onKeyDown={stopSettling}
        onPointerDown={stopSettling}
        atBottomStateChange={setAtBottom}
        atBottomThreshold={80}
        startReached={() => hasMore && !loadingOlder && onTop()}
        increaseViewportBy={{ top: 600, bottom: 300 }}
        components={LIST_COMPONENTS}
        itemContent={(_, row) => (
          <div className="mx-auto max-w-[800px]">
            <TurnRowView row={row} kind={kind} machineId={machineId} agent={agent} />
          </div>
        )}
      />
      {!atBottom && (
        <button
          onClick={() => ref.current?.scrollTo({ top: Number.MAX_SAFE_INTEGER, behavior: "smooth" })}
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
  const { stop } = useStop(conv.machineId, agent);
  const parent = useMachines((s) => (agent?.parent_id ? s.machines[conv.machineId]?.snapshot?.agents.find((a) => a.id === agent.parent_id) : undefined));
  const select = useUi((s) => s.select);
  const archived = usePrefs((s) => s.archived.includes(archiveId(conv)));
  const setArchived = usePrefs((s) => s.setArchived);

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

  // Working shows in the conversation itself; the header only flags what needs a look.
  const flag = stale ? <Badge>Offline</Badge> : needsYou(conv.attention) ? <Badge tone="blocked">{statusLabel(conv.attention)}</Badge> : null;

  return (
    <div className="drag flex h-[52px] shrink-0 items-center gap-3 px-5">
      <div className="no-drag flex min-w-0 flex-1 items-center gap-1.5">
        {parent && (
          <>
            <button
              onClick={() => select(liveKey(conv.machineId, parent.id))}
              className="min-w-0 max-w-[30%] shrink truncate text-[14px] text-muted hover:text-text"
              title="Open the agent that started this one"
            >
              {agentTitle(parent)}
            </button>
            <ChevronRight size={13} className="shrink-0 text-faint" />
          </>
        )}
        <Menu
          align="start"
          trigger={
            <button className="flex min-w-0 items-center gap-1.5 rounded-lg px-2 py-1 hover:bg-surface-high" title={subtitle}>
              <AgentIcon kind={conv.kind} size={14} />
              <h1 className="truncate text-[14px] font-medium">{conv.title}</h1>
              <ChevronDown size={14} className="shrink-0 text-faint" />
            </button>
          }
        >
          <div className="max-w-[320px] px-2.5 pb-1.5 pt-1 text-[11.5px] text-faint">{subtitle}</div>
          <MenuSeparator />
          {conv.cwd && (
            <MenuItem icon={<SquareTerminal size={14} />} onSelect={() => setPanelTab("terminal", "shell")}>
              Open terminal
            </MenuItem>
          )}
          {agent && (
            <MenuItem icon={<Monitor size={14} />} onSelect={() => setPanelTab("terminal", "agent")}>
              Show agent screen
            </MenuItem>
          )}
          {conv.local && conv.cwd && (
            <MenuItem icon={<FolderOpen size={14} />} onSelect={() => void openPath(conv.cwd!).catch((e) => toast(errorMessage(e), "error"))}>
              Open project folder
            </MenuItem>
          )}
          {conv.local && conv.cwd && (
            <MenuItem icon={<SquareArrowOutUpRight size={14} />} onSelect={() => openInTerminal(conv.cwd!)}>
              Open in Terminal
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
          <MenuItem icon={archived ? <ArchiveRestore size={14} /> : <Archive size={14} />} onSelect={() => setArchived(archiveId(conv), !archived)}>
            {archived ? "Unarchive" : "Archive"}
          </MenuItem>
          <MenuSeparator />
          <MenuItem icon={<PanelRight size={14} />} onSelect={togglePanel}>
            {showPanel ? "Hide panel" : "Show panel"} <span className="ml-auto pl-4"><Kbd>{MOD}{ALT}B</Kbd></span>
          </MenuItem>
        </Menu>
        {flag}
      </div>
      <div className="no-drag flex shrink-0 items-center gap-1">
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
  const prompt = useDrafts((s) => s.drafts[conv.key]?.text ?? "");
  const setPrompt = (text: string) => useDrafts.getState().setText(conv.key, text);
  const [busy, setBusy] = useState(false);
  const allowed = can(machine, "agents.resume");
  const online = machine?.status.state === "online";

  const resume = async () => {
    if (!conv.historyId) return;
    setBusy(true);
    try {
      const r = await api.resume(conv.machineId, conv.historyId, { prompt: prompt.trim() });
      toast(r.already_running ? "This conversation is already running" : "Conversation resumed in Herdr", "success");
      useDrafts.getState().clear(conv.key);
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
    <div className="mx-auto w-full max-w-[800px] px-6 pb-5">
      <form
        className="flex items-center gap-2 rounded-[22px] border border-border bg-surface p-2 pl-4 shadow-[0_10px_30px_rgba(0,0,0,0.28)]"
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
          className="h-9 flex-1 bg-transparent text-[14px] placeholder:text-faint focus:outline-none"
        />
        <Button type="submit" variant="primary" icon={<Play size={14} />} loading={busy} disabled={!allowed || !online}>
          Resume
        </Button>
      </form>
    </div>
  );
}
