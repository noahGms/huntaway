// Stop button state, shared by the conversation header and the composer.

import { useEffect, useState } from "react";
import { create } from "zustand";
import { api, errorMessage } from "../api/client";
import type { AgentView } from "../api/types";
import { liveKey } from "../lib/conversations";
import { can, useMachines } from "../store/machines";
import { useUi } from "../store/ui";

/** A message was just sent: the agent turns "working" a moment later, and Stop must be available right away. */
const SENT_WINDOW_MS = 15_000;

const useStopState = create<{ sentAt: Record<string, number>; stopping: Record<string, boolean> }>(() => ({ sentAt: {}, stopping: {} }));

/** Call after a message is sent to the agent. */
export function markSent(machineId: string, agentId: string) {
  const key = liveKey(machineId, agentId);
  useStopState.setState((s) => ({ sentAt: { ...s.sentAt, [key]: Date.now() } }));
}

function clearSent(key: string) {
  useStopState.setState((s) => {
    if (!(key in s.sentAt)) return s;
    const { [key]: _, ...rest } = s.sentAt;
    return { sentAt: rest };
  });
}

/** Whether the agent can be interrupted now, and the action. A blocked agent
 * can't: the daemon refuses (the interrupt would deny its prompt). */
export function useStop(machineId: string, agent: AgentView | undefined) {
  const key = agent ? liveKey(machineId, agent.id) : "";
  const machine = useMachines((s) => s.machines[machineId]);
  const sentAt = useStopState((s) => s.sentAt[key]);
  const stopping = useStopState((s) => !!s.stopping[key]);
  const toast = useUi((s) => s.toast);
  const [, tick] = useState(0);
  const status = agent?.attention.status;

  useEffect(() => {
    if (status === "working" || status === "blocked") clearSent(key);
  }, [status, key]);
  useEffect(() => {
    if (!sentAt) return;
    const timer = setTimeout(() => tick((n) => n + 1), Math.max(0, sentAt + SENT_WINDOW_MS - Date.now()));
    return () => clearTimeout(timer);
  }, [sentAt]);

  const justSent = !!sentAt && Date.now() - sentAt < SENT_WINDOW_MS;
  const online = machine?.status.state === "online";
  const allowed = can(machine, "agents.interrupt");
  const canStop = !!agent && online && allowed && status !== "blocked" && (status === "working" || justSent);

  const stop = async () => {
    if (!agent || !canStop || stopping) return;
    useStopState.setState((s) => ({ stopping: { ...s.stopping, [key]: true } }));
    try {
      await api.interrupt(machineId, agent.id);
      clearSent(key);
    } catch (e) {
      toast(errorMessage(e), "error");
    } finally {
      useStopState.setState((s) => ({ stopping: { ...s.stopping, [key]: false } }));
    }
  };

  return { canStop, stopping, stop, allowed };
}
