// Keystrokes typed in the terminal tab, for `agent.send_keys` / `pane.send_text`.

/** xterm data → Herdr key names (`agent.send_keys`). */
const KEYS: Record<string, string> = {
  "\r": "enter",
  "\x7f": "backspace",
  "\x1b": "esc",
  "\t": "tab",
  "\x1b[A": "up",
  "\x1b[B": "down",
  "\x1b[C": "right",
  "\x1b[D": "left",
  "\x1b[H": "home",
  "\x1b[F": "end",
  "\x1b[3~": "delete",
  "\x1b[5~": "pageup",
  "\x1b[6~": "pagedown",
  "\x1b[Z": "shift+tab",
};

export function toInput(data: string): { text?: string; keys?: string[] } {
  if (KEYS[data]) return { keys: [KEYS[data]] };
  if (data.length === 1 && data.charCodeAt(0) < 32) return { keys: [`ctrl+${String.fromCharCode(data.charCodeAt(0) + 96)}`] };
  return { text: data };
}
