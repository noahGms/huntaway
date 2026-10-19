import { describe, expect, it } from "vitest";
import { buildSidebarRows, compactAge, groupConversations, inactiveProjects, liveKey, nestConversations, projectsOf, searchConversations, treeCollapsedId, treeExpandedId, type Conversation, type SidebarOptions } from "./conversations";
import { moveMachine, orderMachines, spaceMachineIds } from "./spaces";

const conv = (key: string, last: string, status: "blocked" | "done" | null, project = "api", machineId = "m", machineName = "Mac"): Conversation => ({
  key, machineId, machineName, local: true, live: status !== null, kind: "claude", title: key, project, cwd: null,
  attention: status === null ? null : status === "blocked" ? { status: "blocked", reason: "approval" } : { status: "done" },
  lastActivity: last,
});

const now = Date.parse("2026-10-17T12:00:00");
const opts = (o: Partial<SidebarOptions> = {}): SidebarOptions => ({
  grouping: "project",
  machines: [{ id: "m", name: "Mac" }],
  collapsed: new Set(),
  favorites: new Set(),
  inactiveDays: 0,
  showInactive: false,
  now,
  ...o,
});

describe("groupConversations", () => {
  it("puts waiting agents first and groups by date", () => {
    const groups = groupConversations(
      [conv("a", "2026-10-17T11:00:00", "done"), conv("b", "2026-10-16T11:00:00", null), conv("c", "2026-10-01T11:00:00", "blocked")],
      "date",
      now,
    );
    expect(groups.map((g) => g.label)).toEqual(["Waiting", "Today", "Yesterday"]);
  });
  it("groups by project and keeps machines apart", () => {
    const groups = groupConversations(
      [conv("a", "2026-10-17T11:00:00", "done", "api"), conv("b", "2026-10-16T11:00:00", null, "web"), conv("c", "2026-10-15T11:00:00", null, "api", "vps", "vps")],
      "project",
    );
    expect(groups.map((g) => g.label)).toEqual(["api · Mac", "web", "api · vps"]);
  });
});

describe("buildSidebarRows", () => {
  const list = [
    conv("a", "2026-10-17T11:00:00", "done", "api"),
    conv("b", "2026-10-17T10:00:00", "blocked", "web", "vps", "vps"),
    conv("c", "2026-10-16T11:00:00", null, "api", "vps", "vps"),
  ];
  const machines = [{ id: "m", name: "Mac" }, { id: "vps", name: "vps" }];

  it("builds a machine → project tree with counts and pinned waiting agents", () => {
    const rows = buildSidebarRows(list, opts({ machines }));
    expect(rows.map((r) => r.id)).toEqual(["h-waiting", "w-b", "m:m", "p:m|api", "a", "m:vps", "p:vps|web", "b", "p:vps|api", "c"]);
    const vps = rows.find((r) => r.id === "m:vps");
    expect(vps).toMatchObject({ count: 2, waiting: 1 });
    expect(rows[1]).toMatchObject({ suffix: "web · vps" });
  });
  it("skips the machine level with a single machine", () => {
    const rows = buildSidebarRows(list.filter((c) => c.machineId === "m"), opts());
    expect(rows.map((r) => r.type)).toEqual(["project", "conv"]);
    expect(rows[1]).toMatchObject({ depth: 1 });
  });
  it("hides collapsed nodes and sorts favorites first", () => {
    const rows = buildSidebarRows(list, opts({ machines, collapsed: new Set(["m:m", "p:vps|web"]), favorites: new Set(["vps|api"]) }));
    expect(rows.map((r) => r.id)).toEqual(["h-waiting", "w-b", "m:m", "m:vps", "p:vps|api", "c", "p:vps|web"]);
  });
  it("groups by date with a project suffix", () => {
    const rows = buildSidebarRows(list, opts({ machines, grouping: "date" }));
    expect(rows.map((r) => r.id)).toEqual(["h-waiting", "w-b", "h-today", "a", "h-yesterday", "c"]);
    expect(rows[3]).toMatchObject({ suffix: "api · Mac" });
  });
  it("hides idle projects unless asked", () => {
    const old = [conv("x", "2026-09-01T11:00:00", null, "legacy"), conv("y", "2026-10-17T11:00:00", null, "api")];
    const rows = buildSidebarRows(old, opts({ inactiveDays: 14 }));
    expect(rows.map((r) => r.id)).toEqual(["p:m|api", "y", "inactive"]);
    expect(buildSidebarRows(old, opts({ inactiveDays: 14, showInactive: true })).map((r) => r.id)).toContain("x");
    expect(inactiveProjects(old, new Set(["m|legacy"]), 14, now).size).toBe(0);
  });
});

describe("search", () => {
  const list = [conv("fix login", "2026-10-17T11:00:00", "done", "api", "dev", "dev-server"), conv("hero", "2026-10-17T10:00:00", null, "web")];
  it("matches every word, project @ machine", () => {
    expect(searchConversations(list, "api @ dev").map((c) => c.key)).toEqual(["fix login"]);
    expect(searchConversations(list, "LOGIN").length).toBe(1);
    expect(searchConversations(list, "").length).toBe(2);
    expect(searchConversations(list, "nope").length).toBe(0);
  });
  it("lists projects per machine", () => {
    expect(projectsOf(list).map((p) => p.key)).toEqual(["dev|api", "m|web"]);
  });
});

describe("compactAge", () => {
  it("formats ages", () => {
    expect(compactAge("2026-10-17T11:59:30", now)).toBe("now");
    expect(compactAge("2026-10-17T11:55:00", now)).toBe("5m");
    expect(compactAge("2026-10-17T09:00:00", now)).toBe("3h");
    expect(compactAge("2026-10-15T09:00:00", now)).toBe("2d");
    expect(compactAge("2026-10-01T09:00:00", now)).toBe("2w");
    expect(compactAge("2026-08-12T09:00:00", now)).toBe("Aug 12");
  });
});

describe("spaces", () => {
  it("resolves spaces", () => {
    const groups = [{ id: "g", name: "Work", machineIds: ["b", "gone"] }];
    expect(spaceMachineIds({ kind: "all" }, ["a", "b"], groups)).toEqual(["a", "b"]);
    expect(spaceMachineIds({ kind: "group", id: "g" }, ["a", "b"], groups)).toEqual(["b"]);
    expect(spaceMachineIds({ kind: "machine", id: "gone" }, ["a", "b"], groups)).toBeNull();
    expect(spaceMachineIds({ kind: "group", id: "nope" }, ["a"], groups)).toBeNull();
  });
  it("orders machines", () => {
    const m = (id: string, local = false) => ({ record: { machine_id: id, name: id, local } as never });
    const sorted = orderMachines([m("c"), m("b"), m("a", true)], ["c"]);
    expect(sorted.map((x) => (x.record as { machine_id: string }).machine_id)).toEqual(["c", "a", "b"]);
    expect(moveMachine(["a", "b", "c"], "b", -1)).toEqual(["b", "a", "c"]);
    expect(moveMachine(["a", "b"], "a", -1)).toEqual(["a", "b"]);
  });
});

describe("nested agents", () => {
  const live = (key: string, agentId: string, parent: string | null, status: "blocked" | "done"): Conversation => ({
    ...conv(liveKey("m", agentId), "2026-10-17T11:00:00", status),
    title: key,
    agentId,
    agent: { id: agentId, parent_id: parent } as Conversation["agent"],
  });

  it("puts children under their parent, folded unless one is waiting", () => {
    const list = [live("parent", "s:p1", null, "done"), live("child", "s:p2", "s:p1", "done"), live("grandchild", "s:p3", "s:p2", "done")];
    const rows = buildSidebarRows(list, opts({ grouping: "date" }));
    const convs = rows.filter((r) => r.type === "conv");
    expect(convs.map((r) => r.type === "conv" && r.conv.title)).toEqual(["parent"]);
    const parent = convs[0];
    expect(parent.type === "conv" && parent.tree?.total).toBe(2);
    expect(parent.type === "conv" && parent.tree?.expanded).toBe(false);
  });

  it("opens and pins the parent when a child waits", () => {
    const list = [live("parent", "s:p1", null, "done"), live("child", "s:p2", "s:p1", "blocked")];
    const rows = buildSidebarRows(list, opts({ grouping: "date" }));
    expect(rows.map((r) => (r.type === "conv" ? `${r.depth}:${r.conv.title}` : r.type))).toEqual(["header", "0:parent", "1:child"]);
    const parent = rows[1];
    expect(parent.type === "conv" && parent.tree?.rollup?.status).toBe("blocked");
  });

  it("follows the collapsed state chosen by the user", () => {
    const list = [live("parent", "s:p1", null, "done"), live("child", "s:p2", "s:p1", "blocked")];
    const collapsed = new Set([treeCollapsedId(liveKey("m", "s:p1"))]);
    const rows = buildSidebarRows(list, opts({ grouping: "date", collapsed }));
    expect(rows.filter((r) => r.type === "conv").length).toBe(1);
    const expanded = new Set([treeExpandedId(liveKey("m", "s:p1"))]);
    const quiet = [live("parent", "s:p1", null, "done"), live("child", "s:p2", "s:p1", "done")];
    expect(buildSidebarRows(quiet, opts({ grouping: "date", collapsed: expanded })).filter((r) => r.type === "conv").length).toBe(2);
  });

  it("keeps agents of a cycle visible", () => {
    const { roots } = nestConversations([live("a", "s:p1", "s:p2", "done"), live("b", "s:p2", "s:p1", "done")]);
    expect(roots.length).toBe(2);
  });
});
