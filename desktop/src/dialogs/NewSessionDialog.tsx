import { FolderPlus, Hexagon, Sparkles } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api, errorMessage } from "../api/client";
import { Button, Kbd } from "../components/ui/Button";
import { Dialog, Field, inputClass } from "../components/ui/Dialog";
import { liveKey } from "../lib/conversations";
import { can, machineList, useMachines } from "../store/machines";
import { useUi } from "../store/ui";

const MODELS: Record<string, string[]> = {
  claude: ["opus", "sonnet", "haiku"],
  codex: ["gpt-5.4", "gpt-5.4-codex", "gpt-5.4-mini"],
};

const LAST_MACHINE = "new-session:machine";
const NEW_PROJECT = "__new__";

export function NewSessionDialog() {
  const { newSession, closeNewSession, select, toast } = useUi();
  const all = machineList(useMachines((s) => s.machines));
  const machines = all.filter((m) => m.status.state === "online" && can(m, "agents.create"));
  const [machineId, setMachineId] = useState("");
  const [workspace, setWorkspace] = useState("");
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

  const machine = all.find((m) => m.record.machine_id === machineId);
  const sessions = machine?.snapshot?.sessions ?? [];
  const workspaces = useMemo(() => {
    const list = machine?.snapshot?.workspaces ?? [];
    // Projects with recent agents first.
    const agents = machine?.snapshot?.agents ?? [];
    const last = (session: string, id: string) =>
      Math.max(0, ...agents.filter((a) => a.session === session && a.workspace_id === id).map((a) => Date.parse(a.last_activity_at ?? "") || 0));
    return [...list].sort((a, b) => last(b.session, b.workspace_id) - last(a.session, a.workspace_id));
  }, [machine]);

  useEffect(() => {
    if (!workspace && workspaces[0]) setWorkspace(`${workspaces[0].session}|${workspaces[0].workspace_id}`);
  }, [workspaces, workspace]);

  const submit = async () => {
    if (!machine) return;
    setBusy(true);
    try {
      let session: string;
      let workspaceId: string;
      if (workspace === NEW_PROJECT) {
        session = sessions.find((s) => s.name === "default")?.name ?? sessions[0]?.name;
        if (!session) throw new Error("Aucune session Herdr active sur cette machine");
        const r = await api.createWorkspace(machine.record.machine_id, { session, cwd: newPath.trim() });
        workspaceId = r.workspace_id;
      } else {
        [session, workspaceId] = workspace.split("|");
      }
      const r = await api.createAgent(machine.record.machine_id, { session, workspace_id: workspaceId, kind, prompt: prompt.trim(), model: model.trim() || undefined });
      localStorage.setItem(LAST_MACHINE, machine.record.machine_id);
      closeNewSession();
      select(liveKey(machine.record.machine_id, r.agent_id));
      toast(r.prompt_sent || !prompt.trim() ? "Session lancée" : "Session lancée : l'agent attend une réponse avant ta consigne", r.prompt_sent ? "success" : "info");
    } catch (e) {
      toast(errorMessage(e), "error");
    } finally {
      setBusy(false);
    }
  };

  const valid = !!machine && (workspace === NEW_PROJECT ? newPath.trim().startsWith("/") : !!workspace);

  return (
    <Dialog open={newSession.open} onOpenChange={(o) => !o && closeNewSession()} title="Nouvelle session" description="Lance un agent dans un projet Herdr, sur la machine de ton choix." width={560}>
      {machines.length === 0 ? (
        <p className="text-[13px] leading-relaxed text-muted">
          Aucune machine en ligne ne permet de créer des agents. La machine locale le permet toujours ; pour un serveur, appaire-le avec <code className="font-mono">huntawayd pair --full --link</code>.
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
            <Field label="Projet">
              <select value={workspace} onChange={(e) => setWorkspace(e.target.value)} className={inputClass}>
                {sessions.map((s) => (
                  <optgroup key={s.name} label={sessions.length > 1 ? `Session ${s.name}` : "Projets Herdr"}>
                    {workspaces
                      .filter((w) => w.session === s.name)
                      .map((w) => (
                        <option key={`${w.session}|${w.workspace_id}`} value={`${w.session}|${w.workspace_id}`}>
                          {w.label || w.workspace_id}
                          {w.cwd ? `  —  ${w.cwd.replace(/^\/Users\/[^/]+/, "~")}` : ""}
                        </option>
                      ))}
                  </optgroup>
                ))}
                <option value={NEW_PROJECT}>+ Nouveau projet à partir d'un dossier…</option>
              </select>
            </Field>
          </div>
          {workspace === NEW_PROJECT && (
            <Field label="Dossier du projet" hint="Chemin absolu sur la machine. Un espace de travail Herdr y sera créé.">
              <div className="relative">
                <FolderPlus size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-faint" />
                <input autoFocus value={newPath} onChange={(e) => setNewPath(e.target.value)} placeholder="/Users/moi/Developer/mon-projet" className={`${inputClass} pl-8 font-mono text-[12px]`} />
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
            <Field label="Modèle (facultatif)">
              <input list={`models-${kind}`} value={model} onChange={(e) => setModel(e.target.value)} placeholder="par défaut" className={inputClass} />
              <datalist id={`models-${kind}`}>
                {MODELS[kind].map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
            </Field>
          </div>
          <Field label="Consigne">
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
              placeholder="Que doit faire l'agent ?"
              className={`${inputClass} resize-none leading-relaxed`}
            />
          </Field>
          <div className="flex items-center justify-end gap-2 pt-1">
            <span className="mr-auto flex items-center gap-1 text-[11.5px] text-faint">
              <Kbd>⌘</Kbd>
              <Kbd>↵</Kbd> pour lancer
            </span>
            <Button type="button" variant="ghost" onClick={closeNewSession}>
              Annuler
            </Button>
            <Button type="submit" variant="primary" loading={busy} disabled={!valid}>
              Lancer la session
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}
