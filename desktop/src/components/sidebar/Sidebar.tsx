import { openPath } from "@tauri-apps/plugin-opener";
import { Archive, ArchiveRestore, ArrowDown, ArrowUp, Check, ChevronDown, ChevronRight, Clock, Copy, Eye, Folder, FolderOpen, History, Layers, Monitor, Plus, Puzzle, Search, Server, Settings, SlidersHorizontal, Square, SquareArrowOutUpRight, SquarePen, SquareTerminal, Star, ArrowUpRight, Boxes } from "lucide-react";
import { memo, useEffect, useMemo, useRef } from "react";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import { errorMessage } from "../../api/client";
import { openInTerminal } from "../panel/TerminalTab";
import type { MachineView } from "../../api/types";
import { useConversations } from "../../hooks/useConversations";
import { useUnread } from "../../hooks/useUnread";
import { useStop } from "../../hooks/useStop";
import { isMac } from "../../lib/platform";
import { archiveId, askedYou, buildSidebarRows, needsYou, compactAge, historyKey, longDate, projectKey, statusLabel, treeCollapsedId, treeExpandedId, type Conversation, type ConvTree, type SidebarRow } from "../../lib/conversations";
import { MOD } from "../../lib/keys";
import { orderMachines, spaceLabel, spaceMachineIds, type Space } from "../../lib/spaces";
import { machineList, useMachines } from "../../store/machines";
import { usePrefs } from "../../store/prefs";
import { useSettings } from "../../store/settings";
import { useUi, type View } from "../../store/ui";
import { IconButton } from "../ui/Button";
import { LimitsGauge, MachinesLimitsGauge } from "../ui/Limits";
import { Logo } from "../ui/Logo";
import { ContextMenu, Menu, MenuItem, MenuSeparator } from "../ui/Menu";
import { MachineDot, StatusDot, agentLabel } from "../ui/Status";
import { UpdateBanner } from "./UpdateBanner";

/** Conversations per project before "Show more". */
const PROJECT_LIMIT = 5;

export function Sidebar() {
  const conversations = useConversations();
  const machinesById = useMachines((s) => s.machines);
  const ready = useMachines((s) => s.ready);
  const { view, setView, selected, setPalette, openNewSession, setVisibleKeys } = useUi();
  const grouping = useSettings((s) => s.settings.grouping);
  const prefs = usePrefs();
  const machines = useMemo(() => orderMachines(machineList(machinesById), prefs.machineOrder), [machinesById, prefs.machineOrder]);

  // Machines of the current space; a space that no longer exists (forgotten
  // machine, deleted group) falls back to all machines.
  const allIds = machines.map((m) => m.record.machine_id);
  const spaceIds = spaceMachineIds(prefs.space, allIds, prefs.groups);
  useEffect(() => {
    if (ready && spaceIds === null) prefs.setSpace({ kind: "all" });
  }, [ready, spaceIds === null]); // eslint-disable-line react-hooks/exhaustive-deps
  const ids = spaceIds ?? allIds;
  const idsKey = ids.join(",");
  const spaceMachines = useMemo(
    () => machines.filter((m) => ids.includes(m.record.machine_id)).map((m) => ({ id: m.record.machine_id, name: m.record.name })),
    // Names and order only: latency pings must not rebuild the rows.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [idsKey, machines.map((m) => m.record.name).join("\n")],
  );

  const filtered = useMemo(() => {
    const set = new Set(idsKey.split(","));
    const archived = new Set(prefs.archived);
    // An archived agent that needs an answer still shows.
    const hidden = (c: (typeof conversations)[number]) => !prefs.showArchived && archived.has(archiveId(c)) && !needsYou(c.attention);
    return conversations.filter((c) => set.has(c.machineId) && (prefs.showPast || c.live) && !hidden(c));
  }, [conversations, idsKey, prefs.showPast, prefs.showArchived, prefs.archived]);
  const collapsed = useMemo(() => new Set(prefs.collapsed), [prefs.collapsed]);
  const favorites = useMemo(() => new Set(prefs.favorites), [prefs.favorites]);
  const unreadKeys = useUnread(conversations);
  const unread = useMemo(() => new Set(unreadKeys), [unreadKeys]);
  const rows = useMemo(
    () =>
      buildSidebarRows(filtered, {
        grouping,
        machines: spaceMachines,
        collapsed,
        favorites,
        projectOrder: prefs.projectOrder,
        inactiveDays: prefs.inactiveDays,
        showInactive: prefs.showInactive,
        projectLimit: PROJECT_LIMIT,
        selected,
        unread,
      }),
    [filtered, grouping, spaceMachines, collapsed, favorites, prefs.projectOrder, prefs.inactiveDays, prefs.showInactive, selected, unread],
  );
  // Every machine, so that a hidden space needing attention still shows.
  const waitingKeys = useMemo(() => conversations.filter((c) => needsYou(c.attention)).map((c) => c.key), [conversations]);
  const waiting = waitingKeys.length;

  // Alt+↑/↓ walks what the sidebar shows (pinned waiting rows first, once).
  const visibleKeys = useMemo(() => [...new Set(rows.flatMap((r) => (r.type === "conv" ? [r.conv.key] : [])))], [rows]);
  useEffect(() => setVisibleKeys(visibleKeys), [visibleKeys, setVisibleKeys]);

  // Reveal the selected conversation: expand its machine and project, scroll to it.
  const list = useRef<VirtuosoHandle>(null);
  const selectedConv = useMemo(() => conversations.find((c) => c.key === selected), [conversations, selected]);
  useEffect(() => {
    if (!selectedConv) return;
    if (grouping === "project") prefs.expand([`m:${selectedConv.machineId}`, `p:${projectKey(selectedConv.machineId, selectedConv.project)}`]);
  }, [selected]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const index = rows.findIndex((r) => r.type === "conv" && r.conv.key === selected);
    if (index !== -1) list.current?.scrollIntoView({ index, behavior: "auto" });
  }, [selected, rows.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const nav: { id: View; label: string; icon: React.ReactNode }[] = [
    { id: "history", label: "History", icon: <Clock size={15} /> },
    { id: "servers", label: "Servers", icon: <Server size={15} /> },
    { id: "skills", label: "Skills", icon: <Puzzle size={15} /> },
    { id: "settings", label: "Settings", icon: <Settings size={15} /> },
  ];
  const active = view === "conversations" ? selected : null;

  return (
    <aside className="@container flex h-full flex-col border-r border-border bg-surface">
      {/* Title bar area: on macOS the traffic lights sit on the left. */}
      <div className={`drag flex h-[52px] shrink-0 items-center gap-2 pr-2 ${isMac ? "pl-[86px]" : "pl-3"}`}>
        <div className="no-drag flex min-w-0 items-center gap-2">
          <Logo size={22} />
          <span className={`truncate text-[14px] font-semibold tracking-tight ${isMac ? "hidden @min-[300px]:inline" : ""}`}>Huntaway</span>
        </div>
        <div className="no-drag ml-auto flex items-center gap-0.5">
          {nav.map((n) => (
            <IconButton key={n.id} label={n.label} active={view === n.id} onClick={() => setView(view === n.id ? "conversations" : n.id)}>
              {n.icon}
            </IconButton>
          ))}
        </div>
      </div>

      <div className="shrink-0 px-1.5 pb-2">
        <NavRow icon={<SquarePen size={15} />} label="New session" shortcut={`${MOD}${isMac ? "" : "+"}N`} onClick={() => openNewSession()} />
        <NavRow icon={<Search size={15} />} label="Search" shortcut={`${MOD}${isMac ? "" : "+"}K`} onClick={() => setPalette(true)} />
      </div>

      <div className="flex shrink-0 items-center gap-1 px-2 pb-1">
        <SpaceMenu machines={machines} />
        {waiting > 0 && <JumpPill keys={waitingKeys} selected={selected} tone="waiting" />}
        {unreadKeys.length > 0 && <JumpPill keys={unreadKeys} selected={selected} tone="unread" />}
        <DisplayMenu />
        {!rows.some((r) => r.type === "machine") && (
          <span className="ml-auto pr-1">
            <MachinesLimitsGauge machines={spaceMachines} />
          </span>
        )}
      </div>

      <div className="min-h-0 flex-1 pt-1">
        {rows.length === 0 ? (
          <p className="px-4 py-6 text-[12.5px] leading-relaxed text-faint">
            {machines.length === 0 ? "No machine connected." : spaceMachines.length === 0 ? "No machine in this space." : "No conversations yet. Start a session to begin."}
          </p>
        ) : (
          <Virtuoso
            ref={list}
            data={rows}
            computeItemKey={(_, row) => row.id}
            itemContent={(_, row) => <Row row={row} active={active} machines={machinesById} unread={unread} />}
          />
        )}
      </div>

      <UpdateBanner />
    </aside>
  );
}

function Row({ row, active, machines, unread }: { row: SidebarRow; active: string | null; machines: Record<string, MachineView>; unread: ReadonlySet<string> }) {
  switch (row.type) {
    case "header":
      return (
        <div className={`flex h-8 items-end px-4 pb-1 text-[12px] font-medium ${row.waiting ? "text-blocked" : "text-faint"}`}>
          {row.label}
        </div>
      );
    case "machine":
      return <MachineRow row={row} machine={machines[row.machineId]} />;
    case "project":
      return <ProjectRow row={row} />;
    case "conv":
      return <ConversationRow conv={row.conv} active={active === row.conv.key} unread={unread.has(row.conv.key)} depth={row.depth} suffix={row.suffix} tree={row.tree} />;
    case "more":
      return (
        <div className="px-1.5">
          <button
            onClick={() => usePrefs.getState().toggleCollapsed(row.id)}
            className="flex h-8 w-full items-center rounded-lg text-left text-[13px] text-faint hover:bg-surface-high/50 hover:text-muted"
            style={indent(row.depth + 0.6)}
          >
            <span className="w-5 shrink-0" />
            {row.showing ? "Show less" : "Show more"}
          </button>
        </div>
      );
    case "inactive":
      return (
        <button
          onClick={() => usePrefs.getState().setShowInactive(!row.showing)}
          className="flex h-7 w-full items-center gap-2 px-3.5 text-left text-[11.5px] text-faint hover:text-muted"
        >
          <Eye size={12} />
          {row.showing ? "Hide inactive projects" : `${row.hidden} inactive project${row.hidden > 1 ? "s" : ""} hidden`}
        </button>
      );
  }
}

const indent = (depth: number) => ({ paddingLeft: 8 + depth * 12 });

function NavRow({ icon, label, shortcut, onClick }: { icon: React.ReactNode; label: string; shortcut: string; onClick: () => void }) {
  return (
    <button onClick={onClick} className="group flex h-8 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-[13.5px] text-text hover:bg-surface-high/60">
      <span className="text-muted">{icon}</span>
      <span className="flex-1 truncate">{label}</span>
      <span className="text-[11px] text-faint opacity-0 group-hover:opacity-100">{shortcut}</span>
    </button>
  );
}

/** Waiting conversations; the total only on hover. */
function Count({ count, waiting, unread = 0 }: { count: number; waiting: number; unread?: number }) {
  return (
    <span className="flex shrink-0 items-center gap-1.5">
      {unread > 0 && <span className="h-1.5 w-1.5 rounded-full bg-done" title={`${unread} unread`} />}
      {waiting > 0 && <span className="rounded bg-blocked px-1 text-[10.5px] font-semibold leading-4 text-ink">{waiting}</span>}
      <span className="hidden w-5 text-right text-[11px] tabular-nums text-faint group-hover:inline">{count}</span>
    </span>
  );
}

const MachineRow = memo(function MachineRow({ row, machine }: { row: Extract<SidebarRow, { type: "machine" }>; machine?: MachineView }) {
  const toggle = usePrefs((s) => s.toggleCollapsed);
  const setSpace = usePrefs((s) => s.setSpace);
  const state = machine?.status.state ?? "offline";
  return (
    <div className="group px-1.5">
      <div className="mt-2 flex h-8 items-center gap-1.5 rounded-lg pr-1.5 hover:bg-surface-high/50" style={indent(0)}>
        <button onClick={() => toggle(row.id)} className="flex min-w-0 flex-1 items-center gap-1.5 text-left" aria-expanded={!row.collapsed}>
          {row.collapsed ? <ChevronRight size={13} className="shrink-0 text-faint" /> : <ChevronDown size={13} className="shrink-0 text-faint" />}
          {machine?.record.local ? <Monitor size={13} className="shrink-0 text-muted" /> : <Server size={13} className="shrink-0 text-muted" />}
          <span className={`min-w-0 truncate text-[12.5px] font-medium ${state === "online" ? "text-text" : "text-muted"}`}>{row.name}</span>
          <MachineDot state={state} slow={(machine?.status.latency_ms ?? 0) > 400} />
        </button>
        <button
          onClick={() => setSpace({ kind: "machine", id: row.machineId })}
          className="hidden shrink-0 text-faint hover:text-text group-hover:block"
          title="Show only this machine"
          aria-label="Show only this machine"
        >
          <ArrowUpRight size={13} />
        </button>
        <LimitsGauge machineId={row.machineId} title={row.name} />
        <Count count={row.count} waiting={row.waiting} />
      </div>
    </div>
  );
});

const ProjectRow = memo(function ProjectRow({ row }: { row: Extract<SidebarRow, { type: "project" }> }) {
  const toggle = usePrefs((s) => s.toggleCollapsed);
  const toggleFavorite = usePrefs((s) => s.toggleFavorite);
  const openProject = useUi((s) => s.openProject);
  const key = projectKey(row.machineId, row.project);
  return (
    <ContextMenu content={<ProjectMenu row={row} projectId={key} />}>
      <div className="group px-1.5">
        <div className="mt-1.5 flex h-8 items-center gap-1.5 rounded-lg pr-1.5 hover:bg-surface-high/50" style={indent(row.depth)}>
          <button onClick={() => toggle(row.id)} className="flex min-w-0 flex-1 items-center gap-2.5 text-left" aria-expanded={!row.collapsed}>
            {row.collapsed ? <Folder size={15} className="shrink-0 text-faint" /> : <FolderOpen size={15} className="shrink-0 text-faint" />}
            <span className="min-w-0 truncate text-[13.5px] text-muted">{row.project}</span>
          </button>
          <span className={`shrink-0 items-center gap-1 ${row.favorite ? "flex" : "hidden group-hover:flex"}`}>
            <button
              onClick={() => toggleFavorite(key)}
              className={row.favorite ? "text-blocked" : "text-faint hover:text-text"}
              title={row.favorite ? "Remove from favorites" : "Add to favorites"}
              aria-label={row.favorite ? "Remove from favorites" : "Add to favorites"}
            >
              <Star size={12} fill={row.favorite ? "currentColor" : "none"} />
            </button>
          </span>
          <button
            onClick={() => openProject(row.machineId, row.project)}
            className="hidden shrink-0 text-faint hover:text-text group-hover:block"
            title="Open project"
            aria-label="Open project"
          >
            <ArrowUpRight size={13} />
          </button>
          <Count count={row.count} waiting={row.waiting} unread={row.collapsed ? row.unread : 0} />
        </div>
      </div>
    </ContextMenu>
  );
});

/** Right click on a project. */
function ProjectMenu({ row, projectId }: { row: Extract<SidebarRow, { type: "project" }>; projectId: string }) {
  const { toggleFavorite, moveProject } = usePrefs();
  const openProject = useUi((s) => s.openProject);
  const i = row.siblings.indexOf(projectId);
  return (
    <>
      <MenuItem icon={<ArrowUp size={14} />} disabled={i <= 0} onSelect={() => moveProject(projectId, row.siblings, -1)}>
        Move up
      </MenuItem>
      <MenuItem icon={<ArrowDown size={14} />} disabled={i === -1 || i >= row.siblings.length - 1} onSelect={() => moveProject(projectId, row.siblings, 1)}>
        Move down
      </MenuItem>
      <MenuSeparator />
      <MenuItem icon={<Star size={14} />} onSelect={() => toggleFavorite(projectId)}>
        {row.favorite ? "Remove from favorites" : "Add to favorites"}
      </MenuItem>
      <MenuItem icon={<ArrowUpRight size={14} />} onSelect={() => openProject(row.machineId, row.project)}>
        Open project
      </MenuItem>
      {row.local && row.cwd && (
        <MenuItem icon={<SquareArrowOutUpRight size={14} />} onSelect={() => openInTerminal(row.cwd!)}>
          Open in Terminal
        </MenuItem>
      )}
    </>
  );
}

const ConversationRow = memo(function ConversationRow({
  conv,
  active,
  unread,
  depth,
  suffix,
  tree,
}: {
  conv: Conversation;
  active: boolean;
  unread: boolean;
  depth: number;
  suffix?: string;
  tree?: ConvTree;
}) {
  // An offline machine's last known status is stale: grey it out.
  const offline = useMachines((s) => s.machines[conv.machineId]?.status.state !== "online");
  // Folded: the most urgent state of the agents it started shows on it.
  const own = tree && !tree.expanded ? tree.rollup : conv.attention;
  const attention = offline && conv.live ? null : own;
  const blocked = needsYou(attention);
  const asked = askedYou(attention);
  const archived = usePrefs((s) => s.archived.includes(archiveId(conv)));
  const toggleTree = () => {
    if (!tree) return;
    const { collapsed, toggleCollapsed } = usePrefs.getState();
    const c = treeCollapsedId(conv.key);
    const x = treeExpandedId(conv.key);
    if (collapsed.includes(c)) toggleCollapsed(c);
    if (collapsed.includes(x)) toggleCollapsed(x);
    toggleCollapsed(tree.expanded ? c : x);
  };
  return (
    <ContextMenu content={<ConversationMenu conv={conv} archived={archived} />}>
      <div className={`px-1.5 ${archived ? "opacity-60" : ""}`}>
        <div
          className={`group flex h-8 w-full items-center rounded-lg pr-2 transition-colors [[data-state=open]>&]:bg-surface-high/50 ${
            blocked ? (active ? "bg-blocked/25" : "bg-blocked/12 hover:bg-blocked/20") : active ? "bg-surface-high" : "hover:bg-surface-high/50"
          }`}
          style={indent(depth + (depth ? 0.6 : 0))}
        >
          {tree ? (
            <button
              onClick={toggleTree}
              className="flex h-7 w-4 shrink-0 items-center justify-center text-faint hover:text-text"
              aria-expanded={tree.expanded}
              aria-label={tree.expanded ? "Hide the agents it started" : "Show the agents it started"}
              title={`${tree.total} agent${tree.total > 1 ? "s" : ""} started by this one`}
            >
              {tree.expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            </button>
          ) : (
            depth > 0 && <span className="w-1 shrink-0" />
          )}
          <button
            onClick={() => useUi.getState().select(conv.key)}
            className="flex h-8 min-w-0 flex-1 items-center gap-2.5 text-left"
            title={`${conv.title}\n${conv.project} · ${conv.machineName}\n${agentLabel(conv.kind)} · ${offline && conv.live ? "Machine offline" : statusLabel(conv.attention)}${conv.lastActivity ? ` · ${longDate(conv.lastActivity)}` : ""}`}
          >
            {/* Only what needs a look gets a mark: waiting, working, unread. */}
            <span className="flex w-[15px] shrink-0 justify-center">
              {unread ? (
                <span className="h-[7px] w-[7px] rounded-full bg-done" aria-label="Unread" />
              ) : (
                attention && (attention.status === "working" || blocked) && <StatusDot attention={attention} size={7} />
              )}
            </span>
            <span
              className={`min-w-0 flex-1 truncate text-[13.5px] leading-5 ${
                blocked ? "text-[#f3d2ab]" : unread ? "font-medium text-[#d9d5ce]" : conv.live ? (active ? "text-text" : "text-[#d9d5ce]") : "text-muted"
              }`}
            >
              {conv.title}
            </span>
            {suffix && <span className="min-w-0 max-w-[40%] shrink truncate text-[11px] text-faint">{suffix}</span>}
            {tree && !tree.expanded && (
              <span className={`shrink-0 rounded px-1 text-[10.5px] leading-4 tabular-nums ${blocked ? "bg-blocked font-semibold text-ink" : "bg-surface-high text-muted"}`}>{tree.total}</span>
            )}
            {blocked ? (
              <span className="shrink-0 text-[11px] font-medium text-blocked">Waiting</span>
            ) : unread && asked ? (
              <span className="shrink-0 text-[11px] text-done">Asked you</span>
            ) : (
              <span className={`w-8 shrink-0 text-right text-[11px] tabular-nums text-faint ${active ? "" : "hidden group-hover:inline"}`}>{compactAge(conv.lastActivity)}</span>
            )}
          </button>
        </div>
      </div>
    </ContextMenu>
  );
});

/** Right click on a conversation. Rendered only while open. */
function ConversationMenu({ conv, archived }: { conv: Conversation; archived: boolean }) {
  const { select, setPanelTab, toast } = useUi();
  const setArchived = usePrefs((s) => s.setArchived);
  const agent = conv.agent;
  const { canStop, stop } = useStop(conv.machineId, agent);
  return (
    <>
      {conv.cwd && (
        <MenuItem
          icon={<SquareTerminal size={14} />}
          onSelect={() => {
            select(conv.key);
            setPanelTab("terminal", "shell");
          }}
        >
          Open terminal
        </MenuItem>
      )}
      {agent && (
        <MenuItem
          icon={<Monitor size={14} />}
          onSelect={() => {
            select(conv.key);
            setPanelTab("terminal", "agent");
          }}
        >
          Show agent screen
        </MenuItem>
      )}
      {agent && canStop && (
        <MenuItem icon={<Square size={14} />} onSelect={() => void stop()}>
          Stop
        </MenuItem>
      )}
      {agent?.native_session && (
        <MenuItem icon={<History size={14} />} onSelect={() => select(historyKey(conv.machineId, `${agent.kind}:${agent.native_session}`))}>
          Show in history
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
      <MenuItem
        icon={<Copy size={14} />}
        onSelect={() => {
          const session = agent?.native_session ?? conv.history?.session_id;
          void navigator.clipboard.writeText(session ? `${conv.kind} --resume ${session}` : (conv.agentId ?? conv.historyId ?? ""));
          toast("Copied");
        }}
      >
        {agent?.native_session || conv.history ? "Copy resume command" : "Copy ID"}
      </MenuItem>
      <MenuSeparator />
      <MenuItem
        icon={archived ? <ArchiveRestore size={14} /> : <Archive size={14} />}
        onSelect={() => {
          setArchived(archiveId(conv), !archived);
          if (!archived) toast("Archived. Display options → Show archived to see it again.");
        }}
      >
        {archived ? "Unarchive" : "Archive"}
      </MenuItem>
    </>
  );
}

/**
 * Agents waiting on a prompt (orange), or unread finished turns (cream), on
 * every machine: each click opens the next one.
 */
function JumpPill({ keys, selected, tone }: { keys: string[]; selected: string | null; tone: "waiting" | "unread" }) {
  const next = keys[(keys.indexOf(selected ?? "") + 1) % keys.length];
  const waiting = tone === "waiting";
  return (
    <button
      onClick={() => useUi.getState().select(next)}
      className={`flex h-6 shrink-0 items-center gap-1.5 rounded-full px-2 text-[11.5px] font-medium ${
        waiting ? "bg-blocked/15 text-blocked hover:bg-blocked/25" : "bg-done/12 text-done hover:bg-done/20"
      }`}
      title={waiting ? "Open the next agent waiting for you" : "Open the next finished conversation you haven't seen"}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${waiting ? "bg-blocked animate-pulse-dot" : "bg-done"}`} />
      {keys.length} {waiting ? "waiting" : "unread"}
    </button>
  );
}

function SpaceMenu({ machines }: { machines: MachineView[] }) {
  const { space, groups, setSpace } = usePrefs();
  const { setView, openPair } = useUi();
  const is = (s: Space) => JSON.stringify(s) === JSON.stringify(space);
  const tick = (s: Space) => (is(s) ? <Check size={13} className="ml-auto text-muted" /> : null);
  return (
    <Menu
      align="start"
      trigger={
        <button className="flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-md px-1.5 text-[12.5px] text-text hover:bg-surface-high" aria-label="Space">
          {space.kind === "machine" ? <Server size={13} className="shrink-0 text-muted" /> : space.kind === "group" ? <Layers size={13} className="shrink-0 text-muted" /> : <Boxes size={13} className="shrink-0 text-muted" />}
          <span className="min-w-0 truncate font-medium">{spaceLabel(space, machines, groups)}</span>
          <ChevronDown size={12} className="shrink-0 text-faint" />
        </button>
      }
    >
      <MenuItem icon={<Boxes size={14} />} onSelect={() => setSpace({ kind: "all" })}>
        All machines {tick({ kind: "all" })}
      </MenuItem>
      {groups.length > 0 && <MenuSeparator />}
      {groups.map((g) => (
        <MenuItem key={g.id} icon={<Layers size={14} />} onSelect={() => setSpace({ kind: "group", id: g.id })}>
          <span className="truncate">{g.name}</span>
          <span className="text-[11px] text-faint">{g.machineIds.filter((id) => machines.some((m) => m.record.machine_id === id)).length}</span>
          {tick({ kind: "group", id: g.id })}
        </MenuItem>
      ))}
      {machines.length > 0 && <MenuSeparator />}
      {machines.map((m) => (
        <MenuItem key={m.record.machine_id} icon={<MachineDot state={m.status.state} slow={(m.status.latency_ms ?? 0) > 400} />} onSelect={() => setSpace({ kind: "machine", id: m.record.machine_id })}>
          <span className="truncate">{m.record.name}</span>
          {tick({ kind: "machine", id: m.record.machine_id })}
        </MenuItem>
      ))}
      <MenuSeparator />
      <MenuItem icon={<Layers size={14} />} onSelect={() => setView("settings")}>
        Edit groups…
      </MenuItem>
      <MenuItem icon={<Plus size={14} />} onSelect={() => openPair()}>
        Add machine
      </MenuItem>
    </Menu>
  );
}

function DisplayMenu() {
  const grouping = useSettings((s) => s.settings.grouping);
  const updateSettings = useSettings((s) => s.update);
  const { showPast, setShowPast, showArchived, setShowArchived, archived, showInactive, setShowInactive, inactiveDays } = usePrefs();
  const tick = (on: boolean) => (on ? <Check size={13} className="ml-auto text-muted" /> : null);
  return (
    <Menu
      trigger={
        <button className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-faint hover:bg-surface-high hover:text-text" aria-label="Display options" title="Display options">
          <SlidersHorizontal size={13} />
        </button>
      }
    >
      <MenuItem icon={<Server size={14} />} onSelect={() => void updateSettings({ grouping: "project" })}>
        Group by machine and project {tick(grouping === "project")}
      </MenuItem>
      <MenuItem icon={<Clock size={14} />} onSelect={() => void updateSettings({ grouping: "date" })}>
        Group by date {tick(grouping === "date")}
      </MenuItem>
      <MenuSeparator />
      <MenuItem icon={<History size={14} />} onSelect={() => setShowPast(!showPast)}>
        Show past conversations {tick(showPast)}
      </MenuItem>
      {archived.length > 0 && (
        <MenuItem icon={<Archive size={14} />} onSelect={() => setShowArchived(!showArchived)}>
          Show archived {tick(showArchived)}
        </MenuItem>
      )}
      {inactiveDays > 0 && (
        <MenuItem icon={<Eye size={14} />} onSelect={() => setShowInactive(!showInactive)}>
          Show inactive projects {tick(showInactive)}
        </MenuItem>
      )}
    </Menu>
  );
}
