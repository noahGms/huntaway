import { LiveTerminal } from "../terminal/LiveTerminal";

/** Mount with `key` = conversation: typing mode never follows another agent. */
export function TerminalTab({ machineId, agentId }: { machineId: string; agentId: string }) {
  return <LiveTerminal machineId={machineId} target={{ agentId }} title="Live screen of the Herdr pane" />;
}
