import { Archive, ChevronDown, Clock, Layers, MessagesSquare, Monitor, Plus, Search, Server, Settings } from "lucide-react";
import { useState } from "react";
import { Virtuoso } from "react-virtuoso";
import type { MachineView } from "../../api/types";
import { useConversations } from "../../hooks/useConversations";
import { groupConversations, type Conversation } from "../../lib/conversations";
import { shortTime } from "../../lib/format";
import { machineList, useMachines } from "../../store/machines";
import { useSettings } from "../../store/settings";
import { useUi, type View } from "../../store/ui";
import { Button, IconButton, Kbd } from "../ui/Button";
import { Logo } from "../ui/Logo";
import { Menu, MenuItem } from "../ui/Menu";
import { AgentIcon, MachineDot, StatusDot } from "../ui/Status";

export function Sidebar() {
  const conversations = useConversations();
  const machines = machineList(useMachines((s) => s.machines));
  const { view, setView, selected, select, setPalette, openNewSession, openPair, machineFilter, setMachineFilter } = useUi();
  const grouping = useSettings((s) => s.settings.grouping);
  const updateSettings = useSettings((s) => s.update);
  const [showArchived, setShowArchived] = useState(true);

  const filtered = conversations.filter((c) => (!machineFilter || c.machineId === machineFilter) && (showArchived || c.live));
  const groups = groupConversations(filtered, grouping);
  const waiting = conversations.filter((c) => c.attention?.status === "blocked").length;

  // Flattened rows for the virtual list.
  const rows: ({ type: "header"; label: string; id: string } | { type: "conv"; conv: Conversation })[] = [];
  for (const g of groups) {
    rows.push({ type: "header", label: g.label, id: g.id });
    for (const c of g.items) rows.push({ type: "conv", conv: c });
  }

  const nav: { id: View; label: string; icon: React.ReactNode; badge?: number }[] = [
    { id: "conversations", label: "Conversations", icon: <MessagesSquare size={16} />, badge: waiting },
    { id: "servers", label: "Serveurs", icon: <Server size={16} /> },
    { id: "history", label: "Historique", icon: <Clock size={16} /> },
    { id: "settings", label: "Paramètres", icon: <Settings size={16} /> },
  ];

  return (
    <aside className="flex h-full flex-col border-r border-border bg-surface">
      {/* Title bar area: traffic lights sit on the left. */}
      <div className="drag flex h-[52px] shrink-0 items-center justify-end gap-2 pl-[86px] pr-3">
        <div className="no-drag flex items-center gap-2">
          <Logo size={24} />
          <span className="text-[15px] font-semibold tracking-tight">Huntaway</span>
        </div>
      </div>

      <div className="space-y-2 px-3 pb-3">
        <button
          onClick={() => setPalette(true)}
          className="flex h-9 w-full items-center gap-2 rounded-[10px] border border-border bg-bg px-3 text-[12.5px] text-faint hover:border-[#363c46]"
        >
          <Search size={14} />
          <span className="flex-1 text-left">Rechercher…</span>
          <Kbd>⌘</Kbd>
          <Kbd>K</Kbd>
        </button>
        <Button variant="primary" className="w-full" icon={<Plus size={16} />} onClick={() => openNewSession()}>
          Nouvelle session
        </Button>
      </div>

      <nav className="space-y-0.5 px-2 pb-2">
        {nav.map((n) => (
          <button
            key={n.id}
            onClick={() => setView(n.id)}
            className={`flex h-8 w-full items-center gap-2.5 rounded-lg px-2.5 text-[13px] transition-colors ${
              view === n.id ? "bg-surface-high text-text" : "text-muted hover:bg-surface-high/60 hover:text-text"
            }`}
          >
            <span className={view === n.id ? "text-text" : "text-faint"}>{n.icon}</span>
            <span className="flex-1 text-left">{n.label}</span>
            {!!n.badge && <span className="rounded-md bg-blocked px-1.5 text-[11px] font-semibold leading-[18px] text-ink">{n.badge}</span>}
          </button>
        ))}
      </nav>

      <div className="flex items-center justify-between px-4 pb-1 pt-3">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-faint">Conversations</span>
        <div className="flex items-center gap-0.5">
          <Menu
            trigger={
              <button className="flex h-6 items-center gap-1 rounded-md px-1.5 text-[11px] text-faint hover:bg-surface-high hover:text-text" aria-label="Affichage">
                {grouping === "project" ? <Layers size={12} /> : <Clock size={12} />}
                <ChevronDown size={11} />
              </button>
            }
          >
            <MenuItem icon={<Clock size={14} />} onSelect={() => updateSettings({ grouping: "date" })}>
              Grouper par date {grouping === "date" && "✓"}
            </MenuItem>
            <MenuItem icon={<Layers size={14} />} onSelect={() => updateSettings({ grouping: "project" })}>
              Grouper par projet {grouping === "project" && "✓"}
            </MenuItem>
            <MenuItem icon={<Archive size={14} />} onSelect={() => setShowArchived(!showArchived)}>
              {showArchived ? "Masquer les archivées" : "Afficher les archivées"}
            </MenuItem>
          </Menu>
          <IconButton label="Nouvelle session" onClick={() => openNewSession()} className="h-6 w-6">
            <Plus size={14} />
          </IconButton>
        </div>
      </div>
      {machineFilter && (
        <div className="mx-3 mb-1 flex items-center justify-between rounded-lg bg-surface-high px-2.5 py-1 text-[11.5px] text-muted">
          <span>Filtré : {machines.find((m) => m.record.machine_id === machineFilter)?.record.name}</span>
          <button className="text-text hover:underline" onClick={() => setMachineFilter(null)}>
            Tout voir
          </button>
        </div>
      )}

      <div className="min-h-0 flex-1">
        {rows.length === 0 ? (
          <p className="px-4 py-6 text-[12.5px] leading-relaxed text-faint">
            {machines.length === 0 ? "Aucune machine connectée." : "Aucune conversation pour l'instant. Lance une session pour commencer."}
          </p>
        ) : (
          <Virtuoso
            data={rows}
            computeItemKey={(_, row) => (row.type === "header" ? `h-${row.id}` : row.conv.key)}
            itemContent={(_, row) =>
              row.type === "header" ? (
                <div className={`px-4 pb-1 pt-3 text-[11.5px] ${row.id === "waiting" ? "font-medium text-blocked" : "text-faint"}`}>{row.label}</div>
              ) : (
                <ConversationRow conv={row.conv} active={selected === row.conv.key && view === "conversations"} onClick={() => select(row.conv.key)} showMachine={machines.length > 1} />
              )
            }
          />
        )}
      </div>

      <ServersSection machines={machines} onAdd={() => openPair()} />
    </aside>
  );
}

function ConversationRow({ conv, active, onClick, showMachine }: { conv: Conversation; active: boolean; onClick: () => void; showMachine: boolean }) {
  const blocked = conv.attention?.status === "blocked";
  return (
    <div className="px-2">
      <button
        onClick={onClick}
        className={`group flex w-full items-center gap-2.5 rounded-lg px-2.5 py-[7px] text-left transition-colors ${
          active ? "bg-surface-high" : "hover:bg-surface-high/50"
        }`}
        title={`${conv.title}\n${conv.project} · ${conv.machineName}`}
      >
        <StatusDot attention={conv.attention} />
        <span className="min-w-0 flex-1">
          <span className={`block truncate text-[13px] ${conv.live ? (active ? "text-text" : "text-[#d9d5ce]") : "text-muted"}`}>{conv.title}</span>
          {(showMachine || blocked) && (
            <span className="mt-[1px] flex items-center gap-1 truncate text-[11px] text-faint">
              <AgentIcon kind={conv.kind} size={10} />
              <span className="truncate">
                {conv.project}
                {showMachine && ` · ${conv.machineName}`}
              </span>
            </span>
          )}
        </span>
        <span className={`shrink-0 text-[11px] ${blocked ? "text-blocked" : "text-faint"}`}>{shortTime(conv.lastActivity)}</span>
      </button>
    </div>
  );
}

function ServersSection({ machines, onAdd }: { machines: MachineView[]; onAdd: () => void }) {
  const { machineFilter, setMachineFilter, setView } = useUi();
  return (
    <div className="shrink-0 border-t border-border px-2 pb-3 pt-2">
      <div className="flex items-center justify-between px-2 pb-1">
        <button className="text-[11px] font-semibold uppercase tracking-wider text-faint hover:text-muted" onClick={() => setView("servers")}>
          Serveurs
        </button>
        <IconButton label="Ajouter une machine" onClick={onAdd} className="h-6 w-6">
          <Plus size={14} />
        </IconButton>
      </div>
      {machines.length === 0 && <p className="px-2 py-1 text-[12px] text-faint">Aucune machine.</p>}
      {machines.map((m) => {
        const slow = (m.status.latency_ms ?? 0) > 400;
        const label = m.status.state === "online" ? (slow ? "Latence élevée" : "Connecté") : m.status.state === "connecting" ? "Connexion…" : "Hors ligne";
        const active = machineFilter === m.record.machine_id;
        return (
          <button
            key={m.record.machine_id}
            onClick={() => setMachineFilter(active ? null : m.record.machine_id)}
            className={`flex h-8 w-full items-center gap-2.5 rounded-lg px-2 text-[12.5px] ${active ? "bg-surface-high" : "hover:bg-surface-high/50"}`}
            title={active ? "Afficher toutes les machines" : "Filtrer les conversations de cette machine"}
          >
            {m.record.local ? <Monitor size={15} className="text-muted" /> : <Server size={15} className="text-muted" />}
            <span className="min-w-0 flex-1 truncate text-left">{m.record.name}</span>
            <MachineDot state={m.status.state} slow={slow} />
            <span className="w-[84px] text-left text-[11px] text-faint">{label}</span>
          </button>
        );
      })}
    </div>
  );
}
