import { describe, expect, it } from "vitest";
import type { LibrarySkill, SkillView } from "../api/types";
import { needsPush, skillCell, skillRows, validSkillName, type SkillMachine } from "./skills";

const local = (name: string, hash = "h1", description: string | null = null): LibrarySkill => ({ name, description, hash, files: 1, path: `/lib/${name}` });

const remote = (name: string, hash = "h1", conflict = false): SkillView => ({
  name,
  description: `${name} (remote)`,
  hash,
  files: 1,
  updated_at: 0,
  links: [
    { agent: "claude", path: `/home/u/.claude/skills/${name}`, state: conflict ? "conflict" : "linked" },
    { agent: "codex", path: `/home/u/.agents/skills/${name}`, state: "linked" },
  ],
});

const machine = (skills?: SkillView[], over: Partial<SkillMachine> = {}): SkillMachine => ({ online: true, canRead: true, remote: { skills }, ...over });

describe("skill cells", () => {
  it("compares the library hash with the machine", () => {
    expect(skillCell("a", local("a"), machine([remote("a")]))).toEqual({ state: "synced" });
    expect(skillCell("a", local("a", "h2"), machine([remote("a")]))).toEqual({ state: "outdated" });
    expect(skillCell("a", local("a"), machine([]))).toEqual({ state: "missing" });
  });

  it("reports link conflicts with their paths", () => {
    expect(skillCell("a", local("a"), machine([remote("a", "h1", true)]))).toEqual({ state: "conflict", paths: ["/home/u/.claude/skills/a"] });
    expect(skillCell("a", null, machine([remote("a", "h1", true)]))).toEqual({ state: "remote-only", conflict: ["/home/u/.claude/skills/a"] });
  });

  it("handles skills only on machines, or nowhere", () => {
    expect(skillCell("a", null, machine([remote("a")]))).toEqual({ state: "remote-only", conflict: [] });
    expect(skillCell("b", null, machine([remote("a")]))).toEqual({ state: "none" });
  });

  it("puts offline and permissions before the lists", () => {
    expect(skillCell("a", local("a"), machine([remote("a")], { online: false }))).toEqual({ state: "offline" });
    expect(skillCell("a", local("a"), machine(undefined, { canRead: false }))).toEqual({ state: "no-permission" });
    expect(skillCell("a", local("a"), machine(undefined))).toEqual({ state: "loading" });
    expect(skillCell("a", local("a"), { online: true, canRead: true, remote: undefined })).toEqual({ state: "loading" });
    expect(skillCell("a", local("a"), { online: true, canRead: true, remote: { error: "boom" } })).toEqual({ state: "error", message: "boom" });
  });

  it("flags cells that need a push", () => {
    expect(needsPush({ state: "outdated" })).toBe(true);
    expect(needsPush({ state: "missing" })).toBe(true);
    expect(needsPush({ state: "synced" })).toBe(false);
    expect(needsPush({ state: "remote-only", conflict: [] })).toBe(false);
  });
});

describe("skill rows", () => {
  it("merges the library and the machines, sorted by name", () => {
    const rows = skillRows([local("b", "h", "From library"), local("a")], [[remote("c"), remote("a")], undefined, [remote("b")]]);
    expect(rows.map((r) => r.name)).toEqual(["a", "b", "c"]);
    expect(rows[0].description).toBe("a (remote)");
    expect(rows[1].description).toBe("From library");
    expect(rows[2].local).toBeNull();
  });
});

describe("skill names", () => {
  it("follows the daemon rule", () => {
    expect(validSkillName("deploy-app")).toBe(true);
    expect(validSkillName("v1.2_x")).toBe(true);
    expect(validSkillName("Deploy")).toBe(false);
    expect(validSkillName("-x")).toBe(false);
    expect(validSkillName("a b")).toBe(false);
    expect(validSkillName("")).toBe(false);
    expect(validSkillName("a".repeat(65))).toBe(false);
  });
});
