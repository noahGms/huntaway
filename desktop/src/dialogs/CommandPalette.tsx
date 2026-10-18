import * as RD from "@radix-ui/react-dialog";
import { Command } from "cmdk";
import { Boxes, Clock, FolderGit2, Layers, PanelLeft, PanelRight, Plus, Server, Settings, Square, SquareTerminal } from "lucide-react";
import { useMemo, useState } from "react";
import { api, errorMessage } from "../api/client";
import { useConversations } from "../hooks/useConversations";
import { AgentIcon, MachineDot, StatusDot } from "../components/ui/Status";
import { compactAge, projectsOf, searchConversations, statusLabel } from "../lib/conversations";
import { orderMachines } from "../lib/spaces";
import { machineList, useMachines } from "../store/machines";
import { usePrefs } from "../store/prefs";
import { useUi } from "../store/ui";

const itemClass =
  "flex cursor-default items-center gap-3 rounded-lg px-3 py-2 text-[13px] text-text data-[selected=true]:bg-surface-high aria-selected:bg-surface-high";
const groupClass = "[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-3 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-faint";

/** Rows rendered per section: the search covers everything, the list stays light. */
const LIMIT = 60;

const matches = (text: string, words: string[]) => {
  const t = text.toLowerCase();
  return words.every((w) => t.includes(w));
};

export function CommandPalette() {
  const ui = useUi();
  const conversations = useConversations();
  const machineOrder = usePrefs((s) => s.machineOrder);
  const groups = usePrefs((s) => s.groups);
  const favorites = usePrefs((s) => s.favorites);
  const setSpace = usePrefs((s) => s.setSpace);
  const machines = orderMachines(machineList(useMachines((s) => s.machines)), machineOrder);
  const [search, setSearch] = useState("");
  const close = () => {
    ui.setPalette(false);
    setSearch("");
  };
  const run = (fn: () => void) => {
    close();
    fn();
  };
  const words = search.toLowerCase().split(/[\s@]+/).filter(Boolean);
  const selected = conversations.find((c) => c.key === ui.selected);

  const actions: { id: string; label: string; keywords: string; icon: React.ReactNode; run: () => void }[] = [
    { id: "new", label: "New session", keywords: "start agent create", icon: <Plus size={15} />, run: () => ui.openNewSession() },
    ...(selected?.agent?.attention.status === "working"
      ? [{
          id: "stop",
          label: `Stop “${selected.title}”`,
          keywords: "interrupt agent",
          icon: <Square size={15} />,
          run: () => void api.interrupt(selected.machineId, selected.agent!.id).catch((e) => ui.toast(errorMessage(e), "error")),
        }]
      : []),
    ...(selected?.live ? [{ id: "terminal", label: "Open terminal", keywords: "shell", icon: <SquareTerminal size={15} />, run: () => ui.setPanelTab("terminal") }] : []),
    { id: "pair", label: "Add machine", keywords: "server pair", icon: <Server size={15} />, run: () => ui.openPair() },
    { id: "servers", label: "Servers", keywords: "machines", icon: <Server size={15} />, run: () => ui.setView("servers") },
    { id: "history", label: "History", keywords: "past conversations", icon: <Clock size={15} />, run: () => ui.setView("history") },
    { id: "sidebar", label: "Toggle sidebar", keywords: "show hide", icon: <PanelLeft size={15} />, run: ui.toggleSidebar },
    { id: "panel", label: "Toggle activity panel", keywords: "show hide details", icon: <PanelRight size={15} />, run: ui.togglePanel },
    { id: "settings", label: "Settings", keywords: "preferences", icon: <Settings size={15} />, run: () => ui.setView("settings") },
  ];
  const shownActions = words.length ? actions.filter((a) => matches(`${a.label} ${a.keywords}`, words)) : actions;

  // Only computed while open: thousands of conversations stay cheap.
  const open = ui.paletteOpen;
  const waiting = useMemo(() => (open ? conversations.filter((c) => c.attention?.status === "blocked") : []), [open, conversations]);
  const found = useMemo(() => (open ? searchConversations(conversations, search) : []), [open, conversations, search]);
  const projects = useMemo(() => {
    if (!open) return [];
    const all = projectsOf(conversations).filter((p) => !words.length || matches(`${p.project} ${p.machineName}`, words));
    const fav = new Set(favorites);
    return all.sort((a, b) => Number(fav.has(b.key)) - Number(fav.has(a.key)));
  }, [open, conversations, search, favorites]); // eslint-disable-line react-hooks/exhaustive-deps
  const shownMachines = words.length ? machines.filter((m) => matches(`machine server ${m.record.name}`, words)) : machines;
  const shownGroups = words.length ? groups.filter((g) => matches(`group space ${g.name}`, words)) : groups;
  const goSpace = (space: Parameters<typeof setSpace>[0]) =>
    run(() => {
      setSpace(space);
      ui.setView("conversations");
    });

  return (
    <RD.Root open={open} onOpenChange={(o) => (o ? ui.setPalette(true) : close())}>
      <RD.Portal>
        <RD.Overlay className="fixed inset-0 z-40 bg-black/50" />
        <RD.Content className="fixed left-1/2 top-[14vh] z-50 w-[640px] -translate-x-1/2 overflow-hidden rounded-2xl border border-border bg-surface shadow-[0_24px_60px_rgba(0,0,0,0.55)] animate-fade-in">
          <RD.Title className="sr-only">Search</RD.Title>
          <Command loop shouldFilter={false} className="flex max-h-[60vh] flex-col">
            <Command.Input
              value={search}
              onValueChange={setSearch}
              autoFocus
              placeholder="Go to a conversation, project, machine or action…"
              className="h-12 shrink-0 border-b border-border bg-transparent px-4 text-[14px] text-text placeholder:text-faint focus:outline-none"
            />
            <Command.List className="min-h-0 overflow-y-auto p-1.5">
              <Command.Empty className="px-3 py-6 text-center text-[13px] text-muted">No results.</Command.Empty>
              {!words.length && waiting.length > 0 && (
                <Command.Group heading="Waiting for you" className={groupClass}>
                  {waiting.map((c) => (
                    <Command.Item key={`w-${c.key}`} value={`w-${c.key}`} onSelect={() => run(() => ui.select(c.key))} className={itemClass}>
                      <StatusDot attention={c.attention} />
                      <span className="min-w-0 flex-1 truncate">{c.title}</span>
                      <span className="truncate text-[11.5px] text-faint">
                        {c.project} @ {c.machineName}
                      </span>
                      <span className="shrink-0 text-[11.5px] text-blocked">{statusLabel(c.attention)}</span>
                    </Command.Item>
                  ))}
                </Command.Group>
              )}
              {shownActions.length > 0 && (
                <Command.Group heading="Actions" className={groupClass}>
                  {shownActions.map((a) => (
                    <Command.Item key={a.id} value={`a-${a.id}`} onSelect={() => run(a.run)} className={itemClass}>
                      <span className="text-muted">{a.icon}</span> {a.label}
                    </Command.Item>
                  ))}
                </Command.Group>
              )}
              {found.length > 0 && (
                <Command.Group heading={words.length ? `Conversations · ${found.length}` : "Recent conversations"} className={groupClass}>
                  {found.slice(0, words.length ? LIMIT : 20).map((c) => (
                    <Command.Item key={c.key} value={c.key} onSelect={() => run(() => ui.select(c.key))} className={itemClass}>
                      <StatusDot attention={c.attention} />
                      <AgentIcon kind={c.kind} size={13} />
                      <span className="min-w-0 flex-1 truncate">{c.title}</span>
                      <span className="max-w-[40%] truncate text-[11.5px] text-faint">
                        {c.project} @ {c.machineName}
                      </span>
                      <span className="w-[44px] shrink-0 text-right text-[11px] tabular-nums text-faint">{compactAge(c.lastActivity)}</span>
                    </Command.Item>
                  ))}
                  {words.length > 0 && found.length > LIMIT && <div className="px-3 py-1.5 text-[11.5px] text-faint">{found.length - LIMIT} more: refine the search.</div>}
                </Command.Group>
              )}
              {projects.length > 0 && (
                <Command.Group heading="Projects" className={groupClass}>
                  {projects.slice(0, words.length ? LIMIT : 8).map((p) => (
                    <Command.Item key={`p-${p.key}`} value={`p-${p.key}`} onSelect={() => run(() => ui.openProject(p.machineId, p.project))} className={itemClass}>
                      <FolderGit2 size={15} className="text-muted" />
                      <span className="min-w-0 flex-1 truncate">
                        {p.project} <span className="text-faint">@ {p.machineName}</span>
                      </span>
                      {p.waiting > 0 && <span className="text-[11.5px] text-blocked">{p.waiting} waiting</span>}
                      <span className="text-[11.5px] text-faint">{p.count}</span>
                    </Command.Item>
                  ))}
                </Command.Group>
              )}
              {(shownMachines.length > 0 || shownGroups.length > 0) && (
                <Command.Group heading="Spaces" className={groupClass}>
                  {!words.length && (
                    <Command.Item value="s-all" onSelect={() => goSpace({ kind: "all" })} className={itemClass}>
                      <Boxes size={15} className="text-muted" />
                      <span className="flex-1">All machines</span>
                    </Command.Item>
                  )}
                  {shownGroups.map((g) => (
                    <Command.Item key={g.id} value={`g-${g.id}`} onSelect={() => goSpace({ kind: "group", id: g.id })} className={itemClass}>
                      <Layers size={15} className="text-muted" />
                      <span className="flex-1">{g.name}</span>
                      <span className="text-[11.5px] text-faint">group</span>
                    </Command.Item>
                  ))}
                  {shownMachines.map((m) => (
                    <Command.Item key={m.record.machine_id} value={`m-${m.record.machine_id}`} onSelect={() => goSpace({ kind: "machine", id: m.record.machine_id })} className={itemClass}>
                      <Server size={15} className="text-muted" />
                      <span className="flex-1">{m.record.name}</span>
                      <MachineDot state={m.status.state} />
                      <span className="text-[11.5px] text-faint">{m.status.state === "online" ? "online" : m.status.state === "connecting" ? "connecting" : "offline"}</span>
                    </Command.Item>
                  ))}
                </Command.Group>
              )}
            </Command.List>
          </Command>
        </RD.Content>
      </RD.Portal>
    </RD.Root>
  );
}
