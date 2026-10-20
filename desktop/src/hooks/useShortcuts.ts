// Global keyboard shortcuts (listed in Settings → Shortcuts).

import { useEffect } from "react";
import { archiveId, isUnread, needsYou, type Conversation } from "../lib/conversations";
import { useSeen } from "../store/seen";
import { useUi } from "../store/ui";

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  return el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable || !!el.closest?.(".xterm");
}

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
        // Next agent waiting for the user; none: the next unread one.
        e.preventDefault();
        const seen = useSeen.getState().seen;
        const blocked = conversations.filter((c) => needsYou(c.attention));
        const waiting = blocked.length ? blocked : conversations.filter((c) => c.key !== ui.selected && isUnread(c, seen[archiveId(c)]));
        if (!waiting.length) return;
        const i = waiting.findIndex((c) => c.key === ui.selected);
        ui.select(waiting[(i + 1) % waiting.length].key);
      } else if (e.altKey && !mod && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
        // Walks the rows visible in the sidebar (space, filters, collapsed nodes).
        if (isTyping(e.target) || e.defaultPrevented) return;
        const keys = ui.showSidebar && ui.visibleKeys.length ? ui.visibleKeys : conversations.map((c) => c.key);
        if (!keys.length) return;
        e.preventDefault();
        const i = keys.indexOf(ui.selected ?? "");
        const next = e.key === "ArrowDown" ? Math.min(keys.length - 1, i + 1) : Math.max(0, i - 1);
        ui.select(keys[i === -1 ? 0 : next]);
      } else if (mod && e.key === ",") {
        e.preventDefault();
        ui.setView("settings");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [conversations]);
}
