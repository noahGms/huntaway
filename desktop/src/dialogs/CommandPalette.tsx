import * as RD from "@radix-ui/react-dialog";
import { Command } from "cmdk";
import { Clock, FolderGit2, PanelLeft, PanelRight, Plus, Server, Settings, Square, SquareTerminal } from "lucide-react";
import { useState } from "react";
import { api, errorMessage } from "../api/client";
import { useConversations } from "../hooks/useConversations";
import { AgentIcon, StatusDot } from "../components/ui/Status";
import { statusLabel } from "../lib/conversations";
import { shortTime } from "../lib/format";
import { machineList, useMachines } from "../store/machines";
import { useUi } from "../store/ui";

const itemClass =
  "flex cursor-default items-center gap-3 rounded-lg px-3 py-2 text-[13px] text-text data-[selected=true]:bg-surface-high aria-selected:bg-surface-high";
const groupClass = "[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-3 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-faint";

export function CommandPalette() {
  const ui = useUi();
  const conversations = useConversations();
  const machines = machineList(useMachines((s) => s.machines));
  const [search, setSearch] = useState("");
  const close = () => {
    ui.setPalette(false);
    setSearch("");
  };
  const run = (fn: () => void) => {
    close();
    fn();
  };
  const selected = conversations.find((c) => c.key === ui.selected);
  const projects = [...new Map(conversations.filter((c) => c.live).map((c) => [`${c.machineId}|${c.project}`, c])).values()];

  return (
    <RD.Root open={ui.paletteOpen} onOpenChange={(o) => (o ? ui.setPalette(true) : close())}>
      <RD.Portal>
        <RD.Overlay className="fixed inset-0 z-40 bg-black/50" />
        <RD.Content className="fixed left-1/2 top-[14vh] z-50 w-[640px] -translate-x-1/2 overflow-hidden rounded-2xl border border-border bg-surface shadow-[0_24px_60px_rgba(0,0,0,0.55)] animate-fade-in">
          <RD.Title className="sr-only">Rechercher</RD.Title>
          <Command loop className="flex max-h-[60vh] flex-col">
            <Command.Input
              value={search}
              onValueChange={setSearch}
              autoFocus
              placeholder="Aller à une conversation, un projet, une action…"
              className="h-12 shrink-0 border-b border-border bg-transparent px-4 text-[14px] text-text placeholder:text-faint focus:outline-none"
            />
            <Command.List className="min-h-0 overflow-y-auto p-1.5">
              <Command.Empty className="px-3 py-6 text-center text-[13px] text-muted">Aucun résultat.</Command.Empty>
              {conversations.some((c) => c.attention?.status === "blocked") && (
                <Command.Group heading="Ont besoin de toi" className={groupClass}>
                  {conversations
                    .filter((c) => c.attention?.status === "blocked")
                    .map((c) => (
                      <Command.Item key={`w-${c.key}`} value={`attente ${c.title} ${c.project} ${c.machineName} ${c.key}`} onSelect={() => run(() => ui.select(c.key))} className={itemClass}>
                        <StatusDot attention={c.attention} />
                        <span className="min-w-0 flex-1 truncate">{c.title}</span>
                        <span className="text-[11.5px] text-blocked">{statusLabel(c.attention)}</span>
                      </Command.Item>
                    ))}
                </Command.Group>
              )}
              <Command.Group heading="Actions" className={groupClass}>
                <Command.Item value="nouvelle session lancer agent" onSelect={() => run(() => ui.openNewSession())} className={itemClass}>
                  <Plus size={15} className="text-muted" /> Nouvelle session
                </Command.Item>
                {selected?.agent?.attention.status === "working" && (
                  <Command.Item
                    value="stop interrompre agent"
                    onSelect={() => run(() => void api.interrupt(selected.machineId, selected.agent!.id).catch((e) => ui.toast(errorMessage(e), "error")))}
                    className={itemClass}
                  >
                    <Square size={15} className="text-muted" /> Interrompre « {selected.title} »
                  </Command.Item>
                )}
                {selected?.live && (
                  <Command.Item value="terminal ouvrir" onSelect={() => run(() => ui.setPanelTab("terminal"))} className={itemClass}>
                    <SquareTerminal size={15} className="text-muted" /> Ouvrir le terminal
                  </Command.Item>
                )}
                <Command.Item value="ajouter machine serveur appairer" onSelect={() => run(() => ui.openPair())} className={itemClass}>
                  <Server size={15} className="text-muted" /> Ajouter une machine
                </Command.Item>
                <Command.Item value="historique conversations passées" onSelect={() => run(() => ui.setView("history"))} className={itemClass}>
                  <Clock size={15} className="text-muted" /> Historique
                </Command.Item>
                <Command.Item value="barre latérale sidebar" onSelect={() => run(ui.toggleSidebar)} className={itemClass}>
                  <PanelLeft size={15} className="text-muted" /> Afficher / masquer la barre latérale
                </Command.Item>
                <Command.Item value="panneau activité" onSelect={() => run(ui.togglePanel)} className={itemClass}>
                  <PanelRight size={15} className="text-muted" /> Afficher / masquer le panneau d'activité
                </Command.Item>
                <Command.Item value="paramètres réglages" onSelect={() => run(() => ui.setView("settings"))} className={itemClass}>
                  <Settings size={15} className="text-muted" /> Paramètres
                </Command.Item>
              </Command.Group>
              <Command.Group heading="Conversations" className={groupClass}>
                {conversations.slice(0, 200).map((c) => (
                  <Command.Item key={c.key} value={`${c.title} ${c.project} ${c.machineName} ${c.key}`} onSelect={() => run(() => ui.select(c.key))} className={itemClass}>
                    <StatusDot attention={c.attention} />
                    <AgentIcon kind={c.kind} size={13} />
                    <span className="min-w-0 flex-1 truncate">{c.title}</span>
                    <span className="truncate text-[11.5px] text-faint">
                      {c.project} · {c.machineName}
                    </span>
                    <span className="w-[44px] shrink-0 text-right text-[11px] text-faint">{shortTime(c.lastActivity)}</span>
                  </Command.Item>
                ))}
              </Command.Group>
              <Command.Group heading="Projets" className={groupClass}>
                {projects.map((c) => (
                  <Command.Item
                    key={`p-${c.machineId}-${c.project}`}
                    value={`projet ${c.project} ${c.machineName}`}
                    onSelect={() => run(() => ui.openNewSession({ machineId: c.machineId, workspace: c.agent ? `${c.agent.session}|${c.agent.workspace_id}` : undefined }))}
                    className={itemClass}
                  >
                    <FolderGit2 size={15} className="text-muted" />
                    <span className="flex-1">Nouvelle session dans {c.project}</span>
                    <span className="text-[11.5px] text-faint">{c.machineName}</span>
                  </Command.Item>
                ))}
              </Command.Group>
              <Command.Group heading="Machines" className={groupClass}>
                {machines.map((m) => (
                  <Command.Item
                    key={m.record.machine_id}
                    value={`machine ${m.record.name}`}
                    onSelect={() =>
                      run(() => {
                        ui.setMachineFilter(m.record.machine_id);
                        ui.setView("conversations");
                      })
                    }
                    className={itemClass}
                  >
                    <Server size={15} className="text-muted" />
                    <span className="flex-1">{m.record.name}</span>
                    <span className="text-[11.5px] text-faint">{m.status.state === "online" ? "connectée" : "hors ligne"}</span>
                  </Command.Item>
                ))}
              </Command.Group>
            </Command.List>
          </Command>
        </RD.Content>
      </RD.Portal>
    </RD.Root>
  );
}
