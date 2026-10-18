import { FolderGit2, Plus, Star } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Virtuoso } from "react-virtuoso";
import { api } from "../api/client";
import type { HistoryEntry } from "../api/types";
import { Button } from "../components/ui/Button";
import { AgentIcon, StatusDot } from "../components/ui/Status";
import { useConversations } from "../hooks/useConversations";
import { compactAge, compareConversations, fromHistory, longDate, projectKey, statusLabel, type Conversation } from "../lib/conversations";
import { useMachines } from "../store/machines";
import { usePrefs } from "../store/prefs";
import { useUi } from "../store/ui";
import { PageHeader } from "./ServersPage";

/** One project of one machine: its conversations, and new sessions in its workspace. */
export function ProjectPage() {
  const project = useUi((s) => s.project);
  const { select, openNewSession } = useUi();
  const machine = useMachines((s) => (project ? s.machines[project.machineId] : undefined));
  const conversations = useConversations();
  const favorites = usePrefs((s) => s.favorites);
  const toggleFavorite = usePrefs((s) => s.toggleFavorite);
  const [older, setOlder] = useState<HistoryEntry[]>([]);
  const online = machine?.status.state === "online";

  // The sidebar only knows the recent history: fetch the project's own.
  useEffect(() => {
    setOlder([]);
    if (!project || !online) return;
    let alive = true;
    api
      .history(project.machineId, { project: project.project, limit: 100 })
      .then((page) => alive && setOlder(page.entries))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [project?.machineId, project?.project, online]); // eslint-disable-line react-hooks/exhaustive-deps

  const list = useMemo(() => {
    if (!project || !machine) return [];
    const own = conversations.filter((c) => c.machineId === project.machineId && c.project === project.project);
    const seen = new Set(own.map((c) => c.key));
    const running = new Set(own.map((c) => c.agent?.native_session).filter(Boolean));
    const extra: Conversation[] = older
      .filter((e) => !e.live_agent_id && !running.has(e.session_id))
      .map((e) => fromHistory(machine, e))
      .filter((c) => !seen.has(c.key));
    return [...own, ...extra].sort(compareConversations);
  }, [conversations, older, project, machine]);

  if (!project || !machine) {
    return (
      <div className="flex h-full flex-col">
        <PageHeader title="Project" />
        <p className="p-6 text-[13px] text-muted">This project is no longer available.</p>
      </div>
    );
  }

  const key = projectKey(project.machineId, project.project);
  const favorite = favorites.includes(key);
  const agent = list.find((c) => c.agent)?.agent;
  const cwd = list.find((c) => c.cwd)?.cwd;
  const live = list.filter((c) => c.live).length;
  const waiting = list.filter((c) => c.attention?.status === "blocked").length;

  return (
    <div className="flex h-full flex-col">
      <PageHeader title={`${project.project} @ ${machine.record.name}`}>
        <Button size="sm" variant="ghost" icon={<Star size={13} className={favorite ? "text-blocked" : ""} fill={favorite ? "currentColor" : "none"} />} onClick={() => toggleFavorite(key)}>
          {favorite ? "Favorite" : "Add to favorites"}
        </Button>
        <Button
          size="sm"
          variant="primary"
          icon={<Plus size={14} />}
          disabled={!online}
          onClick={() => openNewSession({ machineId: project.machineId, workspace: agent ? `${agent.session}|${agent.workspace_id}` : undefined })}
        >
          New session here
        </Button>
      </PageHeader>
      <div className="flex items-center gap-4 border-b border-border px-6 py-2.5 text-[12px] text-muted">
        <span className="flex min-w-0 items-center gap-1.5">
          <FolderGit2 size={13} className="shrink-0 text-faint" />
          <span className="selectable truncate font-mono text-[11.5px]">{cwd ?? "—"}</span>
        </span>
        <span className="ml-auto shrink-0">
          {live} running · {list.length} conversation{list.length === 1 ? "" : "s"}
        </span>
        {waiting > 0 && <span className="shrink-0 text-blocked">{waiting} waiting</span>}
      </div>
      <div className="min-h-0 flex-1">
        {list.length === 0 ? (
          <p className="p-6 text-[13px] text-muted">No conversations.</p>
        ) : (
          <Virtuoso
            data={list}
            computeItemKey={(_, c) => c.key}
            itemContent={(_, c) => (
              <button onClick={() => select(c.key)} className="flex h-9 w-full items-center gap-3 border-b border-border px-6 text-left hover:bg-surface/70">
                <span className="flex w-3 shrink-0 justify-center">
                  <StatusDot attention={c.attention} size={7} />
                </span>
                <AgentIcon kind={c.kind} size={13} />
                <span className={`min-w-0 flex-1 truncate text-[13px] ${c.live ? "" : "text-muted"}`}>{c.title}</span>
                <span className={`shrink-0 text-[11.5px] ${c.attention?.status === "blocked" ? "text-blocked" : "text-faint"}`}>{statusLabel(c.attention)}</span>
                <span className="w-10 shrink-0 text-right text-[11.5px] tabular-nums text-faint" title={longDate(c.lastActivity)}>
                  {compactAge(c.lastActivity)}
                </span>
              </button>
            )}
          />
        )}
      </div>
    </div>
  );
}
