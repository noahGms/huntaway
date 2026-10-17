import { describe, expect, it } from "vitest";
import type { StoredItem } from "../api/types";
import { computeActivity } from "./activity";
import { changeDiff, parsePatch } from "./diff";
import { groupConversations, type Conversation } from "./conversations";
import { humanizeSlug, shortTime } from "./format";

const items: StoredItem[] = [
  { n: 0, type: "user_message", uuid: "u", timestamp: "2026-10-17T10:00:00Z", text: "Fais la page" },
  { n: 1, type: "tool_call", uuid: "a", timestamp: "2026-10-17T10:01:00Z", tool_use_id: "t1", name: "Bash", kind: "command", summary: "npm test", sidechain: false },
  { n: 2, type: "tool_result", timestamp: "2026-10-17T10:01:10Z", tool_use_id: "t1", is_error: true, rejected: false, summary: "FAIL" },
  { n: 3, type: "tool_call", uuid: "b", timestamp: "2026-10-17T10:02:00Z", tool_use_id: "t2", name: "Edit", kind: "file_modified", summary: "a.ts", sidechain: false, change: { path: "/x/a.ts", old: "a\nb", new: "a\nc\nd", truncated: false } },
  { n: 4, type: "todos_updated", timestamp: "2026-10-17T10:03:00Z", todos: [{ content: "Hero", status: "completed" }] },
  { n: 5, type: "assistant_message", uuid: "c", timestamp: "2026-10-17T10:16:00Z", text: "Fini", sidechain: false },
];

describe("activity", () => {
  it("aggregates commands, files, todos and duration", () => {
    const a = computeActivity(items);
    expect(a.messages).toBe(2);
    expect(a.commands[0]).toMatchObject({ command: "npm test", ok: false, output: "FAIL" });
    expect(a.files[0]).toMatchObject({ path: "/x/a.ts", additions: 2, deletions: 1, edits: 1 });
    expect(a.todos).toHaveLength(1);
    expect(a.durationMs).toBe(16 * 60 * 1000);
    expect(a.toolCounts.command).toBe(1);
  });
});

describe("diff", () => {
  it("diffs edits and whole writes", () => {
    expect(changeDiff({ path: "a", old: null, new: "x\ny\n", truncated: false })).toMatchObject({ additions: 2, deletions: 0 });
    const d = changeDiff({ path: "a", old: "1\n2\n3", new: "1\n4\n3", truncated: false });
    expect([d.additions, d.deletions]).toEqual([1, 1]);
  });
  it("reads codex patches", () => {
    const d = parsePatch("*** Begin Patch\n*** Update File: src/app.ts\n@@\n-a\n+b\n+c\n*** End Patch");
    expect([d.additions, d.deletions]).toEqual([2, 1]);
    expect(d.lines[0]).toEqual({ type: "hunk", text: "Update File: src/app.ts" });
  });
});

describe("conversations", () => {
  const conv = (key: string, last: string, status: "blocked" | "done" | null, project = "api"): Conversation => ({
    key, machineId: "m", machineName: "Mac", local: true, live: status !== null, kind: "claude", title: key, project, cwd: null,
    attention: status === null ? null : status === "blocked" ? { status: "blocked", reason: "approval" } : { status: "done" },
    lastActivity: last,
  });
  it("puts waiting agents first and groups by date", () => {
    const now = Date.parse("2026-10-17T12:00:00");
    const groups = groupConversations(
      [conv("a", "2026-10-17T11:00:00", "done"), conv("b", "2026-10-16T11:00:00", null), conv("c", "2026-10-01T11:00:00", "blocked")],
      "date",
      now,
    );
    expect(groups.map((g) => g.label)).toEqual(["En attente", "Aujourd'hui", "Hier"]);
  });
  it("groups by project", () => {
    const groups = groupConversations([conv("a", "2026-10-17T11:00:00", "done", "api"), conv("b", "2026-10-16T11:00:00", null, "web")], "project");
    expect(groups.map((g) => g.label)).toEqual(["api", "web"]);
  });
});

describe("format", () => {
  it("humanizes ai titles only", () => {
    expect(humanizeSlug("fix-login-page")).toBe("Fix login page");
    expect(humanizeSlug("Refactor auth")).toBe("Refactor auth");
  });
  it("short times", () => {
    const now = Date.parse("2026-10-17T12:00:00");
    expect(shortTime("2026-10-16T09:00:00", now)).toBe("Hier");
  });
});

import { toInput } from "./terminal";
describe("terminal input", () => {
  it("maps special keys", () => {
    expect(toInput("\r")).toEqual({ keys: ["enter"] });
    expect(toInput("\x03")).toEqual({ keys: ["ctrl+c"] });
    expect(toInput("\x1b[A")).toEqual({ keys: ["up"] });
    expect(toInput("ls")).toEqual({ text: "ls" });
  });
});
