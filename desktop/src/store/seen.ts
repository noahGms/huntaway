// When each conversation was last looked at on this computer (localStorage):
// a turn that ended after that is unread.

import { create } from "zustand";
import { persist } from "zustand/middleware";

/** Conversations remembered; the oldest views are forgotten past this. */
const MAX_SEEN = 500;

interface SeenState {
  /** `archiveId()` → `lastActivity` of the conversation when it was on screen. */
  seen: Record<string, string>;
  markSeen: (id: string, lastActivity: string) => void;
}

export const useSeen = create<SeenState>()(
  persist(
    (set) => ({
      seen: {},
      markSeen: (id, lastActivity) =>
        set((s) => {
          if (s.seen[id] === lastActivity) return s;
          // Re-inserted last: the first keys are the oldest views.
          const { [id]: _, ...rest } = s.seen;
          const keys = Object.keys(rest);
          for (const k of keys.slice(0, Math.max(0, keys.length + 1 - MAX_SEEN))) delete rest[k];
          return { seen: { ...rest, [id]: lastActivity } };
        }),
    }),
    { name: "huntaway:seen", version: 1 },
  ),
);
