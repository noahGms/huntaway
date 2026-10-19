// Skills page: one row per skill (library ∪ machines) and the state of each
// skill on each machine, from the library hash and the daemons' lists.

import type { LibrarySkill, SkillView } from "../api/types";

/** Skills of one machine as last fetched. */
export interface RemoteSkills {
  skills?: SkillView[];
  error?: string;
  loading?: boolean;
}

/** What the page knows about a machine for the skill cells. */
export interface SkillMachine {
  online: boolean;
  /** `skills.read`. */
  canRead: boolean;
  remote: RemoteSkills | undefined;
}

export type SkillCell =
  | { state: "synced" }
  | { state: "outdated" }
  | { state: "missing" }
  | { state: "conflict"; paths: string[] }
  | { state: "remote-only"; conflict: string[] }
  | { state: "no-permission" }
  | { state: "offline" }
  | { state: "loading" }
  | { state: "error"; message: string }
  | { state: "none" };

export interface SkillRow {
  name: string;
  description: string | null;
  /** In the library. */
  local: LibrarySkill | null;
}

/** Same rule as the daemon: `[a-z0-9][a-z0-9._-]{0,63}`. */
export function validSkillName(name: string): boolean {
  return /^[a-z0-9][a-z0-9._-]{0,63}$/.test(name);
}

/** Library skills and the skills found on machines, sorted by name. */
export function skillRows(library: LibrarySkill[], remotes: (SkillView[] | undefined)[]): SkillRow[] {
  const rows = new Map<string, SkillRow>();
  for (const s of library) rows.set(s.name, { name: s.name, description: s.description, local: s });
  for (const list of remotes) {
    for (const s of list ?? []) {
      const row = rows.get(s.name);
      if (!row) rows.set(s.name, { name: s.name, description: s.description, local: null });
      else if (!row.description && s.description) row.description = s.description;
    }
  }
  return [...rows.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Paths where another skill of the same name blocks the link. */
function conflicts(remote: SkillView): string[] {
  return remote.links.filter((l) => l.state === "conflict").map((l) => l.path);
}

/** State of the skill `name` on one machine. */
export function skillCell(name: string, local: LibrarySkill | null, machine: SkillMachine): SkillCell {
  if (!machine.online) return { state: "offline" };
  if (!machine.canRead) return { state: "no-permission" };
  const skills = machine.remote?.skills;
  if (!skills) {
    if (machine.remote?.error) return { state: "error", message: machine.remote.error };
    return { state: "loading" };
  }
  const remote = skills.find((s) => s.name === name);
  if (!local) return remote ? { state: "remote-only", conflict: conflicts(remote) } : { state: "none" };
  if (!remote) return { state: "missing" };
  if (remote.hash !== local.hash) return { state: "outdated" };
  const paths = conflicts(remote);
  if (paths.length) return { state: "conflict", paths };
  return { state: "synced" };
}

/** The cell needs a push from the library. */
export function needsPush(cell: SkillCell): boolean {
  return cell.state === "outdated" || cell.state === "missing";
}
