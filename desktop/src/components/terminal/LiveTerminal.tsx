import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { Keyboard, RotateCw } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { app, errorMessage } from "../../api/client";
import type { TerminalTarget } from "../../api/types";
import { toInput } from "../../lib/terminal";
import { can, useMachines } from "../../store/machines";

const theme = {
  background: "#121418",
  foreground: "#d4cfc6",
  cursor: "#f3e6d3",
  selectionBackground: "rgba(243,230,211,0.25)",
  black: "#20242b",
  red: "#f0605d",
  green: "#4cc38a",
  yellow: "#e39b4b",
  blue: "#6aa6f8",
  magenta: "#c49bf0",
  cyan: "#5fc4c4",
  white: "#d4cfc6",
  brightBlack: "#5e636b",
};

/** Live screen of a Herdr pane (agent, script or shell), drawn by xterm.js.
 * Typing needs `agents.input`; `typing` starts with it on (shells). Mount
 * with a `key` per target: typing mode never follows another pane. */
export function LiveTerminal({
  machineId,
  target,
  title,
  typing = false,
  actions,
}: {
  machineId: string;
  target: TerminalTarget;
  title: ReactNode;
  typing?: boolean;
  actions?: ReactNode;
}) {
  const container = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const canInput = useMachines((s) => can(s.machines[machineId], "agents.input"));
  const online = useMachines((s) => s.machines[machineId]?.status.state === "online");
  const [error, setError] = useState<string | null>(null);
  const [closed, setClosed] = useState(false);
  // Bumped to open the terminal again (after a reconnection).
  const [session, setSession] = useState(0);
  const [interactive, setInteractive] = useState(typing);
  const interactiveRef = useRef(false);
  interactiveRef.current = interactive && canInput;
  const targetKey = "pane" in target ? `pane|${target.pane}` : target.agentId;

  useEffect(() => {
    if (!container.current) return;
    const term = new Terminal({
      fontFamily: '"JetBrains Mono", ui-monospace, monospace',
      fontSize: 12,
      lineHeight: 1.25,
      cursorBlink: false,
      convertEol: true,
      scrollback: 0,
      theme,
    });
    termRef.current = term;
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container.current);
    fit.fit();
    const observer = new ResizeObserver(() => fit.fit());
    observer.observe(container.current);
    const sub = term.onData((data) => {
      if (!interactiveRef.current) return;
      void app.terminalInput(machineId, target, toInput(data)).catch((e) => setError(errorMessage(e)));
    });

    let disposed = false;
    setClosed(false);
    setError(null);
    app
      .openTerminal(machineId, target, (msg) => {
        if (disposed) return;
        if (msg.type === "screen") {
          // Whole screen each time: clear, home, redraw.
          term.write(`\x1b[2J\x1b[H${msg.ansi.replace(/\n/g, "\r\n")}`);
          setError(null);
        } else if (msg.type === "error") {
          setError(msg.message);
        } else {
          setClosed(true);
          setError("Terminal closed");
        }
      })
      .catch((e) => {
        if (disposed) return;
        setClosed(true);
        setError(errorMessage(e));
      });

    return () => {
      disposed = true;
      termRef.current = null;
      sub.dispose();
      observer.disconnect();
      term.dispose();
      void app.closeTerminal(machineId, target);
    };
    // `target` is identified by `targetKey`.
  }, [machineId, targetKey, session]); // eslint-disable-line react-hooks/exhaustive-deps

  // Typing on: keystrokes go to xterm.
  useEffect(() => {
    if (interactive && canInput) termRef.current?.focus();
  }, [interactive, canInput, session]);

  // The connection came back: open the terminal again by itself.
  const wasOnline = useRef(online);
  useEffect(() => {
    if (online && !wasOnline.current && closed) setSession((n) => n + 1);
    wasOnline.current = online;
  }, [online, closed]);

  return (
    <div className="flex h-full flex-col bg-[#121418]">
      <div className="flex items-center gap-2 border-b border-border bg-surface px-4 py-2 text-[12px]">
        <span className="min-w-0 flex-1 truncate text-muted">{title}</span>
        {canInput ? (
          <button
            onClick={() => setInteractive(!interactive)}
            className={`flex items-center gap-1.5 rounded-lg px-2 py-1 ${interactive ? "bg-blocked/15 text-blocked" : "text-muted hover:bg-surface-high hover:text-text"}`}
            title="Send keystrokes to the terminal"
          >
            <Keyboard size={13} />
            {interactive ? "Typing on" : "Type"}
          </button>
        ) : (
          <span className="text-faint">read-only</span>
        )}
        {actions}
      </div>
      {error && (
        <div className="flex items-center gap-2 border-b border-border px-4 py-1.5 text-[12px] text-error">
          <span className="min-w-0 flex-1 truncate">{error}</span>
          {closed && (
            <button onClick={() => setSession((n) => n + 1)} disabled={!online} className="flex shrink-0 items-center gap-1 text-muted hover:text-text disabled:opacity-40">
              <RotateCw size={12} /> Reopen
            </button>
          )}
        </div>
      )}
      <div ref={container} className={`min-h-0 flex-1 ${interactive && canInput ? "ring-1 ring-inset ring-blocked/40" : ""}`} />
    </div>
  );
}
