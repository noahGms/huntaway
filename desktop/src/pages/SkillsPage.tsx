import { AlertTriangle, ArrowUp, Check, ChevronDown, CloudOff, FolderOpen, Lock, MoreHorizontal, Pencil, Plus, RefreshCw, Trash2, Upload, X } from "lucide-react";
import { useEffect, useState } from "react";
import { errorMessage, skills } from "../api/client";
import type { MachineView, SkillSyncStatus } from "../api/types";
import { Button, IconButton, Spinner } from "../components/ui/Button";
import { Dialog, Field, inputClass } from "../components/ui/Dialog";
import { Menu, MenuItem, MenuSeparator } from "../components/ui/Menu";
import { MachineDot } from "../components/ui/Status";
import { Toggle } from "../components/ui/Toggle";
import { shortTime } from "../lib/format";
import { needsPush, skillCell, skillRows, validSkillName, type SkillCell, type SkillRow } from "../lib/skills";
import { orderMachines } from "../lib/spaces";
import { can, machineList, useMachines } from "../store/machines";
import { usePrefs } from "../store/prefs";
import { useSettings } from "../store/settings";
import { useSkills } from "../store/skills";
import { useUi } from "../store/ui";
import { PageHeader } from "./ServersPage";

const canEdit = (m: MachineView) => m.status.state === "online" && can(m, "skills.edit");

export function SkillsPage() {
  const machineOrder = usePrefs((s) => s.machineOrder);
  const machines = orderMachines(machineList(useMachines((s) => s.machines)), machineOrder);
  const { library, libraryError, remotes, sync, init, loadLibrary, loadRemote } = useSkills();
  const toast = useUi((s) => s.toast);
  const [creating, setCreating] = useState(false);
  const [changing, setChanging] = useState(false);
  const [syncing, setSyncing] = useState(false);

  useEffect(() => {
    let stop: (() => void) | undefined;
    let disposed = false;
    void init().then((u) => (disposed ? u() : (stop = u)));
    return () => {
      disposed = true;
      stop?.();
    };
  }, [init]);

  const rows = skillRows(library?.skills ?? [], machines.map((m) => remotes[m.record.machine_id]?.skills));
  const cellOf = (row: SkillRow, m: MachineView): SkillCell =>
    skillCell(row.name, row.local, { online: m.status.state === "online", canRead: can(m, "skills.read"), remote: remotes[m.record.machine_id] });
  const editable = machines.filter(canEdit);

  const syncAll = async (removeExtra: boolean) => {
    if (!editable.length) return toast("No online machine accepts skills (skills.edit)", "error");
    if (removeExtra && !confirm(`Remove the skills that are not in the library from ${editable.length} machine(s)? Their folders are deleted on those machines.`)) return;
    setSyncing(true);
    const results = await Promise.allSettled(editable.map((m) => skills.sync(m.record.machine_id, removeExtra)));
    setSyncing(false);
    let pushed = 0;
    let removed = 0;
    let failed = 0;
    for (const r of results) {
      if (r.status === "fulfilled") {
        pushed += r.value.pushed.length;
        removed += r.value.removed.length;
        if (r.value.errors.length) failed++;
      } else failed++;
    }
    const summary = `${pushed} pushed${removeExtra ? `, ${removed} removed` : ""}`;
    toast(failed ? `Skills synced with errors on ${failed} machine(s): ${summary}` : `Skills synced: ${summary}`, failed ? "error" : "success");
  };

  return (
    <div className="flex h-full flex-col">
      <PageHeader title="Skills" subtitle={`${rows.length} skill${rows.length === 1 ? "" : "s"}`}>
        <Button size="sm" icon={<Plus size={14} />} onClick={() => setCreating(true)}>
          New skill
        </Button>
        <Menu
          trigger={
            <Button variant="primary" size="sm" loading={syncing} icon={<RefreshCw size={13} />}>
              Sync all
              <ChevronDown size={12} />
            </Button>
          }
        >
          <MenuItem icon={<Upload size={14} />} onSelect={() => void syncAll(false)}>
            Push changed skills
          </MenuItem>
          <MenuSeparator />
          <MenuItem danger icon={<Trash2 size={14} />} onSelect={() => void syncAll(true)}>
            Push and remove extra skills…
          </MenuItem>
        </Menu>
      </PageHeader>
      <div className="min-h-0 flex-1 overflow-y-auto p-6">
        <div className="mx-auto max-w-[1100px] space-y-4">
          <LibraryCard path={library?.path ?? null} exists={library?.exists ?? true} error={libraryError} onChange={() => setChanging(true)} />
          {machines.length > 0 && <MachineSyncList machines={machines} sync={sync} />}
          <div className="overflow-x-auto rounded-xl border border-border bg-surface">
            <div style={{ gridTemplateColumns: cols(machines.length) }} className="grid min-w-fit items-center gap-x-3 border-b border-border px-3 py-2 text-[11px] font-medium uppercase tracking-wider text-faint">
              <span>Name</span>
              <span>Description</span>
              {machines.map((m) => (
                <span key={m.record.machine_id} className="flex min-w-0 items-center gap-1.5 normal-case tracking-normal" title={m.record.name}>
                  <MachineDot state={m.status.state} />
                  <span className="truncate">{m.record.name}</span>
                </span>
              ))}
              <span />
            </div>
            {rows.length === 0 ? (
              <div className="px-4 py-8 text-center text-[12.5px] text-muted">
                {library ? "No skill yet. Create one, or add folders with a SKILL.md to the library." : <Spinner />}
              </div>
            ) : (
              rows.map((row) => (
                <SkillRowView
                  key={row.name}
                  row={row}
                  machines={machines}
                  cells={machines.map((m) => cellOf(row, m))}
                  onChanged={(ids) => {
                    void loadLibrary();
                    ids.forEach((id) => void loadRemote(id));
                  }}
                />
              ))
            )}
          </div>
        </div>
      </div>
      <NewSkillDialog open={creating} onOpenChange={setCreating} onCreated={() => void loadLibrary()} />
      <LibraryPathDialog open={changing} onOpenChange={setChanging} current={library?.path ?? ""} onSaved={() => void loadLibrary()} />
    </div>
  );
}

const cols = (n: number) => `minmax(150px,1fr) minmax(180px,1.6fr) ${n ? `repeat(${n}, minmax(96px,120px))` : ""} 32px`;

function LibraryCard({ path, exists, error, onChange }: { path: string | null; exists: boolean; error: string | null; onChange: () => void }) {
  const toast = useUi((s) => s.toast);
  const { settings, update } = useSettings();
  return (
    <div className="rounded-xl border border-border bg-surface px-4">
      <div className="flex items-center gap-3 py-3">
        <FolderOpen size={15} className="shrink-0 text-muted" />
        <div className="min-w-0 flex-1">
          <div className="text-[12px] text-muted">Library</div>
          <div className="selectable truncate font-mono text-[12px]" title={path ?? undefined}>
            {error ? <span className="text-error">{error}</span> : (path ?? "…")}
            {path && !exists && <span className="font-sans text-faint"> · not created yet</span>}
          </div>
        </div>
        <Button size="sm" icon={<FolderOpen size={13} />} onClick={() => void skills.openFolder().catch((e) => toast(errorMessage(e), "error"))}>
          Open folder
        </Button>
        <Button size="sm" icon={<Pencil size={13} />} onClick={onChange}>
          Change…
        </Button>
      </div>
      <div className="border-t border-border">
        <Toggle
          checked={settings.skills_auto_sync}
          onChange={(v) => void update({ skills_auto_sync: v })}
          label="Sync skills automatically"
          description="Pushes changed skills to every online machine when the library changes or a machine connects. Never removes skills from a machine."
        />
      </div>
    </div>
  );
}

/** Last sync per machine: errors stay here instead of piling up as toasts. */
function MachineSyncList({ machines, sync }: { machines: MachineView[]; sync: Record<string, SkillSyncStatus> }) {
  const shown = machines.filter((m) => sync[m.record.machine_id] || !can(m, "skills.edit"));
  if (!shown.length) return null;
  return (
    <div className="flex flex-wrap gap-x-5 gap-y-1.5 px-1 text-[12px] text-muted">
      {shown.map((m) => {
        const s = sync[m.record.machine_id];
        return (
          <span key={m.record.machine_id} className="flex min-w-0 items-center gap-1.5" title={s?.error ?? undefined}>
            {!can(m, "skills.edit") ? (
              <Lock size={12} className="text-faint" />
            ) : s.state === "syncing" ? (
              <Spinner className="h-3 w-3" />
            ) : s.state === "error" ? (
              <AlertTriangle size={12} className="text-error" />
            ) : (
              <Check size={12} className="text-done" />
            )}
            <span className="font-medium text-text">{m.record.name}</span>
            <span className="truncate">
              {!can(m, "skills.edit")
                ? "can't receive skills (no skills.edit permission)"
                : s.state === "syncing"
                  ? "syncing…"
                  : s.state === "error"
                    ? `sync failed: ${s.error?.split("\n")[0] ?? "unknown error"}`
                    : `last sync ${shortTime(new Date(s.at * 1000).toISOString())}${s.pushed.length ? ` · ${s.pushed.length} pushed` : ""}${s.removed.length ? ` · ${s.removed.length} removed` : ""}`}
            </span>
          </span>
        );
      })}
    </div>
  );
}

const CELL: Record<SkillCell["state"], { label: string; className: string; icon?: React.ReactNode }> = {
  synced: { label: "In sync", className: "text-done", icon: <Check size={12} /> },
  outdated: { label: "Outdated", className: "text-blocked", icon: <ArrowUp size={12} /> },
  missing: { label: "Missing", className: "text-muted", icon: <X size={12} /> },
  conflict: { label: "Conflict", className: "text-error", icon: <AlertTriangle size={12} /> },
  "remote-only": { label: "Remote only", className: "text-muted" },
  "no-permission": { label: "No access", className: "text-faint", icon: <Lock size={12} /> },
  offline: { label: "Offline", className: "text-faint", icon: <CloudOff size={12} /> },
  loading: { label: "", className: "text-faint" },
  error: { label: "Unavailable", className: "text-faint", icon: <AlertTriangle size={12} /> },
  none: { label: "—", className: "text-faint" },
};

function cellTitle(cell: SkillCell, machine: string): string | undefined {
  switch (cell.state) {
    case "synced":
      return `Same version on ${machine}`;
    case "outdated":
      return `${machine} has another version: click to push the library's`;
    case "missing":
      return `Not on ${machine}: click to push it`;
    case "conflict":
      return `Another skill of the same name is already installed (left untouched):\n${cell.paths.join("\n")}`;
    case "remote-only":
      return cell.conflict.length ? `Only on ${machine}, not in the library. Conflict:\n${cell.conflict.join("\n")}` : `Only on ${machine}, not in the library`;
    case "no-permission":
      return `This device can't read the skills of ${machine} (skills.read)`;
    case "offline":
      return `${machine} is offline`;
    case "error":
      return cell.message;
    default:
      return undefined;
  }
}

function SkillRowView({ row, machines, cells, onChanged }: { row: SkillRow; machines: MachineView[]; cells: SkillCell[]; onChanged: (machineIds: string[]) => void }) {
  const toast = useUi((s) => s.toast);
  const [busy, setBusy] = useState<string | null>(null);
  // Machines that have this skill and accept changes.
  const onRemote = machines.filter((m, i) => canEdit(m) && ["synced", "outdated", "conflict", "remote-only"].includes(cells[i].state));
  const targets = machines.filter(canEdit);

  const push = async (list: MachineView[]) => {
    if (!list.length) return toast("No online machine accepts skills (skills.edit)", "error");
    setBusy("push");
    const results = await Promise.allSettled(list.map((m) => skills.push(m.record.machine_id, row.name)));
    setBusy(null);
    const failed = results.map((r, i) => (r.status === "rejected" ? `${list[i].record.name}: ${errorMessage(r.reason)}` : null)).filter(Boolean);
    if (failed.length) toast(`Could not push ${row.name}: ${failed.join(" · ")}`, "error");
    else toast(`${row.name} pushed to ${list.length} machine${list.length === 1 ? "" : "s"}`, "success");
    onChanged(list.map((m) => m.record.machine_id));
  };

  const deleteLocal = async () => {
    if (!confirm(`Delete ${row.name} from the library? Its folder is removed from this computer. Machines keep their copy.`)) return;
    try {
      await skills.deleteLocal(row.name);
      toast(`${row.name} deleted from the library`);
    } catch (e) {
      toast(errorMessage(e), "error");
    }
    onChanged([]);
  };

  const deleteRemote = async () => {
    const list = onRemote;
    if (!confirm(`Remove ${row.name} from ${list.map((m) => m.record.name).join(", ")}?`)) return;
    setBusy("delete");
    const results = await Promise.allSettled(list.map((m) => skills.deleteRemote(m.record.machine_id, row.name)));
    setBusy(null);
    const failed = results.filter((r) => r.status === "rejected").length;
    toast(failed ? `Could not remove ${row.name} from ${failed} machine(s)` : `${row.name} removed from ${list.length} machine(s)`, failed ? "error" : "info");
    onChanged(list.map((m) => m.record.machine_id));
  };

  return (
    <div style={{ gridTemplateColumns: cols(machines.length) }} className="group grid min-w-fit items-center gap-x-3 border-b border-border px-3 py-1.5 text-[12.5px] last:border-0 hover:bg-surface-high/30">
      <span className="flex min-w-0 items-center gap-2">
        <span className="truncate font-medium">{row.name}</span>
        {!row.local && <span className="shrink-0 text-[11px] text-faint">not in library</span>}
      </span>
      <span className="truncate text-muted" title={row.description ?? undefined}>
        {row.description ?? "—"}
      </span>
      {machines.map((m, i) => {
        const cell = cells[i];
        const style = CELL[cell.state];
        const pushable = !!row.local && needsPush(cell) && canEdit(m);
        const content = (
          <>
            {cell.state === "loading" ? <Spinner className="h-3 w-3" /> : style.icon}
            <span className="truncate">{style.label}</span>
          </>
        );
        return pushable ? (
          <button
            key={m.record.machine_id}
            onClick={() => void push([m])}
            disabled={busy !== null}
            className={`flex min-w-0 items-center gap-1 rounded-md text-left hover:underline ${style.className}`}
            title={cellTitle(cell, m.record.name)}
          >
            {content}
          </button>
        ) : (
          <span key={m.record.machine_id} className={`flex min-w-0 items-center gap-1 ${style.className}`} title={cellTitle(cell, m.record.name)}>
            {content}
          </span>
        );
      })}
      <Menu
        trigger={
          <span>
            <IconButton label="Actions" className="h-6 w-6">
              {busy ? <Spinner /> : <MoreHorizontal size={15} />}
            </IconButton>
          </span>
        }
      >
        {row.local && (
          <>
            <MenuItem icon={<FolderOpen size={14} />} onSelect={() => void skills.openFolder(row.name).catch((e) => toast(errorMessage(e), "error"))}>
              Open in editor
            </MenuItem>
            <MenuItem icon={<Upload size={14} />} disabled={!targets.length || busy !== null} onSelect={() => void push(targets)}>
              Push to all machines
            </MenuItem>
          </>
        )}
        {onRemote.length > 0 && (
          <MenuItem icon={<X size={14} />} disabled={busy !== null} onSelect={() => void deleteRemote()}>
            Remove from machines…
          </MenuItem>
        )}
        {row.local && (
          <>
            <MenuSeparator />
            <MenuItem danger icon={<Trash2 size={14} />} onSelect={() => void deleteLocal()}>
              Delete from library…
            </MenuItem>
          </>
        )}
      </Menu>
    </div>
  );
}

function NewSkillDialog({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange: (open: boolean) => void; onCreated: () => void }) {
  const toast = useUi((s) => s.toast);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const valid = validSkillName(name);

  useEffect(() => {
    if (!open) return;
    setName("");
    setDescription("");
    setError(null);
  }, [open]);

  const submit = async () => {
    if (!valid) return;
    setSaving(true);
    setError(null);
    try {
      await skills.create(name, description);
      onCreated();
      onOpenChange(false);
      toast(`${name} created: edit its SKILL.md`, "success");
      void skills.openFolder(name).catch(() => {});
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="New skill" description="Creates a folder with a SKILL.md template in the library." width={460}>
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Field label="Name" hint="Lowercase letters, digits, “.”, “_” and “-”.">
          <input autoFocus value={name} onChange={(e) => setName(e.target.value.trim())} placeholder="deploy-app" className={`${inputClass} font-mono`} />
        </Field>
        <Field label="Description" hint="Tells the agent when to use the skill.">
          <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Deploys the app to production with the release checklist." className={inputClass} />
        </Field>
        {name && !valid && <p className="text-[12px] text-error">Invalid name.</p>}
        {error && <p className="text-[12px] text-error">{error}</p>}
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" size="sm" variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" size="sm" variant="primary" disabled={!valid} loading={saving}>
            Create
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function LibraryPathDialog({ open, onOpenChange, current, onSaved }: { open: boolean; onOpenChange: (open: boolean) => void; current: string; onSaved: () => void }) {
  const update = useSettings((s) => s.update);
  const [path, setPath] = useState(current);

  useEffect(() => {
    if (open) setPath(current);
  }, [open, current]);

  const save = async (value: string | null) => {
    await update({ skills_dir: value });
    onSaved();
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Skills library" description="Folder whose subfolders with a SKILL.md are the skills to sync." width={520}>
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          void save(path.trim() || null);
        }}
      >
        <Field label="Folder" hint="Absolute path; “~” is your home folder.">
          <input autoFocus value={path} onChange={(e) => setPath(e.target.value)} placeholder="~/huntaway-skills" className={`${inputClass} font-mono`} />
        </Field>
        <div className="flex justify-between gap-2 pt-1">
          <Button type="button" size="sm" variant="ghost" onClick={() => void save(null)}>
            Use default (~/huntaway-skills)
          </Button>
          <div className="flex gap-2">
            <Button type="button" size="sm" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" size="sm" variant="primary">
              Save
            </Button>
          </div>
        </div>
      </form>
    </Dialog>
  );
}
