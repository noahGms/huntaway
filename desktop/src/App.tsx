import { listen } from "@tauri-apps/api/event";
import { onOpenUrl } from "@tauri-apps/plugin-deep-link";
import { Plus, Server } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "./api/client";
import type { HistoryEntry } from "./api/types";
import { ConversationView } from "./components/conversation/ConversationView";
import { RightPanel } from "./components/panel/RightPanel";
import { Sidebar } from "./components/sidebar/Sidebar";
import { useConversations } from "./hooks/useConversations";
import { Button, Spinner } from "./components/ui/Button";
import { Logo } from "./components/ui/Logo";
import { Toasts } from "./components/ui/Toasts";
import { CommandPalette } from "./dialogs/CommandPalette";
import { NewSessionDialog } from "./dialogs/NewSessionDialog";
import { PairDialog } from "./dialogs/PairDialog";
import { useResizable } from "./hooks/useResizable";
import { useShortcuts } from "./hooks/useShortcuts";
import { fromHistory, liveKey, parseKey, type Conversation } from "./lib/conversations";
import { isMac } from "./lib/platform";
import { HistoryPage } from "./pages/HistoryPage";
import { ProjectPage } from "./pages/ProjectPage";
import { LocalDaemonCard, ServersPage } from "./pages/ServersPage";
import { SettingsPage } from "./pages/SettingsPage";
import { machineList, useMachines } from "./store/machines";
import { useSettings } from "./store/settings";
import { useUi } from "./store/ui";

export default function App() {
  const init = useMachines((s) => s.init);
  const ready = useMachines((s) => s.ready);
  const loadSettings = useSettings((s) => s.load);
  const { view, selected, showSidebar, showPanel, openPair, select } = useUi();
  const conversations = useConversations();
  const sidebar = useResizable("width:sidebar", 280, 220, 420, "left");
  const panel = useResizable("width:panel", 360, 300, 560, "right");
  const [wide, setWide] = useState(window.innerWidth >= 1200);
  useShortcuts(conversations);

  useEffect(() => {
    let stop: (() => void) | undefined;
    void init().then((u) => (stop = u));
    void loadSettings();
    const unlisten = [
      listen<string>("pair-link", (e) => openPair(e.payload)),
      // Notification clicked.
      listen<{ machine_id: string; agent_id: string }>("open-conversation", (e) => select(liveKey(e.payload.machine_id, e.payload.agent_id))),
      onOpenUrl((urls) => {
        const link = urls.find((u) => u.startsWith("huntaway://pair/"));
        if (link) openPair(link);
      }).catch(() => () => {}),
    ];
    const onResize = () => setWide(window.innerWidth >= 1200);
    window.addEventListener("resize", onResize);
    return () => {
      stop?.();
      unlisten.forEach((p) => void p.then((u) => u?.()));
      window.removeEventListener("resize", onResize);
    };
  }, [init, loadSettings, openPair, select]);

  // Open the most urgent conversation at start.
  useEffect(() => {
    if (ready && !selected && conversations.length) select(conversations[0].key);
  }, [ready, selected, conversations, select]);

  const conv = useSelectedConversation(conversations, selected);

  return (
    <div className="flex h-full">
      {showSidebar && (
        <div className="relative h-full shrink-0" style={{ width: sidebar.width }}>
          <Sidebar />
          <div onMouseDown={sidebar.onMouseDown} className="absolute -right-1 top-0 z-10 h-full w-2 cursor-col-resize" />
        </div>
      )}
      <main className="relative flex h-full min-w-0 flex-1">
        <div className="min-w-0 flex-1">
          {!showSidebar && isMac && <div className="drag absolute left-0 top-0 h-[52px] w-[90px]" />}
          {view === "servers" ? (
            <ServersPage />
          ) : view === "history" ? (
            <HistoryPage />
          ) : view === "settings" ? (
            <SettingsPage />
          ) : view === "project" ? (
            <ProjectPage />
          ) : !ready ? (
            <div className="flex h-full items-center justify-center text-muted">
              <Spinner className="h-5 w-5" />
            </div>
          ) : conv === "pending" ? (
            <div className="drag flex h-full flex-col items-center justify-center gap-3 text-muted">
              <Spinner className="h-5 w-5" />
              <span className="text-[13px]">Démarrage de l'agent…</span>
            </div>
          ) : conv ? (
            <ConversationView key={conv.key} conv={conv} />
          ) : (
            <Welcome />
          )}
        </div>
        {view === "conversations" && conv && conv !== "pending" && showPanel && (
          <div
            className={wide ? "relative h-full shrink-0" : "absolute right-0 top-0 z-20 h-full shadow-[-20px_0_40px_rgba(0,0,0,0.35)]"}
            style={{ width: panel.width }}
          >
            <div onMouseDown={panel.onMouseDown} className="absolute -left-1 top-0 z-10 h-full w-2 cursor-col-resize" />
            <RightPanel conv={conv} />
          </div>
        )}
      </main>
      <NewSessionDialog />
      <PairDialog />
      <CommandPalette />
      <Toasts />
    </div>
  );
}

/** Selected conversation; archived ones not in the sidebar are fetched. */
function useSelectedConversation(conversations: Conversation[], selected: string | null): Conversation | "pending" | null {
  const machines = useMachines((s) => s.machines);
  const [extra, setExtra] = useState<{ key: string; entry: HistoryEntry } | null>(null);
  const found = conversations.find((c) => c.key === selected);
  const k = selected ? parseKey(selected) : null;

  useEffect(() => {
    if (found || !k || k.live || extra?.key === selected) return;
    let alive = true;
    api
      .historyEntry(k.machineId, k.id)
      .then((entry) => alive && setExtra({ key: selected!, entry }))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [found, selected, k?.live, k?.machineId, k?.id, extra?.key]);

  if (found) return found;
  if (!k) return null;
  const machine = machines[k.machineId];
  if (!machine) return null;
  if (!k.live && extra?.key === selected) return fromHistory(machine, extra.entry);
  // A live agent just created: it shows up with the next event.
  return k.live && machine.status.state === "online" ? "pending" : null;
}

function Welcome() {
  const machines = machineList(useMachines((s) => s.machines));
  const { openNewSession, openPair } = useUi();
  return (
    <div className="drag flex h-full items-center justify-center p-10">
      <div className="no-drag max-w-[460px] text-center">
        <div className="mb-5 flex justify-center">
          <Logo size={56} />
        </div>
        <h1 className="mb-2 text-[20px] font-semibold">Tous tes agents, au même endroit</h1>
        <p className="mb-6 text-[13px] leading-relaxed text-muted">
          Huntaway se connecte aux daemons <code className="font-mono text-text">huntawayd</code> de ton ordinateur et de tes serveurs pour suivre, piloter et débloquer
          tes agents Herdr.
        </p>
        {machines.length === 0 ? (
          <div className="space-y-3 text-left">
            <LocalDaemonCard />
            <Button className="w-full" icon={<Server size={15} />} onClick={() => openPair()}>
              Ajouter un serveur
            </Button>
          </div>
        ) : (
          <div className="flex justify-center gap-2">
            <Button variant="primary" icon={<Plus size={15} />} onClick={() => openNewSession()}>
              Nouvelle session
            </Button>
            <Button icon={<Server size={15} />} onClick={() => openPair()}>
              Ajouter une machine
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
