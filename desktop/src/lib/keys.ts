// Modifier key labels: macOS symbols, words elsewhere.

import { isMac } from "./platform";

export const MOD = isMac ? "⌘" : "Ctrl";
export const ALT = isMac ? "⌥" : "Alt";
export const SHIFT = isMac ? "⇧" : "Shift";
