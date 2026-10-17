import { Check, Copy, Monitor, MoreHorizontal, Pencil, Plus, RefreshCw, Server, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { api, app, errorMessage } from "../api/client";
import type { LocalStatus, MachineResponse, MachineView } from "../api/types";
import { Button, IconButton } from "../components/ui/Button";
import { inputClass } from "../components/ui/Dialog";
import { Menu, MenuItem, MenuSeparator } from "../components/ui/Menu";
import { Badge, MachineDot } from "../components/ui/Status";
import { duration } from "../lib/format";
import { machineList, useMachines } from "../store/machines";
import { useUi } from "../store/ui";

const PERMISSION_LABELS: Record<string, string> = {
  "agents.read": "lecture",
  "agents.message": "messages",
  "agents.approve": "approbations",
  "agents.interrupt": "interruption",
  "agents.input": "saisie brute",
  "agents.create": "création d'agents",
  "agents.resume": "reprise",
  "terminal.read": "terminal",
  "history.read": "historique",
  "files.read": "fichiers",
};

export function PageHeader({ title, subtitle, children }: { title: string; subtitle?: string; children?: React.ReactNode }) {
  return (
    <div className="drag flex h-[52px] shrink-0 items-center gap-3 border-b border-border px-6">
      <div className="no-drag min-w-0 flex-1">
        <h1 className="text-[14.5px] font-semibold">{title}</h1>
      </div>
      {subtitle && <span className="no-drag text-[12px] text-faint">{subtitle}</span>}
      <div className="no-drag flex items-center gap-2">{children}</div>
    </div>
  );
}

export function ServersPage() {
  const machines = machineList(useMachines((s) => s.machines));
  const openPair = useUi((s) => s.openPair);
  const hasLocal = machines.some((m) => m.record.local);
  return (
    <div className="flex h-full flex-col">
      <PageHeader title="Serveurs" subtitle={`${machines.length} machine${machines.length > 1 ? "s" : ""}`}>
        <Button variant="primary" size="sm" icon={<Plus size={14} />} onClick={() => openPair()}>
          Ajouter une machine
        </Button>
      </PageHeader>
      <div className="min-h-0 flex-1 overflow-y-auto p-6">
        <div className="mx-auto grid max-w-[1100px] gap-4 [grid-template-columns:repeat(auto-fill,minmax(420px,1fr))]">
          {!hasLocal && <LocalDaemonCard />}
          {machines.map((m) => (
            <MachineCard key={m.record.machine_id} machine={m} />
          ))}
        </div>
      </div>
    </div>
  );
}

function MachineCard({ machine }: { machine: MachineView }) {
  const { record, status, snapshot } = machine;
  const toast = useUi((s) => s.toast);
  const setMachineFilter = useUi((s) => s.setMachineFilter);
  const setView = useUi((s) => s.setView);
  const [info, setInfo] = useState<MachineResponse | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(record.name);

  useEffect(() => {
    if (status.state !== "online") return;
    api.machine(record.machine_id).then(setInfo).catch(() => setInfo(null));
  }, [record.machine_id, status.state]);

  const agents = snapshot?.agents ?? [];
  const waiting = agents.filter((a) => a.attention.status === "blocked").length;
  const working = agents.filter((a) => a.attention.status === "working").length;
  const slow = (status.latency_ms ?? 0) > 400;

  return (
    <div className="rounded-2xl border border-border bg-surface">
      <div className="flex items-start gap-3 border-b border-border px-4 py-3.5">
        <span className="mt-0.5 flex h-9 w-9 items-center justify-center rounded-xl border border-border bg-bg text-muted">
          {record.local ? <Monitor size={17} /> : <Server size={17} />}
        </span>
        <div className="min-w-0 flex-1">
          {renaming ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                app
                  .renameMachine(record.machine_id, name)
                  .then(() => {
                    setRenaming(false);
                    void useMachines.getState().refresh();
                  })
                  .catch((err) => toast(errorMessage(err), "error"));
              }}
            >
              <input autoFocus value={name} onChange={(e) => setName(e.target.value)} onBlur={() => setRenaming(false)} className={`${inputClass} py-1`} />
            </form>
          ) : (
            <div className="flex items-center gap-2">
              <span className="truncate text-[14px] font-semibold">{record.name}</span>
              {record.local && <Badge>cet ordinateur</Badge>}
            </div>
          )}
          <div className="mt-1 flex items-center gap-1.5 text-[12px] text-muted">
            <MachineDot state={status.state} slow={slow} />
            {status.state === "online"
              ? `Connecté via ${status.address ?? "?"}${status.latency_ms !== null ? ` · ${status.latency_ms} ms` : ""}`
              : status.state === "connecting"
                ? "Connexion…"
                : `Hors ligne${status.error ? ` — ${status.error}` : ""}`}
          </div>
        </div>
        <Menu
          trigger={
            <span>
              <IconButton label="Actions">
                <MoreHorizontal size={15} />
              </IconButton>
            </span>
          }
        >
          {!record.local && (
            <MenuItem icon={<Pencil size={14} />} onSelect={() => setRenaming(true)}>
              Renommer
            </MenuItem>
          )}
          <MenuItem icon={<RefreshCw size={14} />} onSelect={() => void app.reconnectMachine(record.machine_id)}>
            Reconnecter
          </MenuItem>
          <MenuItem
            icon={<Copy size={14} />}
            onSelect={() => {
              void navigator.clipboard.writeText(record.machine_id);
              toast("Identifiant copié");
            }}
          >
            Copier l'identifiant
          </MenuItem>
          {!record.local && (
            <>
              <MenuSeparator />
              <MenuItem
                danger
                icon={<Trash2 size={14} />}
                onSelect={() => {
                  if (confirm(`Oublier ${record.name} ? Il faudra l'appairer de nouveau (et révoquer l'appareil sur la machine avec \`huntawayd devices revoke\`).`)) {
                    void app.forgetMachine(record.machine_id).then(() => toast(`${record.name} oubliée`));
                  }
                }}
              >
                Oublier cette machine
              </MenuItem>
            </>
          )}
        </Menu>
      </div>
      <div className="grid grid-cols-3 border-b border-border text-center">
        {[
          ["Agents", agents.length],
          ["En attente", waiting],
          ["En cours", working],
        ].map(([label, value]) => (
          <button
            key={label}
            onClick={() => {
              setMachineFilter(record.machine_id);
              setView("conversations");
            }}
            className="border-r border-border py-3 last:border-0 hover:bg-surface-high/40"
          >
            <div className={`text-[18px] font-semibold ${label === "En attente" && Number(value) > 0 ? "text-blocked" : ""}`}>{value}</div>
            <div className="text-[11.5px] text-faint">{label}</div>
          </button>
        ))}
      </div>
      <dl className="grid grid-cols-[120px_1fr] gap-y-1.5 px-4 py-3 text-[12.5px]">
        <dt className="text-muted">Daemon</dt>
        <dd>huntawayd {info?.machine.bridge_version ?? snapshot?.machine.bridge_version ?? "—"}{info?.uptime_secs !== undefined && info?.uptime_secs !== null && <span className="text-faint"> · lancé il y a {duration(info.uptime_secs * 1000)}</span>}</dd>
        <dt className="text-muted">Herdr</dt>
        <dd>
          {(snapshot?.sessions ?? []).length === 0
            ? "aucune session"
            : snapshot!.sessions.map((s) => (
                <span key={s.name} className="mr-2">
                  {s.name} <span className="text-faint">v{s.herdr_version}</span>
                  {s.warnings.length > 0 && <span className="text-blocked"> ⚠</span>}
                </span>
              ))}
        </dd>
        {info?.machine.os && (
          <>
            <dt className="text-muted">Système</dt>
            <dd>
              {info.machine.os}
              {info.machine.hostname && <span className="text-faint"> · {info.machine.hostname}</span>}
            </dd>
          </>
        )}
        <dt className="text-muted">Adresses</dt>
        <dd className="selectable truncate font-mono text-[11.5px]">{record.addresses.join(", ")}</dd>
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
    </div>
  );
}

export function LocalDaemonCard() {
  const [status, setStatus] = useState<LocalStatus | null>(null);
  const [starting, setStarting] = useState(false);
  const [copied, setCopied] = useState(false);
  const toast = useUi((s) => s.toast);
  useEffect(() => {
    void app.localStatus().then(setStatus);
  }, []);
  if (!status) return null;
  return (
    <div className="rounded-2xl border border-dashed border-border bg-surface/50 p-5">
      <div className="mb-1 flex items-center gap-2 text-[14px] font-semibold">
        <Monitor size={16} className="text-muted" /> Cet ordinateur
      </div>
      {status.installed ? (
        <>
          <p className="mb-4 text-[12.5px] leading-relaxed text-muted">
            huntawayd est installé mais l'app ne le trouve pas : il est arrêté, ou trop ancien pour l'app desktop (pas de token local).
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
                  toast(ok ? "Daemon local connecté" : "Daemon démarré, mais pas encore joignable : mets-le à jour", ok ? "success" : "info");
                } catch (e) {
                  toast(errorMessage(e), "error");
                } finally {
                  setStarting(false);
                  void app.localStatus().then(setStatus);
                }
              }}
            >
              Démarrer le daemon
            </Button>
            <Button size="sm" onClick={() => void app.refreshLocal()}>
              Réessayer
            </Button>
          </div>
        </>
      ) : (
        <>
          <p className="mb-3 text-[12.5px] leading-relaxed text-muted">
            Pour piloter les agents Herdr de cet ordinateur, installe le daemon. L'app s'y connecte toute seule, sans appairage.
          </p>
          <div className="flex items-center gap-2 rounded-[10px] border border-border bg-bg px-3 py-2">
            <code className="selectable min-w-0 flex-1 truncate font-mono text-[11.5px] text-muted">{status.install_command}</code>
            <button
              onClick={() => {
                void navigator.clipboard.writeText(status.install_command);
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }}
              className="text-faint hover:text-text"
              aria-label="Copier"
            >
              {copied ? <Check size={14} /> : <Copy size={14} />}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
