import { useMemo } from "react";
import { buildConversations, type Conversation } from "../lib/conversations";
import { machineList, useMachines } from "../store/machines";

/** Every conversation of every machine, most urgent first. */
export function useConversations(): Conversation[] {
  const machines = useMachines((s) => s.machines);
  const history = useMachines((s) => s.history);
  return useMemo(() => buildConversations(machineList(machines), history), [machines, history]);
}
