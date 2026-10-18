// Line diffs for file changes carried by tool calls.

import { diffLines } from "diff";
import type { FileChange } from "../api/types";

export interface DiffLine {
  type: "add" | "del" | "ctx" | "hunk";
  text: string;
}

export interface Diff {
  lines: DiffLine[];
  additions: number;
  deletions: number;
}

function splitLines(text: string): string[] {
  const lines = text.split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** Codex `apply_patch` bodies and unified diffs are shown as they are. */
export function parsePatch(text: string): Diff {
  const lines: DiffLine[] = [];
  let additions = 0;
  let deletions = 0;
  for (const raw of splitLines(text)) {
    if (raw.startsWith("*** Begin Patch") || raw.startsWith("*** End Patch")) continue;
    if (raw.startsWith("diff --git") || raw.startsWith("index ") || raw.startsWith("--- ") || raw.startsWith("+++ ")) continue;
    if (raw.startsWith("*** ") || raw.startsWith("@@")) {
      lines.push({ type: "hunk", text: raw.replace(/^\*\*\* /, "") });
    } else if (raw.startsWith("+")) {
      additions++;
      lines.push({ type: "add", text: raw.slice(1) });
    } else if (raw.startsWith("-")) {
      deletions++;
      lines.push({ type: "del", text: raw.slice(1) });
    } else {
      lines.push({ type: "ctx", text: raw.startsWith(" ") ? raw.slice(1) : raw });
    }
  }
  return { lines, additions, deletions };
}

export function isPatch(text: string): boolean {
  return text.startsWith("*** Begin Patch") || text.startsWith("diff --git") || /^@@ .* @@/m.test(text.slice(0, 400));
}

// Diffs are computed once per change (timeline items are kept as they are).
const cache = new WeakMap<FileChange, Diff>();

export function changeDiff(change: FileChange): Diff {
  let diff = cache.get(change);
  if (!diff) {
    diff = computeDiff(change);
    cache.set(change, diff);
  }
  return diff;
}

function computeDiff(change: FileChange): Diff {
  if (change.old === null && isPatch(change.new)) return parsePatch(change.new);
  if (change.old === null) {
    const lines = splitLines(change.new).map((text) => ({ type: "add" as const, text }));
    return { lines, additions: lines.length, deletions: 0 };
  }
  const lines: DiffLine[] = [];
  let additions = 0;
  let deletions = 0;
  for (const part of diffLines(change.old, change.new)) {
    const type = part.added ? "add" : part.removed ? "del" : "ctx";
    for (const text of splitLines(part.value)) {
      if (type === "add") additions++;
      if (type === "del") deletions++;
      lines.push({ type, text });
    }
  }
  return { lines, additions, deletions };
}
