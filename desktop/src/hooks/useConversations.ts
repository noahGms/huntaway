import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { buildConversations, type Conversation } from "../lib/conversations";
import { machineList, useMachines } from "../store/machines";

/** Every conversation of every machine, most urgent first. Rebuilt only
 * when a machine record or state changes, not on latency pings. */
export function useConversations(): Conversation[] {
  const inputs = useMachines(useShallow((s) => Object.values(s.machines).flatMap((m) => [m.record, m.snapshot])));
  const history = useMachines((s) => s.history);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => buildConversations(machineList(useMachines.getState().machines), history), [inputs, history]);
}
