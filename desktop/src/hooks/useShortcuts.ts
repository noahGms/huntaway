// Global keyboard shortcuts (PRD §6.11, Settings → Raccourcis).

import { useEffect } from "react";
import type { Conversation } from "../lib/conversations";
import { useUi } from "../store/ui";

export function useShortcuts(conversations: Conversation[]) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const ui = useUi.getState();
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "k") {
        e.preventDefault();
        ui.setPalette(!ui.paletteOpen);
      } else if (mod && e.key.toLowerCase() === "n" && !e.shiftKey) {
        e.preventDefault();
        ui.openNewSession();
      } else if (mod && e.altKey && (e.key.toLowerCase() === "b" || e.code === "KeyB")) {
        e.preventDefault();
        ui.togglePanel();
      } else if (mod && e.key.toLowerCase() === "b") {
        e.preventDefault();
        ui.toggleSidebar();
      } else if (mod && ["1", "2", "3"].includes(e.key)) {
        e.preventDefault();
        ui.setPanelTab((["activity", "files", "terminal"] as const)[Number(e.key) - 1]);
      } else if (mod && e.shiftKey && e.key.toLowerCase() === "a") {
        // Next agent waiting for the user.
        e.preventDefault();
        const waiting = conversations.filter((c) => c.attention?.status === "blocked");
        if (!waiting.length) return;
        const i = waiting.findIndex((c) => c.key === ui.selected);
        ui.select(waiting[(i + 1) % waiting.length].key);
      } else if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
        e.preventDefault();
        if (!conversations.length) return;
        const i = conversations.findIndex((c) => c.key === ui.selected);
        const next = e.key === "ArrowDown" ? Math.min(conversations.length - 1, i + 1) : Math.max(0, i - 1);
        ui.select(conversations[i === -1 ? 0 : next].key);
      } else if (mod && e.key === ",") {
        e.preventDefault();
        ui.setView("settings");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [conversations]);
}
