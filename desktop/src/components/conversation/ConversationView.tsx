import { openPath } from "@tauri-apps/plugin-opener";
import { ArrowDown, Copy, FolderOpen, History, MoreHorizontal, PanelRight, Play, Square, SquareTerminal } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import { api, app, errorMessage } from "../../api/client";
import { historyKey, liveKey, statusLabel, type Conversation } from "../../lib/conversations";
import { can, useMachines } from "../../store/machines";
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

  return (
    <div className="flex h-full min-w-0 flex-col">
      <Header conv={conv} />
      <div className="relative min-h-0 flex-1">
        {!timeline?.loaded && <div className="flex h-full items-center justify-center text-muted"><Spinner className="h-5 w-5" /></div>}
        {timeline?.loaded && timeline.error && items.length === 0 && (
          <div className="flex h-full items-center justify-center px-10 text-center text-[13px] text-muted">{timeline.error}</div>
        )}
        {timeline?.loaded && !timeline.error && items.length === 0 && (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-10 text-center">
            <AgentIcon kind={conv.kind} size={22} />
            <p className="text-[13px] text-muted">
              {agent && !agent.has_transcript
                ? agent.warnings.includes("missing_herdr_integration")
                  ? "Conversation illisible : installe l'intégration Herdr de cet agent (herdr integration install " + agent.kind + ") puis redémarre-le."
                  : "Pas encore de conversation. Écris un premier message."
                : "Pas encore de messages."}
            </p>
          </div>
        )}
        {items.length > 0 && (
          <TimelineList
            convKey={conv.key}
            rows={rows}
            kind={conv.kind}
            working={agent?.attention.status === "working"}
            hasMore={!!timeline?.hasMore}
            loadingOlder={!!timeline?.loading}
            onTop={() => void loadTimeline(conv.key, true)}
          />
        )}
      </div>
      {agent && agent.interaction && agent.attention.status === "blocked" && <ApprovalCard machineId={conv.machineId} agent={agent} />}
      {agent && agent.attention.status === "blocked" && agent.attention.reason === "explicit_question" && (
        <div className="mx-6 mb-2 flex items-center gap-2 text-[12px] text-blocked">
          <StatusDot attention={agent.attention} /> L'agent t'a posé une question : réponds ci-dessous.
        </div>
      )}
      {agent ? (
        <Composer machineId={conv.machineId} agent={agent} />
      ) : conv.history ? (
        <ResumeBar conv={conv} />
      ) : null}
      {machine && machine.status.state !== "online" && (
        <div className="border-t border-border bg-surface px-6 py-2 text-[12px] text-muted">
          {machine.record.name} est hors ligne{machine.status.error ? ` (${machine.status.error})` : ""} — reconnexion automatique…
        </div>
      )}
    </div>
  );
}

function TimelineList({
  convKey,
  rows,
  kind,
  working,
  hasMore,
  loadingOlder,
  onTop,
}: {
  convKey: string;
  rows: ReturnType<typeof buildRows>;
  kind: string;
  working: boolean;
  hasMore: boolean;
  loadingOlder: boolean;
  onTop: () => void;
}) {
  const ref = useRef<VirtuosoHandle>(null);
  const [atBottom, setAtBottom] = useState(true);
  // Rows prepended since the first load shift the first index, so Virtuoso
  // keeps the scroll position when older pages arrive.
  const anchor = useRef<{ conv: string; key: string } | null>(null);
  if (!anchor.current || anchor.current.conv !== convKey || !rows.some((r) => r.key === anchor.current!.key)) {
    anchor.current = { conv: convKey, key: rows[0]?.key ?? "" };
  }
  const prepended = Math.max(0, rows.findIndex((r) => r.key === anchor.current!.key));
  const firstItemIndex = BASE_INDEX - prepended;

  return (
    <>
      <Virtuoso
        key={convKey}
        ref={ref}
        className="h-full"
        data={rows}
        firstItemIndex={firstItemIndex}
        initialTopMostItemIndex={rows.length - 1}
        computeItemKey={(_, row) => row.key}
        followOutput={(bottom) => (bottom ? "smooth" : false)}
        atBottomStateChange={setAtBottom}
        atBottomThreshold={80}
        startReached={() => hasMore && !loadingOlder && onTop()}
        increaseViewportBy={{ top: 600, bottom: 300 }}
        components={{
          Header: () => (
            <div className="flex h-10 items-end justify-center pb-1 text-[11.5px] text-faint">
              {hasMore ? loadingOlder ? <Spinner /> : "…" : "Début de la conversation"}
            </div>
          ),
          Footer: () => (
            <div className="px-6 pb-6 pt-3">
              {working && (
                <div className="ml-[46px] flex items-center gap-2 text-[12.5px] text-working">
                  <span className="flex gap-1">
                    <span className="h-1.5 w-1.5 animate-pulse-dot rounded-full bg-working" />
                    <span className="h-1.5 w-1.5 animate-pulse-dot rounded-full bg-working [animation-delay:200ms]" />
                    <span className="h-1.5 w-1.5 animate-pulse-dot rounded-full bg-working [animation-delay:400ms]" />
                  </span>
                  Réfléchit…
                </div>
              )}
            </div>
          ),
        }}
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
          <ArrowDown size={13} /> Derniers messages
        </button>
      )}
    </>
  );
}

function Header({ conv }: { conv: Conversation }) {
  const { togglePanel, showPanel, setPanelTab, toast } = useUi();
  const machine = useMachines((s) => s.machines[conv.machineId]);
  const agent = conv.agent;
  const [stopping, setStopping] = useState(false);
  const working = agent?.attention.status === "working";

  const stop = async () => {
    if (!agent) return;
    setStopping(true);
    try {
      await api.interrupt(conv.machineId, agent.id);
    } catch (e) {
      toast(errorMessage(e), "error");
    } finally {
      setStopping(false);
    }
  };

  // ⌘. interrupts the agent on screen.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey && e.key === ".") {
        e.preventDefault();
        if (working) void stop();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const subtitle = [conv.project, conv.machineName, agent ? `session ${agent.session}` : "archivée"].filter(Boolean).join(" · ");

  return (
    <div className="drag flex h-[52px] shrink-0 items-center gap-3 border-b border-border px-5">
      <div className="no-drag flex min-w-0 flex-1 items-center gap-3">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-border bg-surface">
          <AgentIcon kind={conv.kind} size={15} />
        </span>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h1 className="truncate text-[14.5px] font-semibold">{conv.title}</h1>
            <StatusDot attention={conv.attention} />
          </div>
          <div className="truncate text-[11.5px] text-faint">{subtitle}</div>
        </div>
      </div>
      <div className="no-drag flex shrink-0 items-center gap-2">
        {agent?.model && (
          <span className="hidden items-center gap-1.5 rounded-[10px] border border-border px-2.5 py-1.5 text-[12px] text-muted xl:flex">
            <AgentIcon kind={conv.kind} size={12} />
            <span>{agent.model.replace(/^claude-/, "")}</span>
            <span className="text-faint">sur {conv.machineName}</span>
          </span>
        )}
        <Badge tone={attentionTone(conv.attention)}>{statusLabel(conv.attention)}</Badge>
        {agent && (
          <Button
            size="md"
            variant="secondary"
            icon={<Square size={13} />}
            disabled={!working || !can(machine, "agents.interrupt")}
            loading={stopping}
            onClick={() => void stop()}
            title="Interrompre l'agent (⌘.)"
          >
            Stop
          </Button>
        )}
        <Menu
          trigger={
            <button className="flex h-9 w-9 items-center justify-center rounded-[10px] border border-border text-muted hover:bg-surface-high hover:text-text" aria-label="Plus d'actions">
              <MoreHorizontal size={16} />
            </button>
          }
        >
          {agent && (
            <MenuItem icon={<SquareTerminal size={14} />} onSelect={() => setPanelTab("terminal")}>
              Ouvrir le terminal
            </MenuItem>
          )}
          {conv.local && conv.cwd && (
            <MenuItem icon={<FolderOpen size={14} />} onSelect={() => void openPath(conv.cwd!).catch((e) => toast(errorMessage(e), "error"))}>
              Ouvrir le dossier du projet
            </MenuItem>
          )}
          {agent?.native_session && (
            <MenuItem
              icon={<History size={14} />}
              onSelect={() => useUi.getState().select(historyKey(conv.machineId, `${agent.kind}:${agent.native_session}`))}
            >
              Voir dans l'historique
            </MenuItem>
          )}
          <MenuItem
            icon={<Copy size={14} />}
            onSelect={() => {
              void navigator.clipboard.writeText(agent?.native_session ? `${agent.kind} --resume ${agent.native_session}` : (conv.agentId ?? conv.historyId ?? ""));
              toast("Copié");
            }}
          >
            {agent?.native_session ? "Copier la commande de reprise" : "Copier l'identifiant"}
          </MenuItem>
          <MenuSeparator />
          <MenuItem icon={<PanelRight size={14} />} onSelect={togglePanel}>
            {showPanel ? "Masquer le panneau" : "Afficher le panneau"} <span className="ml-auto pl-4"><Kbd>⌘⌥B</Kbd></span>
          </MenuItem>
        </Menu>
        {!showPanel && (
          <IconButton label="Afficher le panneau" onClick={togglePanel}>
            <PanelRight size={15} />
          </IconButton>
        )}
      </div>
    </div>
  );
}

function ResumeBar({ conv }: { conv: Conversation }) {
  const machine = useMachines((s) => s.machines[conv.machineId]);
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
      toast(r.already_running ? "Cette conversation tourne déjà" : "Conversation reprise dans Herdr", "success");
      select(liveKey(conv.machineId, r.agent_id));
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
            !allowed ? "Cet appareil ne peut pas reprendre de conversation" : !online ? "Machine hors ligne" : "Conversation archivée — reprendre avec un message (facultatif)…"
          }
          className="flex-1 bg-transparent text-[13px] placeholder:text-faint focus:outline-none"
        />
        <Button type="submit" variant="primary" icon={<Play size={14} />} loading={busy} disabled={!allowed || !online}>
          Reprendre
        </Button>
      </form>
    </div>
  );
}
