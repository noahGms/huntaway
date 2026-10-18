import { MoreHorizontal, Pencil, Play, Plus, RotateCw, Square, SquareTerminal, Trash2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { api, errorMessage } from "../../api/client";
import type { ScriptView, ShellView } from "../../api/types";
import { compactAge } from "../../lib/conversations";
import { can, useMachines } from "../../store/machines";
import { canonicalPath, scriptsOf, scriptStatus, shellsOf, useProjects } from "../../store/projects";
import { useUi } from "../../store/ui";
import { Button, IconButton } from "../ui/Button";
import { Dialog, Field, inputClass } from "../ui/Dialog";
import { Menu, MenuItem } from "../ui/Menu";
import { Badge } from "../ui/Status";
import { LiveTerminal } from "../terminal/LiveTerminal";

const statusDot = { running: "bg-done animate-pulse-dot", exited: "bg-blocked", stopped: "bg-faint/60" } as const;
const statusText = { running: "running", exited: "exited", stopped: "stopped" } as const;

/** Runs a script action, with a toast on failure. */
export async function scriptAction(machineId: string, path: string, name: string, action: "start" | "stop" | "restart"): Promise<boolean> {
  try {
    if (action === "start") await api.startScript(machineId, path, name);
    else if (action === "stop") await api.stopScript(machineId, path, name);
    else await api.restartScript(machineId, path, name);
    return true;
  } catch (e) {
    useUi.getState().toast(errorMessage(e), "error");
    return false;
  }
}

/** Opens a new shell in a project and shows it under the project page. */
export async function openShell(machineId: string, path: string, project: string): Promise<void> {
  try {
    const { shell } = await api.openShell(machineId, path);
    useProjects.getState().openTerminal({ machineId, path: shell.path, pane: shell.pane, kind: "shell", title: `Shell · ${project}` });
  } catch (e) {
    useUi.getState().toast(errorMessage(e), "error");
  }
}

/** Scripts and shells of a project (`cwd`): start/stop its services, open terminals. */
export function ProjectTools({ machineId, cwd, project }: { machineId: string; cwd: string; project: string }) {
  const machine = useMachines((s) => s.machines[machineId]);
  const online = machine?.status.state === "online";
  const canRead = can(machine, "scripts.read");
  const canRun = can(machine, "scripts.run") && online;
  const canEdit = can(machine, "scripts.edit") && online;
  const canShells = can(machine, "terminal.read");
  const canOpen = can(machine, "terminal.open") && online;
  const scripts = useProjects((s) => scriptsOf(s, machineId, cwd));
  const shells = useProjects((s) => shellsOf(s, machineId, cwd));
  const error = useProjects((s) => s.errors[`${machineId}|${cwd}`]);
  const path = useProjects((s) => canonicalPath(s.aliases, machineId, cwd));
  const { loadScripts, loadShells, openTerminal } = useProjects();
  const [editing, setEditing] = useState<{ script?: ScriptView; name?: string; cmd?: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  // Read the project file again each time the page opens.
  useEffect(() => {
    if (!online) return;
    if (canRead) void loadScripts(machineId, cwd);
    if (canShells) void loadShells(machineId, cwd);
  }, [machineId, cwd, online, canRead, canShells, loadScripts, loadShells]);

  if (!canRead && !canShells) return null;

  const act = async (name: string, action: "start" | "stop" | "restart") => {
    setBusy(`${name}:${action}`);
    await scriptAction(machineId, path, name, action);
    setBusy(null);
  };
  const logs = (s: ScriptView) => s.pane && openTerminal({ machineId, path, pane: s.pane, kind: "script", title: s.name });
  const remove = async (s: ScriptView) => {
    try {
      await api.deleteScript(machineId, path, s.name);
    } catch (e) {
      useUi.getState().toast(errorMessage(e), "error");
    }
  };
  const addSuggestion = async (name: string, cmd: string, cwd: string | null) => {
    try {
      await api.saveScript(machineId, { path, name, cmd, cwd: cwd ?? undefined });
      void loadScripts(machineId, path);
    } catch (e) {
      useUi.getState().toast(errorMessage(e), "error");
    }
  };
  const closeShell = async (sh: ShellView) => {
    try {
      await api.closeShell(machineId, sh.pane);
    } catch (e) {
      useUi.getState().toast(errorMessage(e), "error");
    }
  };

  return (
    <div className="border-b border-border px-6 py-3">
      {canRead && (
        <section>
          <div className="mb-1.5 flex items-center gap-2">
            <h2 className="flex-1 text-[11.5px] font-medium uppercase tracking-wide text-faint">Scripts</h2>
            {canEdit && (
              <Button size="sm" variant="ghost" icon={<Plus size={13} />} onClick={() => setEditing({})}>
                Add
              </Button>
            )}
          </div>
          {error && !scripts && <p className="text-[12px] text-error">{error}</p>}
          {scripts?.file_error && <p className="mb-1.5 text-[12px] text-error">{scripts.file_error}</p>}
          {scripts && scripts.scripts.length === 0 && (
            <p className="text-[12px] text-muted">
              No scripts. Add a <code className="font-mono text-text">[scripts]</code> table to <code className="font-mono text-text">.huntaway.toml</code> at the project root
              {canEdit ? ", or add one here." : "."}
            </p>
          )}
          {scripts?.scripts.map((s) => {
            const status = scriptStatus(s);
            return (
              <div key={s.name} className="group flex h-8 items-center gap-2.5 text-[13px]">
                <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${statusDot[status]}`} title={statusText[status]} />
                <span className="w-32 shrink-0 truncate font-medium">{s.name}</span>
                <span className="selectable min-w-0 flex-1 truncate font-mono text-[11.5px] text-muted" title={s.cwd ? `${s.cmd}  (in ${s.cwd})` : s.cmd}>
                  {s.cmd || "no longer defined"}
                </span>
                <span className="w-14 shrink-0 text-right text-[11.5px] text-faint">{statusText[status]}</span>
                {s.source !== "file" && <Badge>{s.source === "app" ? "app" : "removed"}</Badge>}
                <div className="flex shrink-0 items-center gap-0.5">
                  {status === "running" ? (
                    <>
                      <IconButton label="Stop" disabled={!canRun || !!busy} onClick={() => void act(s.name, "stop")}>
                        <Square size={13} />
                      </IconButton>
                      <IconButton label="Restart" disabled={!canRun || !!busy || s.source === "removed"} onClick={() => void act(s.name, "restart")}>
                        <RotateCw size={13} />
                      </IconButton>
                    </>
                  ) : status === "exited" && s.source === "removed" ? (
                    <IconButton label="Close its tab" disabled={!canRun || !!busy} onClick={() => void act(s.name, "stop")}>
                      <X size={13} />
                    </IconButton>
                  ) : (
                    <IconButton label="Start" disabled={!canRun || !!busy || s.source === "removed"} onClick={() => void act(s.name, "start")}>
                      <Play size={13} />
                    </IconButton>
                  )}
                  <IconButton label="Logs" disabled={!s.pane} onClick={() => logs(s)}>
                    <SquareTerminal size={13} />
                  </IconButton>
                  {s.source === "app" && canEdit && (
                    <Menu
                      trigger={
                        <IconButton label="More">
                          <MoreHorizontal size={13} />
                        </IconButton>
                      }
                    >
                      <MenuItem icon={<Pencil size={13} />} onSelect={() => setEditing({ script: s })}>
                        Edit
                      </MenuItem>
                      <MenuItem icon={<Trash2 size={13} />} danger onSelect={() => void remove(s)}>
                        Delete
                      </MenuItem>
                    </Menu>
                  )}
                </div>
              </div>
            );
          })}
          {canEdit && scripts && scripts.suggestions.length > 0 && (
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              <span className="text-[11.5px] text-faint">Found in the project:</span>
              {scripts.suggestions.map((sg) => (
                <button
                  key={`${sg.origin}:${sg.name}`}
                  onClick={() => void addSuggestion(sg.name, sg.cmd, sg.cwd)}
                  title={`Add “${sg.cmd}” (${sg.origin})`}
                  className="flex items-center gap-1 rounded-md border border-border px-1.5 py-[1px] text-[11.5px] text-muted hover:bg-surface-high hover:text-text"
                >
                  <Plus size={11} />
                  {sg.name}
                </button>
              ))}
            </div>
          )}
        </section>
      )}
      {canShells && (
        <section className={canRead ? "mt-3" : ""}>
          <div className="mb-1.5 flex items-center gap-2">
            <h2 className="flex-1 text-[11.5px] font-medium uppercase tracking-wide text-faint">Terminals</h2>
            {canOpen && (
              <Button size="sm" variant="ghost" icon={<SquareTerminal size={13} />} onClick={() => void openShell(machineId, path, project)}>
                Open terminal
              </Button>
            )}
          </div>
          {(shells ?? []).length === 0 && <p className="text-[12px] text-muted">No shell opened from Huntaway in this project.</p>}
          {shells?.map((sh, i) => (
            <div key={sh.pane} className="flex h-8 items-center gap-2.5 text-[13px]">
              <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${sh.busy ? "bg-working" : "bg-faint/60"}`} />
              <span className="min-w-0 flex-1 truncate">
                Shell {i + 1} <span className="text-[11.5px] text-faint">· opened {compactAge(new Date(sh.opened_at * 1000).toISOString())} ago</span>
              </span>
              <span className="text-[11.5px] text-faint">{sh.busy ? "busy" : "idle"}</span>
              <IconButton label="Open" onClick={() => openTerminal({ machineId, path, pane: sh.pane, kind: "shell", title: `Shell ${i + 1} · ${project}` })}>
                <SquareTerminal size={13} />
              </IconButton>
              <IconButton label="Close" disabled={!canOpen} onClick={() => void closeShell(sh)}>
                <X size={13} />
              </IconButton>
            </div>
          ))}
        </section>
      )}
      {editing && <ScriptDialog machineId={machineId} path={path} initial={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

/** Adds or edits a script stored by the daemon. */
function ScriptDialog({
  machineId,
  path,
  initial,
  onClose,
}: {
  machineId: string;
  path: string;
  initial: { script?: ScriptView; name?: string; cmd?: string };
  onClose: () => void;
}) {
  const [name, setName] = useState(initial.script?.name ?? initial.name ?? "");
  const [cmd, setCmd] = useState(initial.script?.cmd ?? initial.cmd ?? "");
  const [cwd, setCwd] = useState(initial.script?.cwd ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await api.saveScript(machineId, { path, name: name.trim(), cmd, cwd: cwd.trim() || undefined, rename_from: initial.script?.name });
      // Suggestions may change too (events carry none).
      void useProjects.getState().loadScripts(machineId, path);
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={initial.script ? `Edit ${initial.script.name}` : "Add a script"}
      description="Stored by the daemon on this machine. To share it with the project, add it to .huntaway.toml instead."
    >
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <Field label="Name">
          <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} placeholder="dev" autoFocus />
        </Field>
        <Field label="Command">
          <input className={`${inputClass} font-mono`} value={cmd} onChange={(e) => setCmd(e.target.value)} placeholder="npm run dev" />
        </Field>
        <Field label="Directory" hint="Relative to the project root. Empty: the project root.">
          <input className={`${inputClass} font-mono`} value={cwd} onChange={(e) => setCwd(e.target.value)} placeholder="." />
        </Field>
        {error && <p className="text-[12px] text-error">{error}</p>}
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={saving} disabled={!name.trim() || !cmd.trim()}>
            Save
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/** The script logs or shell opened on the project page. */
export function ProjectTerminalPanel({ machineId, cwd }: { machineId: string; cwd: string }) {
  const terminal = useProjects((s) => s.terminal);
  const path = useProjects((s) => canonicalPath(s.aliases, machineId, cwd));
  const openTerminal = useProjects((s) => s.openTerminal);
  const shells = useProjects((s) => shellsOf(s, machineId, cwd));
  if (!terminal || terminal.machineId !== machineId || terminal.path !== path) return null;
  const shell = terminal.kind === "shell" ? shells?.find((s) => s.pane === terminal.pane) : undefined;
  const close = (
    <IconButton label="Hide the terminal" onClick={() => openTerminal(null)}>
      <X size={14} />
    </IconButton>
  );
  return (
    <div className="h-[46%] min-h-[220px] shrink-0 border-t border-border">
      <LiveTerminal
        key={terminal.pane}
        machineId={machineId}
        target={{ pane: terminal.pane }}
        title={terminal.kind === "script" ? `Logs of ${terminal.title}` : terminal.title}
        typing={terminal.kind === "shell"}
        actions={
          <>
            {shell && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => void api.closeShell(machineId, shell.pane).catch((e) => useUi.getState().toast(errorMessage(e), "error"))}
              >
                Close shell
              </Button>
            )}
            {close}
          </>
        }
      />
    </div>
  );
}
