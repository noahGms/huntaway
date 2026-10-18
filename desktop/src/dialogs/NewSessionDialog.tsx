import { FolderPlus, Hexagon, Sparkles } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api, errorMessage } from "../api/client";
import { Button, Kbd } from "../components/ui/Button";
import { Dialog, Field, inputClass } from "../components/ui/Dialog";
import { liveKey } from "../lib/conversations";
import { MOD } from "../lib/keys";
import { can, machineList, useMachines } from "../store/machines";
import { useUi } from "../store/ui";

const MODELS: Record<string, string[]> = {
  claude: ["opus", "sonnet", "haiku"],
  codex: ["gpt-5.4", "gpt-5.4-codex", "gpt-5.4-mini"],
};

const LAST_MACHINE = "new-session:machine";
const NEW_PROJECT = "__new__";

const HOME = /^(\/Users\/[^/]+|\/home\/[^/]+|\/root)(?=\/|$)/;

/** Home directory of the machine, guessed from its project folders. */
function guessHome(cwds: (string | null)[]): string | null {
  for (const cwd of cwds) {
    const m = cwd ? HOME.exec(cwd) : null;
    if (m) return m[1];
  }
  return null;
}

export function NewSessionDialog() {
  const { newSession, closeNewSession, select, toast } = useUi();
  const expect = useMachines((s) => s.expect);
  const all = machineList(useMachines((s) => s.machines));
  const machines = all.filter((m) => m.status.state === "online" && can(m, "agents.create"));
  const [chosenMachine, setMachineId] = useState("");
  const [chosenWorkspace, setWorkspace] = useState("");
  const [newPath, setNewPath] = useState("");
  const [kind, setKind] = useState<"claude" | "codex">("claude");
  const [model, setModel] = useState("");
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!newSession.open) return;
    const preferred = newSession.machineId ?? localStorage.getItem(LAST_MACHINE) ?? "";
    setMachineId(machines.some((m) => m.record.machine_id === preferred) ? preferred : (machines[0]?.record.machine_id ?? ""));
    setWorkspace(newSession.workspace ?? "");
    setPrompt("");
    setModel("");
    setNewPath("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [newSession.open]);

  // The selects always show a real option: a machine gone offline or a
  // project of another machine falls back to the first one.
  const machineId = machines.some((m) => m.record.machine_id === chosenMachine) ? chosenMachine : (machines[0]?.record.machine_id ?? "");
  const machine = machines.find((m) => m.record.machine_id === machineId);
  const sessions = machine?.snapshot?.sessions ?? [];
  const workspaces = useMemo(() => {
    const list = machine?.snapshot?.workspaces ?? [];
    // Projects with recent agents first.
    const agents = machine?.snapshot?.agents ?? [];
    const last = (session: string, id: string) =>
      Math.max(0, ...agents.filter((a) => a.session === session && a.workspace_id === id).map((a) => Date.parse(a.last_activity_at ?? "") || 0));
    return [...list].sort((a, b) => last(b.session, b.workspace_id) - last(a.session, a.workspace_id));
  }, [machine]);

  const options = workspaces.filter((w) => sessions.some((s) => s.name === w.session)).map((w) => `${w.session}|${w.workspace_id}`);
  const workspace = chosenWorkspace === NEW_PROJECT || options.includes(chosenWorkspace) ? chosenWorkspace : (options[0] ?? NEW_PROJECT);
  const home = guessHome(workspaces.map((w) => w.cwd));
  // `~/x` is expanded with the machine's home when it can be guessed.
  const path = newPath.trim().startsWith("~/") && home ? home + newPath.trim().slice(1) : newPath.trim();
  const pathError =
    workspace === NEW_PROJECT && path && !path.startsWith("/")
      ? path.startsWith("~")
        ? "Use the full path: the home folder of this machine is unknown."
        : "Use an absolute path (starting with /)."
      : null;

  const submit = async () => {
    if (!machine) return;
    setBusy(true);
    try {
      let session: string;
      let workspaceId: string;
      if (workspace === NEW_PROJECT) {
        session = sessions.find((s) => s.name === "default")?.name ?? sessions[0]?.name;
        if (!session) throw new Error("No Herdr session running on this machine");
        const r = await api.createWorkspace(machine.record.machine_id, { session, cwd: path });
        workspaceId = r.workspace_id;
      } else {
        [session, workspaceId] = workspace.split("|");
      }
      const r = await api.createAgent(machine.record.machine_id, { session, workspace_id: workspaceId, kind, prompt: prompt.trim(), model: model.trim() || undefined });
      localStorage.setItem(LAST_MACHINE, machine.record.machine_id);
      closeNewSession();
      const key = liveKey(machine.record.machine_id, r.agent_id);
      expect(key);
      select(key);
      toast(r.prompt_sent || !prompt.trim() ? "Session started" : "Session started: the agent is waiting for an answer before your prompt", r.prompt_sent ? "success" : "info");
    } catch (e) {
      toast(errorMessage(e), "error");
    } finally {
      setBusy(false);
    }
  };

  const valid = !!machine && (workspace === NEW_PROJECT ? path.startsWith("/") : !!workspace);

  return (
    <Dialog open={newSession.open} onOpenChange={(o) => !o && closeNewSession()} title="New session" description="Start an agent in a Herdr project, on the machine of your choice." width={560}>
      {machines.length === 0 ? (
        <p className="text-[13px] leading-relaxed text-muted">
          No online machine lets this device create agents. The local machine always does; for a server, pair it with <code className="font-mono">huntawayd pair --full --link</code>.
        </p>
      ) : (
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (valid) void submit();
          }}
        >
          <div className="grid grid-cols-2 gap-3">
            <Field label="Machine">
              <select
                value={machineId}
                onChange={(e) => {
                  setMachineId(e.target.value);
                  setWorkspace("");
                }}
                className={inputClass}
              >
                {machines.map((m) => (
                  <option key={m.record.machine_id} value={m.record.machine_id}>
                    {m.record.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Project">
              <select value={workspace} onChange={(e) => setWorkspace(e.target.value)} className={inputClass}>
                {sessions.map((s) => (
                  <optgroup key={s.name} label={sessions.length > 1 ? `Session ${s.name}` : "Herdr projects"}>
                    {workspaces
                      .filter((w) => w.session === s.name)
                      .map((w) => (
                        <option key={`${w.session}|${w.workspace_id}`} value={`${w.session}|${w.workspace_id}`}>
                          {w.label || w.workspace_id}
                          {w.cwd ? `  —  ${w.cwd.replace(HOME, "~")}` : ""}
                        </option>
                      ))}
                  </optgroup>
                ))}
                <option value={NEW_PROJECT}>+ New project from a folder…</option>
              </select>
            </Field>
          </div>
          {workspace === NEW_PROJECT && (
            <Field label="Project folder" hint={pathError ?? "Absolute path on the machine (~ works). A Herdr workspace is created there."}>
              <div className="relative">
                <FolderPlus size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-faint" />
                <input autoFocus value={newPath} onChange={(e) => setNewPath(e.target.value)} placeholder={`${home ?? "/home/me"}/projects/my-app`} className={`${inputClass} pl-8 font-mono text-[12px]`} />
              </div>
            </Field>
          )}
          <div className="grid grid-cols-2 gap-3">
            <Field label="Agent">
              <div className="grid grid-cols-2 gap-1.5">
                {(["claude", "codex"] as const).map((k) => (
                  <button
                    key={k}
                    type="button"
                    onClick={() => {
                      setKind(k);
                      setModel("");
                    }}
                    className={`flex h-[38px] items-center justify-center gap-2 rounded-[10px] border text-[13px] transition-colors ${
                      kind === k ? "border-[#4a515c] bg-surface-high text-text" : "border-border text-muted hover:text-text"
                    }`}
                  >
                    {k === "claude" ? <Sparkles size={14} className="text-claude" /> : <Hexagon size={14} className="text-codex" />}
                    {k === "claude" ? "Claude Code" : "Codex"}
                  </button>
                ))}
              </div>
            </Field>
            <Field label="Model (optional)">
              <input list={`models-${kind}`} value={model} onChange={(e) => setModel(e.target.value)} placeholder="default" className={inputClass} />
              <datalist id={`models-${kind}`}>
                {MODELS[kind].map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
            </Field>
          </div>
          <Field label="Prompt">
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && valid) {
                  e.preventDefault();
                  void submit();
                }
              }}
              rows={5}
              placeholder="What should the agent do?"
              className={`${inputClass} resize-none leading-relaxed`}
            />
          </Field>
          <div className="flex items-center justify-end gap-2 pt-1">
            <span className="mr-auto flex items-center gap-1 text-[11.5px] text-faint">
              <Kbd>{MOD}</Kbd>
              <Kbd>↵</Kbd> to start
            </span>
            <Button type="button" variant="ghost" onClick={closeNewSession}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" loading={busy} disabled={!valid}>
              Start session
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}
