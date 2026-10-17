import { ChevronLeft, GitBranch, RefreshCw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api, errorMessage } from "../../api/client";
import type { GitStatus, StoredItem } from "../../api/types";
import { computeActivity } from "../../lib/activity";
import type { Conversation } from "../../lib/conversations";
import { changeDiff, parsePatch, type Diff } from "../../lib/diff";
import { clockTime, shortPath } from "../../lib/format";
import { can, useMachines } from "../../store/machines";
import { useUi } from "../../store/ui";
import { IconButton, Spinner } from "../ui/Button";
import { DiffView } from "../conversation/DiffView";

/** Every edit of `path` in the conversation, one diff after the other. */
function editsDiff(items: StoredItem[], path: string): Diff {
  const out: Diff = { lines: [], additions: 0, deletions: 0 };
  for (const it of items) {
    if (it.type !== "tool_call" || it.kind !== "file_modified" || (it.change?.path ?? it.summary) !== path || !it.change) continue;
    const d = changeDiff(it.change);
    out.lines.push({ type: "hunk", text: `Modification de ${clockTime(it.timestamp)}` }, ...d.lines);
    out.additions += d.additions;
    out.deletions += d.deletions;
  }
  return out;
}

const STATUS_LABEL: Record<string, string> = { M: "modifié", A: "ajouté", D: "supprimé", R: "renommé", "?": "nouveau", U: "conflit" };

export function FilesTab({ conv }: { conv: Conversation }) {
  const timeline = useMachines((s) => s.timelines[conv.key]);
  const machine = useMachines((s) => s.machines[conv.machineId]);
  const { focusedFile, focusFile } = useUi();
  const items = timeline?.items ?? [];
  const activity = useMemo(() => computeActivity(items), [items]);
  const [git, setGit] = useState<GitStatus | null>(null);
  const [gitError, setGitError] = useState<string | null>(null);
  const [gitLoading, setGitLoading] = useState(false);
  const [gitFile, setGitFile] = useState<{ path: string; diff: Diff | null; error?: string } | null>(null);
  const canGit = conv.live && !!conv.agentId && can(machine, "files.read");

  const loadGit = async () => {
    if (!canGit) return;
    setGitLoading(true);
    try {
      setGit(await api.gitStatus(conv.machineId, conv.agentId!));
      setGitError(null);
    } catch (e) {
      setGitError(errorMessage(e));
    } finally {
      setGitLoading(false);
    }
  };

  useEffect(() => {
    setGit(null);
    setGitFile(null);
    void loadGit();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conv.key]);

  const openGitFile = async (path: string) => {
    setGitFile({ path, diff: null });
    try {
      const { diff } = await api.gitDiff(conv.machineId, conv.agentId!, path);
      setGitFile({ path, diff: parsePatch(diff) });
    } catch (e) {
      setGitFile({ path, diff: null, error: errorMessage(e) });
    }
  };

  if (focusedFile) {
    const diff = editsDiff(items, focusedFile);
    return (
      <div>
        <div className="flex items-center gap-2 border-b border-border px-3 py-2">
          <IconButton label="Retour" onClick={() => focusFile(null)}>
            <ChevronLeft size={15} />
          </IconButton>
          <span className="selectable min-w-0 flex-1 truncate font-mono text-[12px]" title={focusedFile}>
            {shortPath(focusedFile, 4)}
          </span>
          <span className="font-mono text-[11px] text-done">
            +{diff.additions} <span className="text-error">−{diff.deletions}</span>
          </span>
        </div>
        {diff.lines.length ? <DiffView diff={diff} maxHeight={10_000} /> : <p className="p-5 text-[12.5px] text-muted">Pas de contenu pour ce fichier.</p>}
      </div>
    );
  }

  if (gitFile) {
    return (
      <div>
        <div className="flex items-center gap-2 border-b border-border px-3 py-2">
          <IconButton label="Retour" onClick={() => setGitFile(null)}>
            <ChevronLeft size={15} />
          </IconButton>
          <span className="selectable min-w-0 flex-1 truncate font-mono text-[12px]">{gitFile.path}</span>
          {gitFile.diff && (
            <span className="font-mono text-[11px] text-done">
              +{gitFile.diff.additions} <span className="text-error">−{gitFile.diff.deletions}</span>
            </span>
          )}
        </div>
        {gitFile.error ? (
          <p className="p-5 text-[12.5px] text-error">{gitFile.error}</p>
        ) : gitFile.diff ? (
          gitFile.diff.lines.length ? <DiffView diff={gitFile.diff} maxHeight={10_000} /> : <p className="p-5 text-[12.5px] text-muted">Aucune différence avec HEAD.</p>
        ) : (
          <div className="flex justify-center p-6 text-muted"><Spinner /></div>
        )}
      </div>
    );
  }

  return (
    <div className="pb-6">
      <section className="px-5 pt-5">
        <h3 className="mb-2 text-[13px] font-semibold">Modifiés par l'agent</h3>
        {activity.files.length === 0 ? (
          <p className="text-[12.5px] text-faint">Aucun fichier modifié dans cette conversation.</p>
        ) : (
          <ul className="overflow-hidden rounded-xl border border-border">
            {activity.files.map((f) => (
              <li key={f.path}>
                <button onClick={() => focusFile(f.path)} className="flex w-full items-center gap-2 border-b border-border px-3 py-2 text-left last:border-0 hover:bg-surface-high/60">
                  <span className="min-w-0 flex-1 truncate font-mono text-[12px]" title={f.path}>
                    {shortPath(f.path, 3)}
                  </span>
                  {f.edits > 1 && <span className="text-[11px] text-faint">{f.edits}×</span>}
                  <span className="font-mono text-[11px] text-done">
                    +{f.additions}
                    {f.deletions > 0 && <span className="text-error"> −{f.deletions}</span>}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {canGit && (
        <section className="px-5 pt-6">
          <div className="mb-2 flex items-center justify-between">
            <h3 className="flex items-center gap-1.5 text-[13px] font-semibold">
              <GitBranch size={14} className="text-muted" />
              Git{git?.branch && <span className="font-mono text-[11.5px] font-normal text-muted">· {git.branch}</span>}
            </h3>
            <IconButton label="Rafraîchir" onClick={() => void loadGit()} disabled={gitLoading}>
              {gitLoading ? <Spinner /> : <RefreshCw size={13} />}
            </IconButton>
          </div>
          {gitError ? (
            <p className="text-[12.5px] text-faint">{gitError.includes("not a git") ? "Ce projet n'est pas un dépôt git." : gitError}</p>
          ) : git && git.files.length === 0 ? (
            <p className="text-[12.5px] text-faint">Arbre de travail propre.</p>
          ) : git ? (
            <ul className="overflow-hidden rounded-xl border border-border">
              {git.files.slice(0, 300).map((f) => {
                const code = f.status.trim().charAt(0) || "?";
                return (
                  <li key={f.path}>
                    <button onClick={() => void openGitFile(f.path)} className="flex w-full items-center gap-2 border-b border-border px-3 py-2 text-left last:border-0 hover:bg-surface-high/60">
                      <span className={`w-4 font-mono text-[11px] ${code === "D" ? "text-error" : code === "?" || code === "A" ? "text-done" : "text-blocked"}`} title={STATUS_LABEL[code]}>
                        {code === "?" ? "N" : code}
                      </span>
                      <span className="min-w-0 flex-1 truncate font-mono text-[12px]" title={f.path}>
                        {f.path}
                      </span>
                      {f.additions !== null && (
                        <span className="font-mono text-[11px] text-done">
                          +{f.additions}
                          {!!f.deletions && <span className="text-error"> −{f.deletions}</span>}
                        </span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : (
            <div className="flex justify-center p-4 text-muted"><Spinner /></div>
          )}
        </section>
      )}
    </div>
  );
}
