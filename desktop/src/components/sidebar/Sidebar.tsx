import { Archive, Check, ChevronDown, ChevronRight, Clock, Eye, FolderGit2, Layers, Monitor, Plus, Puzzle, Search, Server, Settings, SlidersHorizontal, Star, ArrowUpRight, Boxes } from "lucide-react";
import { memo, useEffect, useMemo, useRef } from "react";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import type { MachineView } from "../../api/types";
import { useConversations } from "../../hooks/useConversations";
import { isMac } from "../../lib/platform";
import { buildSidebarRows, compactAge, longDate, projectKey, statusLabel, treeCollapsedId, treeExpandedId, type Conversation, type ConvTree, type SidebarRow } from "../../lib/conversations";
import { MOD } from "../../lib/keys";
import { orderMachines, spaceLabel, spaceMachineIds, type Space } from "../../lib/spaces";
import { machineList, useMachines } from "../../store/machines";
import { usePrefs } from "../../store/prefs";
import { useSettings } from "../../store/settings";
import { useUi, type View } from "../../store/ui";
import { IconButton, Kbd } from "../ui/Button";
import { Logo } from "../ui/Logo";
import { Menu, MenuItem, MenuSeparator } from "../ui/Menu";
import { MachineDot, StatusDot, agentLabel } from "../ui/Status";
import { UpdateBanner } from "./UpdateBanner";

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
    return conversations.filter((c) => set.has(c.machineId) && (prefs.showArchived || c.live));
  }, [conversations, idsKey, prefs.showArchived]);
  const collapsed = useMemo(() => new Set(prefs.collapsed), [prefs.collapsed]);
  const favorites = useMemo(() => new Set(prefs.favorites), [prefs.favorites]);
  const rows = useMemo(
    () =>
      buildSidebarRows(filtered, {
        grouping,
        machines: spaceMachines,
        collapsed,
        favorites,
        inactiveDays: prefs.inactiveDays,
        showInactive: prefs.showInactive,
      }),
    [filtered, grouping, spaceMachines, collapsed, favorites, prefs.inactiveDays, prefs.showInactive],
  );
  // Every machine, so that a hidden space needing attention still shows.
  const waiting = useMemo(() => conversations.filter((c) => c.attention?.status === "blocked").length, [conversations]);

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

      <div className="flex shrink-0 gap-1.5 px-2 pb-2">
        <button
          onClick={() => setPalette(true)}
          className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-lg border border-border bg-bg px-2.5 text-[12.5px] text-faint hover:border-[#363c46]"
        >
          <Search size={13} />
          <span className="flex-1 truncate text-left">Search…</span>
          <Kbd>{MOD}</Kbd>
          <Kbd>K</Kbd>
        </button>
        <button
          onClick={() => openNewSession()}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent text-on-accent hover:bg-[#fff3e2]"
          aria-label="New session"
          title={`New session (${MOD}${isMac ? "" : "+"}N)`}
        >
          <Plus size={16} />
        </button>
      </div>

      <div className="flex shrink-0 items-center gap-1 border-b border-border px-2 pb-1.5">
        <SpaceMenu machines={machines} waiting={waiting} />
        <DisplayMenu />
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
            itemContent={(_, row) => <Row row={row} active={active} machines={machinesById} />}
          />
        )}
      </div>

      <UpdateBanner />
    </aside>
  );
}

function Row({ row, active, machines }: { row: SidebarRow; active: string | null; machines: Record<string, MachineView> }) {
  switch (row.type) {
    case "header":
      return (
        <div className={`flex h-6 items-end px-3.5 pb-0.5 text-[11px] font-medium ${row.waiting ? "text-blocked" : "text-faint"}`}>
          {row.label}
        </div>
      );
    case "machine":
      return <MachineRow row={row} machine={machines[row.machineId]} />;
    case "project":
      return <ProjectRow row={row} />;
    case "conv":
      return <ConversationRow conv={row.conv} active={active === row.conv.key} depth={row.depth} suffix={row.suffix} tree={row.tree} />;
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

const indent = (depth: number) => ({ paddingLeft: 6 + depth * 12 });

function Count({ count, waiting }: { count: number; waiting: number }) {
  return (
    <span className="flex shrink-0 items-center gap-1.5">
      {waiting > 0 && <span className="rounded bg-blocked px-1 text-[10.5px] font-semibold leading-4 text-ink">{waiting}</span>}
      <span className="w-6 text-right text-[11px] tabular-nums text-faint">{count}</span>
    </span>
  );
}

const MachineRow = memo(function MachineRow({ row, machine }: { row: Extract<SidebarRow, { type: "machine" }>; machine?: MachineView }) {
  const toggle = usePrefs((s) => s.toggleCollapsed);
  const setSpace = usePrefs((s) => s.setSpace);
  const state = machine?.status.state ?? "offline";
  return (
    <div className="group px-1.5">
      <div className="flex h-7 items-center gap-1.5 rounded-md pr-1.5 hover:bg-surface-high/50" style={indent(0)}>
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
    <div className="group px-1.5">
      <div className="flex h-7 items-center gap-1.5 rounded-md pr-1.5 hover:bg-surface-high/50" style={indent(row.depth)}>
        <button onClick={() => toggle(row.id)} className="flex min-w-0 flex-1 items-center gap-1.5 text-left" aria-expanded={!row.collapsed}>
          {row.collapsed ? <ChevronRight size={13} className="shrink-0 text-faint" /> : <ChevronDown size={13} className="shrink-0 text-faint" />}
          <FolderGit2 size={13} className="shrink-0 text-faint" />
          <span className="min-w-0 truncate text-[12.5px] text-muted">{row.project}</span>
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
        <Count count={row.count} waiting={row.waiting} />
      </div>
    </div>
  );
});

const ConversationRow = memo(function ConversationRow({
  conv,
  active,
  depth,
  suffix,
  tree,
}: {
  conv: Conversation;
  active: boolean;
  depth: number;
  suffix?: string;
  tree?: ConvTree;
}) {
  // An offline machine's last known status is stale: grey it out.
  const offline = useMachines((s) => s.machines[conv.machineId]?.status.state !== "online");
  // Folded: the most urgent state of the agents it started shows on it.
  const own = tree && !tree.expanded ? tree.rollup : conv.attention;
  const attention = offline && conv.live ? null : own;
  const blocked = attention?.status === "blocked";
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
    <div className="px-1.5">
      <div
        className={`flex h-7 w-full items-center rounded-md pr-2 transition-colors ${active ? "bg-surface-high" : "hover:bg-surface-high/50"}`}
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
          className="flex h-7 min-w-0 flex-1 items-center gap-2 text-left"
          title={`${conv.title}\n${conv.project} · ${conv.machineName}\n${agentLabel(conv.kind)} · ${offline && conv.live ? "Machine offline" : statusLabel(conv.attention)}${conv.lastActivity ? ` · ${longDate(conv.lastActivity)}` : ""}`}
        >
          <span className="flex w-3 shrink-0 justify-center">
            <StatusDot attention={attention} size={7} />
          </span>
          <span className={`min-w-0 flex-1 truncate text-[13px] leading-5 ${conv.live ? (active ? "text-text" : "text-[#d9d5ce]") : "text-muted"}`}>{conv.title}</span>
          {suffix && <span className="min-w-0 max-w-[40%] shrink truncate text-[11px] text-faint">{suffix}</span>}
          {tree && !tree.expanded && (
            <span className={`shrink-0 rounded px-1 text-[10.5px] leading-4 tabular-nums ${blocked ? "bg-blocked font-semibold text-ink" : "bg-surface-high text-muted"}`}>{tree.total}</span>
          )}
          <span className={`w-8 shrink-0 text-right text-[11px] tabular-nums ${blocked ? "text-blocked" : "text-faint"}`}>{compactAge(conv.lastActivity)}</span>
        </button>
      </div>
    </div>
  );
});

function SpaceMenu({ machines, waiting }: { machines: MachineView[]; waiting: number }) {
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
          {waiting > 0 && <span className="ml-auto rounded bg-blocked px-1 text-[10.5px] font-semibold leading-4 text-ink" title={`${waiting} waiting`}>{waiting}</span>}
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
  const { showArchived, setShowArchived, showInactive, setShowInactive, inactiveDays } = usePrefs();
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
      <MenuItem icon={<Archive size={14} />} onSelect={() => setShowArchived(!showArchived)}>
        Show archived {tick(showArchived)}
      </MenuItem>
      {inactiveDays > 0 && (
        <MenuItem icon={<Eye size={14} />} onSelect={() => setShowInactive(!showInactive)}>
          Show inactive projects {tick(showInactive)}
        </MenuItem>
      )}
    </Menu>
  );
}
