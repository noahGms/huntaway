import { listen } from "@tauri-apps/api/event";
import { onOpenUrl } from "@tauri-apps/plugin-deep-link";
import { Plus, Server } from "lucide-react";
import { useEffect, useRef, useState } from "react";
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
import { fromHistory, historyKey, liveKey, parseKey, type Conversation } from "./lib/conversations";
import { isMac } from "./lib/platform";
import { HistoryPage } from "./pages/HistoryPage";
import { ProjectPage } from "./pages/ProjectPage";
import { LocalDaemonCard, ServersPage } from "./pages/ServersPage";
import { SettingsPage } from "./pages/SettingsPage";
import { useMachines } from "./store/machines";
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
    // StrictMode runs this twice: listeners ready after the cleanup are removed at once.
    let disposed = false;
    void init().then((u) => (disposed ? u() : (stop = u)));
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
      disposed = true;
      stop?.();
      unlisten.forEach((p) => void p.then((u) => u?.()));
      window.removeEventListener("resize", onResize);
    };
  }, [init, loadSettings, openPair, select]);

  // Open the most urgent conversation at start.
  useEffect(() => {
    if (ready && !selected && conversations.length) select(conversations[0].key);
  }, [ready, selected, conversations, select]);

  const selection = useSelectedConversation(conversations, selected);
  const conv = typeof selection === "object" ? selection : null;

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
          ) : selection === "pending" ? (
            <div className="drag flex h-full flex-col items-center justify-center gap-3 text-muted">
              <Spinner className="h-5 w-5" />
              <span className="text-[13px]">Starting the agent…</span>
            </div>
          ) : selection === "failed" || selection === "gone" ? (
            <div className="drag flex h-full flex-col items-center justify-center gap-2 px-10 text-center text-[13px] text-muted">
              {selection === "failed" ? "The agent didn't show up. Check its Herdr session on the machine." : "This agent is no longer running."}
            </div>
          ) : conv ? (
            <ConversationView key={conv.key} conv={conv} />
          ) : (
            <Welcome />
          )}
        </div>
        {view === "conversations" && conv && showPanel && (
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

/** Selected conversation; archived ones not in the sidebar are fetched.
 * A live agent missing from the state is `pending` shortly after this app
 * created or resumed it, `failed` if it never showed up, else `gone`. */
function useSelectedConversation(conversations: Conversation[], selected: string | null): Conversation | "pending" | "failed" | "gone" | null {
  const [extra, setExtra] = useState<{ key: string; entry: HistoryEntry } | null>(null);
  const found = conversations.find((c) => c.key === selected);
  const k = selected ? parseKey(selected) : null;
  const machineState = useMachines((s) => (k ? s.machines[k.machineId]?.status.state : undefined));
  const expected = useMachines((s) => (selected ? s.expected[selected] : undefined));
  const select = useUi((s) => s.select);
  const [, tick] = useState(0);

  // Re-render when the start delay runs out.
  useEffect(() => {
    if (found || !expected) return;
    const timer = setTimeout(() => tick((n) => n + 1), Math.max(0, expected - Date.now()) + 50);
    return () => clearTimeout(timer);
  }, [found, expected]);

  // The agent on screen ended: its conversation is now in the history.
  const last = useRef<Conversation | null>(null);
  useEffect(() => {
    if (found) {
      last.current = found;
      return;
    }
    const agent = last.current?.key === selected ? last.current?.agent : undefined;
    if (k?.live && agent?.native_session) select(historyKey(k.machineId, `${agent.kind}:${agent.native_session}`));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [found, selected]);

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
  const machine = useMachines.getState().machines[k.machineId];
  if (!machine || !machineState) return null;
  if (!k.live) return extra?.key === selected ? fromHistory(machine, extra.entry) : null;
  if (expected && Date.now() < expected) return machineState === "online" ? "pending" : null;
  return expected ? "failed" : "gone";
}

function Welcome() {
  const count = useMachines((s) => Object.keys(s.machines).length);
  const { openNewSession, openPair } = useUi();
  return (
    <div className="drag flex h-full items-center justify-center p-10">
      <div className="no-drag max-w-[460px] text-center">
        <div className="mb-5 flex justify-center">
          <Logo size={56} />
        </div>
        <h1 className="mb-2 text-[20px] font-semibold">All your agents in one place</h1>
        <p className="mb-6 text-[13px] leading-relaxed text-muted">
          Huntaway connects to the <code className="font-mono text-text">huntawayd</code> daemons on your computer and your servers to follow, drive and unblock your
          Herdr agents.
        </p>
        {count === 0 ? (
          <div className="space-y-3 text-left">
            <LocalDaemonCard />
            <Button className="w-full" icon={<Server size={15} />} onClick={() => openPair()}>
              Add a server
            </Button>
          </div>
        ) : (
          <div className="flex justify-center gap-2">
            <Button variant="primary" icon={<Plus size={15} />} onClick={() => openNewSession()}>
              New session
            </Button>
            <Button icon={<Server size={15} />} onClick={() => openPair()}>
              Add a machine
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
