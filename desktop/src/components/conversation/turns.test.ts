import { describe, expect, it } from "vitest";
import type { StoredItem } from "../../api/types";
import { buildTurns, statsLabel } from "./turns";

let n = 0;
const ts = (s: number) => new Date(Date.UTC(2026, 9, 19, 10, 0, s)).toISOString();
const user = (text: string, s = 0): StoredItem => ({ n: n++, type: "user_message", uuid: `u${n}`, timestamp: ts(s), text });
const say = (text: string, s = 0): StoredItem => ({ n: n++, type: "assistant_message", uuid: `a${n}`, timestamp: ts(s), text, sidechain: false });
const call = (id: string, kind: string, summary: string, extra: Partial<Record<string, unknown>> = {}): StoredItem =>
  ({ n: n++, type: "tool_call", uuid: `c${n}`, timestamp: ts(1), tool_use_id: id, name: kind, kind, summary, sidechain: false, ...extra }) as StoredItem;
const result = (id: string): StoredItem => ({ n: n++, type: "tool_result", timestamp: ts(2), tool_use_id: id, is_error: false, rejected: false, summary: "ok" });
const ended = (ms: number): StoredItem => ({ n: n++, type: "turn_ended", timestamp: ts(9), duration_ms: ms });

describe("buildTurns", () => {
  it("folds the work and keeps the final answer and file summary visible", () => {
    const rows = buildTurns(
      [
        user("add /health"),
        say("Looking at the routes."),
        call("r1", "file_read", "src/mod.rs"),
        result("r1"),
        call("e1", "file_modified", "health.rs", { change: { path: "/a/health.rs", old: null, new: "a\nb\n", truncated: false } }),
        result("e1"),
        call("b1", "command", "cargo test"),
        result("b1"),
        say("Done, tested."),
        ended(100_000),
      ],
      false,
    );
    expect(rows.map((r) => r.kind)).toEqual(["user", "work", "assistant", "files"]);
    const work = rows[1];
    expect(work.kind === "work" && work.durationMs).toBe(100_000);
    expect(work.kind === "work" && statsLabel(work.stats)).toBe("1 file read · 1 command · 1 file changed");
    expect(work.kind === "work" && work.rows.some((r) => r.kind === "assistant")).toBe(true);
    const files = rows[3];
    expect(files.kind === "files" && files.files[0]).toMatchObject({ path: "/a/health.rs", additions: 2, created: true });
  });

  it("shows agent launches and keeps the live turn open with the current action", () => {
    const rows = buildTurns(
      [
        user("review this"),
        call("g1", "agent", "reviewer: check", { agent: { name: "reviewer", pane_id: "w1:p4", kind: "codex", prompt: "check", start: true } }),
        call("b2", "command", "cargo build"),
      ],
      true,
    );
    expect(rows.map((r) => r.kind)).toEqual(["user", "agent", "work"]);
    const work = rows[2];
    expect(work.kind === "work" && work.live).toBe(true);
    expect(work.kind === "work" && work.current).toBe("cargo build");
  });

  it("adds a live work row before the first action", () => {
    const rows = buildTurns([user("hi")], true);
    expect(rows.map((r) => r.kind)).toEqual(["user", "work"]);
  });
});
