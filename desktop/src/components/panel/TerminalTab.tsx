import { Plus, SquareArrowOutUpRight } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, app, errorMessage } from "../../api/client";
import type { Conversation } from "../../lib/conversations";
import { can, useMachines } from "../../store/machines";
import { canonicalPath, shellsOf, useProjects } from "../../store/projects";
import { useUi } from "../../store/ui";
import { Button } from "../ui/Button";
import { LiveTerminal } from "../terminal/LiveTerminal";

/** Shells being opened (`<machine>|<path>`): one at a time per project. */
const opening = new Set<string>();

async function newShell(machineId: string, path: string): Promise<void> {
  const key = `${machineId}|${path}`;
  if (opening.has(key)) return;
  opening.add(key);
  try {
    await api.openShell(machineId, path);
    await useProjects.getState().loadShells(machineId, path);
  } catch (e) {
    useUi.getState().toast(errorMessage(e), "error");
  } finally {
    opening.delete(key);
  }
}

/** Opens the system terminal in a local folder, with a toast on failure. */
export function openInTerminal(path: string) {
  void app.openInTerminal(path).catch((e) => useUi.getState().toast(errorMessage(e), "error"));
}

/** A shell in the project folder, or the agent's own pane. Mount with
 * `key` = conversation: typing mode never follows another one. */
export function TerminalTab({ conv }: { conv: Conversation }) {
  const mode = useUi((s) => (conv.live && conv.agentId ? s.terminalMode : "shell"));
  const setMode = (m: "shell" | "agent") => useUi.getState().setPanelTab("terminal", m);
  const switcher = conv.live && conv.agentId && (
    <div className="flex shrink-0 rounded-lg border border-border p-0.5">
      {(["shell", "agent"] as const).map((m) => (
        <button
          key={m}
          onClick={() => setMode(m)}
          className={`rounded-md px-2 py-0.5 text-[11.5px] ${mode === m ? "bg-surface-high text-text" : "text-muted hover:text-text"}`}
        >
          {m === "shell" ? "Shell" : "Agent"}
        </button>
      ))}
    </div>
  );
  if (mode === "agent" && conv.agentId) {
    return <LiveTerminal key="agent" machineId={conv.machineId} target={{ agentId: conv.agentId }} title="Agent's Herdr pane" actions={switcher} />;
  }
  return <ShellTerminal conv={conv} switcher={switcher} />;
}

function ShellTerminal({ conv, switcher }: { conv: Conversation; switcher: React.ReactNode }) {
  const { machineId, cwd } = conv;
  const machine = useMachines((s) => s.machines[machineId]);
  const online = machine?.status.state === "online";
  const canOpen = can(machine, "terminal.open") && online;
  const shells = useProjects((s) => shellsOf(s, machineId, cwd));
  const path = useProjects((s) => (cwd ? canonicalPath(s.aliases, machineId, cwd) : null));
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!cwd || !online) return;
    let live = true;
    void useProjects
      .getState()
      .loadShells(machineId, cwd)
      .then(() => live && setLoaded(true));
    return () => {
      live = false;
    };
  }, [machineId, cwd, online]);

  // The project's latest shell is shared by its conversations.
  const shell = useMemo(() => [...(shells ?? [])].sort((a, b) => b.opened_at - a.opened_at)[0], [shells]);

  // None yet: open one, once (a shell closed by the user stays closed).
  const autoOpened = useRef(false);
  useEffect(() => {
    if (!loaded || autoOpened.current) return;
    if (shell) autoOpened.current = true;
    else if (canOpen && path) {
      autoOpened.current = true;
      start();
    }
  }, [loaded, shell, canOpen, path, machineId]); // eslint-disable-line react-hooks/exhaustive-deps
  const [starting, setStarting] = useState(false);
  const start = () => {
    if (!path) return;
    setStarting(true);
    void newShell(machineId, path).finally(() => setStarting(false));
  };

  const local = conv.local && cwd && (
    <Button size="sm" variant="ghost" icon={<SquareArrowOutUpRight size={13} />} onClick={() => openInTerminal(cwd)} title="Open in the system terminal">
      Open in Terminal
    </Button>
  );

  if (shell) {
    return (
      <LiveTerminal
        key={shell.pane}
        machineId={machineId}
        target={{ pane: shell.pane }}
        title={cwd}
        typing
        actions={
          <>
            {switcher}
            {canOpen && path && (
              <Button size="sm" variant="ghost" icon={<Plus size={13} />} loading={starting} onClick={start} title="New shell">
                New
              </Button>
            )}
            {canOpen && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => void api.closeShell(machineId, shell.pane).catch((e) => useUi.getState().toast(errorMessage(e), "error"))}
              >
                Close
              </Button>
            )}
            {local}
          </>
        }
      />
    );
  }

  const message = !cwd
    ? "No project folder for this conversation."
    : !online
      ? "The machine is offline."
      : !can(machine, "terminal.open")
        ? "This device can't open shells on this machine."
        : !autoOpened.current || starting
          ? "Opening a shell in the project folder…"
          : null;
  return (
    <div className="flex h-full flex-col bg-[#121418]">
      <div className="flex items-center gap-2 border-b border-border bg-surface px-4 py-2 text-[12px]">
        <span className="min-w-0 flex-1 truncate text-muted">{cwd ?? "Shell"}</span>
        {switcher}
        {local}
      </div>
      <div className="flex flex-1 flex-col items-center justify-center gap-3 px-8 text-center text-[12.5px] text-muted">
        {message ?? (
          <>
            <span>No shell open in this project.</span>
            <Button size="sm" icon={<Plus size={13} />} onClick={start}>
              Open a shell
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
