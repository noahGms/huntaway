import { useMemo } from "react";
import { archiveId, isUnread, type Conversation } from "../lib/conversations";
import { useSeen } from "../store/seen";
import { useUi } from "../store/ui";

/** Keys of the unread conversations, in list order; the one on screen is read. */
export function useUnread(conversations: Conversation[]): string[] {
  const seen = useSeen((s) => s.seen);
  const selected = useUi((s) => (s.view === "conversations" ? s.selected : null));
  return useMemo(
    () => conversations.filter((c) => c.key !== selected && isUnread(c, seen[archiveId(c)])).map((c) => c.key),
    [conversations, seen, selected],
  );
}
