import { ArrowDownCircle, Check, ChevronDown, ChevronRight, ChevronUp, Copy, Layers, Monitor, MoreHorizontal, Pencil, Plus, RefreshCw, Server, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { api, app, errorMessage } from "../api/client";
import type { LocalStatus, MachineResponse, MachineView } from "../api/types";
import { Button, IconButton, Spinner } from "../components/ui/Button";
import { inputClass } from "../components/ui/Dialog";
import { Menu, MenuItem, MenuSeparator } from "../components/ui/Menu";
import { Badge, MachineDot } from "../components/ui/Status";
import { duration } from "../lib/format";
import { moveMachine, orderMachines } from "../lib/spaces";
import { DAEMON_UPDATE_COMMAND, daemonOutdated, useDaemonUpdates, useUpdates } from "../lib/updates";
import { can, machineList, useMachines } from "../store/machines";
import { usePrefs } from "../store/prefs";
import { useUi } from "../store/ui";

const PERMISSION_LABELS: Record<string, string> = {
  "agents.read": "read",
  "agents.message": "messages",
  "agents.approve": "approvals",
  "agents.interrupt": "interrupt",
  "agents.input": "raw input",
  "agents.create": "create agents",
  "agents.resume": "resume",
  "terminal.read": "terminal",
  "history.read": "history",
  "files.read": "files",
  "skills.read": "skills",
  "skills.edit": "push skills",
  "daemon.update": "update daemon",
};

export function PageHeader({ title, subtitle, children }: { title: string; subtitle?: string; children?: React.ReactNode }) {
  return (
    <div className="drag flex h-[52px] shrink-0 items-center gap-3 border-b border-border px-6">
      <div className="no-drag min-w-0 flex-1">
        <h1 className="truncate text-[14.5px] font-semibold">{title}</h1>
      </div>
      {subtitle && <span className="no-drag text-[12px] text-faint">{subtitle}</span>}
      <div className="no-drag flex items-center gap-2">{children}</div>
    </div>
  );
}

const COLS = "grid grid-cols-[28px_minmax(150px,1.6fr)_minmax(96px,0.8fr)_64px_minmax(120px,0.9fr)_72px_minmax(90px,0.8fr)_32px] items-center gap-x-3";

const versionOf = (m: MachineView, info?: MachineResponse | null) => info?.machine.bridge_version ?? m.snapshot?.machine.bridge_version ?? null;

export function ServersPage() {
  const machineOrder = usePrefs((s) => s.machineOrder);
  const machines = orderMachines(machineList(useMachines((s) => s.machines)), machineOrder);
  const openPair = useUi((s) => s.openPair);
  const latest = useUpdates((s) => s.latest);
  const hasLocal = machines.some((m) => m.record.local);
  const outdated = machines.filter((m) => daemonOutdated(versionOf(m), latest));
  return (
    <div className="flex h-full flex-col">
      <PageHeader title="Servers" subtitle={`${machines.length} machine${machines.length === 1 ? "" : "s"}`}>
        <Button variant="primary" size="sm" icon={<Plus size={14} />} onClick={() => openPair()}>
          Add machine
        </Button>
      </PageHeader>
      <div className="min-h-0 flex-1 overflow-y-auto p-6">
        <div className="mx-auto max-w-[1100px] space-y-4">
          {outdated.length > 0 && latest && <DaemonUpdateNotice latest={latest} outdated={outdated} />}
          {machines.length > 0 && (
            <div className="overflow-hidden rounded-xl border border-border bg-surface">
              <div className={`${COLS} border-b border-border px-3 py-2 text-[11px] font-medium uppercase tracking-wider text-faint`}>
                <span />
                <span>Name</span>
                <span>State</span>
                <span className="text-right">Latency</span>
                <span>huntawayd</span>
                <span className="text-right">Agents</span>
                <span>Group</span>
                <span />
              </div>
              {machines.map((m, i) => (
                <MachineRow key={m.record.machine_id} machine={m} order={machines.map((x) => x.record.machine_id)} first={i === 0} last={i === machines.length - 1} latest={latest} />
              ))}
            </div>
          )}
          {!hasLocal && <LocalDaemonCard />}
        </div>
      </div>
    </div>
  );
}

function CopyCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center gap-2 rounded-[10px] border border-border bg-bg px-3 py-2">
      <code className="selectable min-w-0 flex-1 truncate font-mono text-[11.5px] text-muted">{command}</code>
      <button
        onClick={() => {
          void navigator.clipboard.writeText(command).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          });
        }}
        className="text-faint hover:text-text"
        aria-label="Copy"
        title="Copy"
      >
        {copied ? <Check size={14} /> : <Copy size={14} />}
      </button>
    </div>
  );
}

/** Can update its daemon from here: online, with `daemon.update`. */
const selfUpdatable = (m: MachineView) => m.status.state === "online" && can(m, "daemon.update");

function DaemonUpdateNotice({ latest, outdated }: { latest: string; outdated: MachineView[] }) {
  const { updates, run } = useDaemonUpdates();
  const count = outdated.length;
  const updatable = outdated.filter((m) => selfUpdatable(m) && updates[m.record.machine_id]?.state !== "updating");
  const manual = outdated.filter((m) => !can(m, "daemon.update"));
  const updating = outdated.filter((m) => updates[m.record.machine_id]?.state === "updating").length;
  return (
    <div className="rounded-xl border border-border bg-surface px-4 py-3">
      <div className={`flex items-center gap-2 text-[13px] ${manual.length ? "mb-2" : ""}`}>
        <ArrowDownCircle size={15} className="shrink-0 text-blocked" />
        <span className="min-w-0 flex-1">
          huntawayd {latest} is available · {count} machine{count === 1 ? " is" : "s are"} out of date
          {updating > 0 && <span className="text-muted"> · updating {updating}…</span>}
          {manual.length > 0 && (
            <>
              . Run this on {manual.length === count ? "each one" : manual.map((m) => m.record.name).join(", ")}:
            </>
          )}
        </span>
        {updatable.length > 0 && (
          <Button size="sm" variant="primary" onClick={() => updatable.forEach((m) => void run(m.record.machine_id))}>
            Update all ({updatable.length})
          </Button>
        )}
      </div>
      {manual.length > 0 && <CopyCommand command={DAEMON_UPDATE_COMMAND} />}
    </div>
  );
}

/** Update badge of a machine row: button when the daemon can update itself. */
function DaemonUpdateCell({ machine, latest }: { machine: MachineView; latest: string | null }) {
  const id = machine.record.machine_id;
  const update = useDaemonUpdates((s) => s.updates[id]);
  const run = useDaemonUpdates((s) => s.run);
  if (update?.state === "updating") {
    return (
      <span className="flex shrink-0 items-center gap-1 text-[11.5px] text-muted" title={update.to ? `Installing huntawayd ${update.to}` : undefined}>
        <Spinner className="h-3 w-3" /> Updating…
      </span>
    );
  }
  if (update?.state === "error") {
    return (
      <button onClick={() => void run(id)} title={`${update.error ?? "Update failed"}. Click to retry.`}>
        <Badge tone="error">update failed</Badge>
      </button>
    );
  }
  if (!daemonOutdated(versionOf(machine), latest)) return null;
  if (selfUpdatable(machine)) {
    return (
      <button onClick={() => void run(id)} title={`Install huntawayd ${latest} on this machine; it restarts on its own`}>
        <Badge tone="blocked">Update</Badge>
      </button>
    );
  }
  return (
    <span title={`huntawayd ${latest} is available${can(machine, "daemon.update") ? "" : ": update it on the machine (no daemon.update permission)"}`}>
      <Badge tone="blocked">update</Badge>
    </span>
  );
}

function MachineRow({ machine, order, first, last, latest }: { machine: MachineView; order: string[]; first: boolean; last: boolean; latest: string | null }) {
  const { record, status, snapshot } = machine;
  const id = record.machine_id;
  const { toast, setView } = useUi();
  const { groups, toggleGroupMachine, setMachineOrder, setSpace } = usePrefs();
  const [open, setOpen] = useState(false);
  const [info, setInfo] = useState<MachineResponse | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(record.name);
  const [reconnecting, setReconnecting] = useState(false);

  useEffect(() => {
    if (!open || status.state !== "online") return;
    let alive = true;
    api
      .machine(id)
      .then((r) => alive && setInfo(r))
      .catch(() => alive && setInfo(null));
    return () => {
      alive = false;
    };
  }, [open, id, status.state]);

  const agents = snapshot?.agents ?? [];
  const waiting = agents.filter((a) => a.attention.status === "blocked").length;
  const slow = (status.latency_ms ?? 0) > 400;
  const version = versionOf(machine, info);
  const memberOf = groups.filter((g) => g.machineIds.includes(id));

  const startRename = () => {
    setName(record.name);
    setRenaming(true);
  };
  const saveRename = () => {
    setRenaming(false);
    const next = name.trim();
    if (!next || next === record.name) return;
    app
      .renameMachine(id, next)
      .then(() => useMachines.getState().refresh())
      .catch((err) => toast(errorMessage(err), "error"));
  };
  const reconnect = () => {
    setReconnecting(true);
    app
      .reconnectMachine(id)
      .then(() => toast(`Reconnecting to ${record.name}…`))
      .catch((e) => toast(`Could not reconnect ${record.name}: ${errorMessage(e)}`, "error"))
      .finally(() => setReconnecting(false));
  };
  const forget = () => {
    if (!confirm(`Forget ${record.name}? You will need to pair it again (and revoke this device on the machine with \`huntawayd devices revoke\`).`)) return;
    app
      .forgetMachine(id)
      .then(() => toast(`${record.name} forgotten`))
      .catch((e) => toast(`Could not forget ${record.name}: ${errorMessage(e)}`, "error"));
  };
  const showConversations = () => {
    setSpace({ kind: "machine", id });
    setView("conversations");
  };

  const stateLabel = status.state === "online" ? (slow ? "Slow" : "Online") : status.state === "connecting" || reconnecting ? "Connecting…" : "Offline";

  return (
    <div className="group border-b border-border last:border-0">
      <div className={`${COLS} px-3 py-1.5 text-[12.5px] hover:bg-surface-high/30`}>
        <span className="flex flex-col items-center opacity-0 group-hover:opacity-100">
          <button disabled={first} onClick={() => setMachineOrder(moveMachine(order, id, -1))} className="text-faint hover:text-text disabled:opacity-30" aria-label="Move up" title="Move up">
            <ChevronUp size={12} />
          </button>
          <button disabled={last} onClick={() => setMachineOrder(moveMachine(order, id, 1))} className="text-faint hover:text-text disabled:opacity-30" aria-label="Move down" title="Move down">
            <ChevronDown size={12} />
          </button>
        </span>
        <div className="flex min-w-0 items-center gap-2">
          <button onClick={() => setOpen(!open)} className="shrink-0 text-faint hover:text-text" aria-label={open ? "Hide details" : "Show details"} aria-expanded={open}>
            {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          </button>
          {record.local ? <Monitor size={14} className="shrink-0 text-muted" /> : <Server size={14} className="shrink-0 text-muted" />}
          {renaming ? (
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              onBlur={saveRename}
              onKeyDown={(e) => {
                if (e.key === "Enter") e.currentTarget.blur();
                if (e.key === "Escape") {
                  e.preventDefault();
                  setName(record.name);
                  setRenaming(false);
                }
              }}
              className={`${inputClass} !py-0.5`}
            />
          ) : (
            <>
              <button onClick={() => setOpen(!open)} onDoubleClick={() => !record.local && startRename()} className="min-w-0 truncate text-left font-medium">
                {record.name}
              </button>
              {record.local && <Badge>this computer</Badge>}
            </>
          )}
        </div>
        <span className="flex min-w-0 items-center gap-1.5 text-muted" title={status.error ?? status.address ?? undefined}>
          <MachineDot state={reconnecting ? "connecting" : status.state} slow={slow} />
          <span className="truncate">{stateLabel}</span>
        </span>
        <span className="text-right tabular-nums text-muted">{status.state === "online" && status.latency_ms !== null ? `${status.latency_ms} ms` : "—"}</span>
        <span className="flex min-w-0 items-center gap-1.5">
          <span className={`truncate tabular-nums ${status.state === "online" ? "" : "text-faint"}`}>{version ?? "—"}</span>
          <DaemonUpdateCell machine={machine} latest={latest} />
        </span>
        <button onClick={showConversations} className="flex items-center justify-end gap-1.5 tabular-nums hover:underline" title="Show its conversations">
          {waiting > 0 && <span className="rounded bg-blocked px-1 text-[10.5px] font-semibold leading-4 text-ink">{waiting}</span>}
          {snapshot ? agents.length : "—"}
        </button>
        <Menu
          align="start"
          trigger={
            <button className="flex min-w-0 items-center gap-1 rounded-md px-1 py-0.5 text-left text-muted hover:bg-surface-high hover:text-text">
              <span className="truncate">{memberOf.length ? memberOf.map((g) => g.name).join(", ") : "—"}</span>
              <ChevronDown size={11} className="shrink-0 text-faint" />
            </button>
          }
        >
          {groups.map((g) => (
            <MenuItem key={g.id} icon={<Layers size={14} />} onSelect={() => toggleGroupMachine(g.id, id)}>
              <span className="truncate">{g.name}</span>
              {g.machineIds.includes(id) && <Check size={13} className="ml-auto text-muted" />}
            </MenuItem>
          ))}
          {groups.length > 0 && <MenuSeparator />}
          <MenuItem icon={<Plus size={14} />} onSelect={() => setView("settings")}>
            {groups.length ? "Edit groups…" : "Create a group…"}
          </MenuItem>
        </Menu>
        <Menu
          trigger={
            <span>
              <IconButton label="Actions" className="h-6 w-6">
                {reconnecting ? <Spinner /> : <MoreHorizontal size={15} />}
              </IconButton>
            </span>
          }
        >
          {!record.local && (
            <MenuItem icon={<Pencil size={14} />} onSelect={startRename}>
              Rename
            </MenuItem>
          )}
          <MenuItem icon={<RefreshCw size={14} />} onSelect={reconnect} disabled={reconnecting}>
            Reconnect
          </MenuItem>
          <MenuItem
            icon={<Copy size={14} />}
            onSelect={() => {
              void navigator.clipboard.writeText(id).then(() => toast("Machine ID copied"));
            }}
          >
            Copy machine ID
          </MenuItem>
          {!record.local && (
            <>
              <MenuSeparator />
              <MenuItem danger icon={<Trash2 size={14} />} onSelect={forget}>
                Forget this machine
              </MenuItem>
            </>
          )}
        </Menu>
      </div>
      {open && (
        <dl className="grid grid-cols-[110px_1fr] gap-y-1.5 border-t border-border bg-bg/40 py-3 pl-[52px] pr-4 text-[12px]">
          {status.state !== "online" && status.error && (
            <>
              <dt className="text-muted">Error</dt>
              <dd className="selectable text-error">{status.error}</dd>
            </>
          )}
          <dt className="text-muted">Daemon</dt>
          <dd>
            huntawayd {version ?? "—"}
            {info?.uptime_secs !== undefined && info?.uptime_secs !== null && <span className="text-faint"> · up {duration(info.uptime_secs * 1000)}</span>}
          </dd>
          <dt className="text-muted">Herdr</dt>
          <dd>
            {(snapshot?.sessions ?? []).length === 0
              ? "no session"
              : snapshot!.sessions.map((s) => (
                  <span key={s.name} className="mr-2" title={s.warnings.join("\n") || undefined}>
                    {s.name} <span className="text-faint">v{s.herdr_version}</span>
                    {s.warnings.length > 0 && <span className="text-blocked"> ⚠</span>}
                  </span>
                ))}
          </dd>
          {info?.machine.os && (
            <>
              <dt className="text-muted">System</dt>
              <dd>
                {info.machine.os}
                {info.machine.hostname && <span className="text-faint"> · {info.machine.hostname}</span>}
              </dd>
            </>
          )}
          <dt className="text-muted">Addresses</dt>
          <dd className="selectable truncate font-mono text-[11.5px]">
            {record.addresses.join(", ")}
            {status.state === "online" && status.address && <span className="text-faint"> · connected via {status.address}</span>}
          </dd>
          <dt className="text-muted">Permissions</dt>
          <dd className="flex flex-wrap gap-1">
            {record.permissions
              .filter((p) => PERMISSION_LABELS[p])
              .map((p) => (
                <span key={p} className="rounded-md bg-surface-high px-1.5 text-[11px] text-muted">
                  {PERMISSION_LABELS[p]}
                </span>
              ))}
          </dd>
        </dl>
      )}
    </div>
  );
}

export function LocalDaemonCard() {
  const [status, setStatus] = useState<LocalStatus | null>(null);
  const [starting, setStarting] = useState(false);
  const toast = useUi((s) => s.toast);
  const refreshStatus = () => void app.localStatus().then(setStatus).catch(() => {});
  useEffect(refreshStatus, []);
  if (!status) return null;
  return (
    <div className="rounded-2xl border border-dashed border-border bg-surface/50 p-5">
      <div className="mb-1 flex items-center gap-2 text-[14px] font-semibold">
        <Monitor size={16} className="text-muted" /> This computer
      </div>
      {status.installed ? (
        <>
          <p className="mb-4 text-[12.5px] leading-relaxed text-muted">
            huntawayd is installed but the app can't reach it: it is stopped, or too old for the desktop app (no local token).
          </p>
          <div className="flex gap-2">
            <Button
              variant="primary"
              size="sm"
              loading={starting}
              onClick={async () => {
                setStarting(true);
                try {
                  const ok = await app.startLocalDaemon();
                  toast(ok ? "Local daemon connected" : "Daemon started but not reachable yet: update it", ok ? "success" : "info");
                } catch (e) {
                  toast(errorMessage(e), "error");
                } finally {
                  setStarting(false);
                  refreshStatus();
                }
              }}
            >
              Start the daemon
            </Button>
            <Button size="sm" onClick={() => void app.refreshLocal().catch((e) => toast(errorMessage(e), "error"))}>
              Retry
            </Button>
          </div>
        </>
      ) : (
        <>
          <p className="mb-3 text-[12.5px] leading-relaxed text-muted">
            Install the daemon to control the Herdr agents of this computer. The app connects to it on its own, no pairing needed.
          </p>
          <CopyCommand command={status.install_command} />
        </>
      )}
    </div>
  );
}
