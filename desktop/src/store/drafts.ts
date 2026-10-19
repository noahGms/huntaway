// Message drafts per conversation: the text and the attachments survive
// switching conversations (uploads finish in the background) and restarts.

import { create } from "zustand";
import { persist } from "zustand/middleware";

export interface Attachment {
  id: string;
  name: string;
  /** Path on the machine, once uploaded. */
  path: string | null;
  image: boolean;
}

interface Draft {
  text: string;
  attachments: Attachment[];
  at: number;
}

interface DraftsState {
  drafts: Record<string, Draft>;
  setText: (key: string, text: string) => void;
  addAttachment: (key: string, a: Attachment) => void;
  /** `path` null: the upload failed, the attachment is removed. */
  resolveAttachment: (key: string, id: string, path: string | null) => void;
  removeAttachment: (key: string, id: string) => void;
  /** After sending. */
  clear: (key: string) => void;
}

/** Old drafts are dropped. */
const MAX_AGE_MS = 14 * 86_400_000;
const EMPTY: Draft = { text: "", attachments: [], at: 0 };

function put(drafts: Record<string, Draft>, key: string, change: (d: Draft) => Partial<Draft>): Record<string, Draft> {
  const d = { ...(drafts[key] ?? EMPTY), at: Date.now() };
  const next = { ...d, ...change(d) };
  const { [key]: _, ...rest } = drafts;
  return next.text || next.attachments.length ? { ...rest, [key]: next } : rest;
}

export const useDrafts = create<DraftsState>()(
  persist(
    (set) => ({
      drafts: {},
      setText: (key, text) => set((s) => ((s.drafts[key]?.text ?? "") === text ? s : { drafts: put(s.drafts, key, () => ({ text })) })),
      addAttachment: (key, a) => set((s) => ({ drafts: put(s.drafts, key, (d) => ({ attachments: [...d.attachments, a] })) })),
      resolveAttachment: (key, id, path) =>
        set((s) => ({
          drafts: put(s.drafts, key, (d) => ({
            attachments: path === null ? d.attachments.filter((a) => a.id !== id) : d.attachments.map((a) => (a.id === id ? { ...a, path } : a)),
          })),
        })),
      removeAttachment: (key, id) => set((s) => ({ drafts: put(s.drafts, key, (d) => ({ attachments: d.attachments.filter((a) => a.id !== id) })) })),
      clear: (key) => set((s) => ({ drafts: put(s.drafts, key, () => ({ text: "", attachments: [] })) })),
    }),
    {
      name: "huntaway:drafts",
      version: 1,
      // Uploads still running when the app closed are lost.
      partialize: (s) => {
        const now = Date.now();
        const drafts: Record<string, Draft> = {};
        for (const [key, d] of Object.entries(s.drafts)) {
          if (now - d.at > MAX_AGE_MS) continue;
          const attachments = d.attachments.filter((a) => a.path);
          if (d.text || attachments.length) drafts[key] = { ...d, attachments };
        }
        return { drafts };
      },
    },
  ),
);

// Drafts of earlier versions: `draft:<key>` → { text, at }.
try {
  for (const name of Object.keys(localStorage)) {
    if (!name.startsWith("draft:")) continue;
    const { text, at } = JSON.parse(localStorage.getItem(name) ?? "{}") as { text?: string; at?: number };
    const key = name.slice("draft:".length);
    if (text && at && Date.now() - at < MAX_AGE_MS && !useDrafts.getState().drafts[key]) useDrafts.getState().setText(key, text);
    localStorage.removeItem(name);
  }
} catch {
  // No storage: nothing to migrate.
}

export const draftOf = (drafts: Record<string, Draft>, key: string): Draft => drafts[key] ?? EMPTY;
