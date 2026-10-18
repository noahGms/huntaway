import { getVersion } from "@tauri-apps/api/app";
import { listen } from "@tauri-apps/api/event";
import { Check, Layers, Plus, Trash2 } from "lucide-react";
import { app, errorMessage } from "../api/client";
import { useEffect, useState } from "react";
import { Button, IconButton, Kbd } from "../components/ui/Button";
import { inputClass } from "../components/ui/Dialog";
import { Logo } from "../components/ui/Logo";
import { Menu, MenuItem } from "../components/ui/Menu";
import { Toggle } from "../components/ui/Toggle";
import { ALT, MOD, SHIFT } from "../lib/keys";
import { orderMachines } from "../lib/spaces";
import { useUpdates } from "../lib/updates";
import { machineList, useMachines } from "../store/machines";
import { usePrefs } from "../store/prefs";
import { useSettings } from "../store/settings";
import { PageHeader } from "./ServersPage";

const SHORTCUTS: [string[], string][] = [
  [[MOD, "K"], "Search, go to a conversation, run an action"],
  [[MOD, "N"], "New session"],
  [[MOD, "."], "Stop the agent on screen"],
  [["1", "…", "9"], "Pick an option of the approval card"],
  [["Esc"], "Deny an approval"],
  [[MOD, "B"], "Show or hide the sidebar"],
  [[MOD, ALT, "B"], "Show or hide the activity panel"],
  [[MOD, "1/2/3"], "Details, Files, Terminal tab"],
  [[ALT, "↑/↓"], "Previous, next conversation"],
  [[MOD, SHIFT, "A"], "Go to the next waiting agent"],
];

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-8">
      <h2 className="mb-2 text-[12px] font-semibold uppercase tracking-wider text-faint">{title}</h2>
      <div className="divide-y divide-border rounded-2xl border border-border bg-surface px-4">{children}</div>
    </section>
  );
}

function Updates() {
  const { ready, checking, checkNow, restart } = useUpdates();
  const [state, setState] = useState<{ step: "idle" | "none" | "installing" | "error"; error?: string }>({ step: "idle" });
  const run = async () => {
    try {
      const version = await checkNow();
      setState({ step: version ? "idle" : "none" });
    } catch (e) {
      setState({ step: "error", error: errorMessage(e) });
    }
  };
  const install = async () => {
    setState({ step: "installing" });
    try {
      await restart();
    } catch (e) {
      setState({ step: "error", error: errorMessage(e) });
    }
  };
  return (
    <div className="flex items-center justify-between gap-4 py-3 text-[13px]">
      <span className="text-muted">
        {state.step === "error" ? (
          <span className="text-error">{state.error}</span>
        ) : ready ? (
          `Version ${ready.version} is downloaded and ready.`
        ) : checking ? (
          "Checking…"
        ) : state.step === "none" ? (
          "Huntaway is up to date."
        ) : (
          "Signed updates, checked every 6 hours."
        )}
      </span>
      {ready ? (
        <Button size="sm" variant="primary" loading={state.step === "installing"} onClick={() => void install()}>
          Restart to update
        </Button>
      ) : (
        <Button size="sm" loading={checking} onClick={() => void run()}>
          Check for updates
        </Button>
      )}
    </div>
  );
}

const TEST_RESULT: Record<string, string> = {
  "Approve(1)": "“Approve” received: the agent would have got option 1.",
  Deny: "“Deny” received: the agent would have been denied.",
  Open: "Click received: the conversation would have opened.",
  Nothing: "Notification closed without an action.",
};

function NotificationTest() {
  const [result, setResult] = useState<string | null>(null);
  useEffect(() => {
    const un = listen<string>("notification-test", (e) => setResult(TEST_RESULT[e.payload] ?? e.payload));
    return () => void un.then((u) => u());
  }, []);
  return (
    <div className="flex items-center justify-between gap-4 py-3 text-[13px]">
      <span className="text-muted">{result ?? "Shows a fake approval notification with its buttons."}</span>
      <Button
        size="sm"
        onClick={() => {
          setResult("Notification sent: click “Approve” or “Deny”.");
          void app.testNotification().catch((e) => setResult(errorMessage(e)));
        }}
      >
        Test
      </Button>
    </div>
  );
}

/** Machine groups: the spaces offered by the sidebar selector (stored on this computer). */
function MachineGroups() {
  const { groups, addGroup, renameGroup, removeGroup, toggleGroupMachine, machineOrder } = usePrefs();
  const machines = orderMachines(machineList(useMachines((s) => s.machines)), machineOrder);
  const [name, setName] = useState("");
  const create = () => {
    if (!name.trim()) return;
    addGroup(name.trim());
    setName("");
  };
  return (
    <>
      {groups.map((g) => (
        <div key={g.id} className="flex items-center gap-2 py-2.5 text-[13px]">
          <Layers size={14} className="shrink-0 text-faint" />
          <input
            defaultValue={g.name}
            onBlur={(e) => e.target.value.trim() && renameGroup(g.id, e.target.value.trim())}
            onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
            className="min-w-0 flex-1 rounded-md bg-transparent px-1 py-0.5 text-text hover:bg-surface-high focus:bg-bg focus:outline-none"
            aria-label="Group name"
          />
          <Menu
            trigger={
              <button className="max-w-[260px] truncate rounded-md px-2 py-0.5 text-[12px] text-muted hover:bg-surface-high hover:text-text">
                {g.machineIds.filter((id) => machines.some((m) => m.record.machine_id === id)).length} machine(s)
              </button>
            }
          >
            {machines.length === 0 && <div className="px-2.5 py-1.5 text-[12px] text-faint">No machine yet.</div>}
            {machines.map((m) => (
              <MenuItem key={m.record.machine_id} onSelect={() => toggleGroupMachine(g.id, m.record.machine_id)}>
                <span className="truncate">{m.record.name}</span>
                {g.machineIds.includes(m.record.machine_id) && <Check size={13} className="ml-auto text-muted" />}
              </MenuItem>
            ))}
          </Menu>
          <IconButton label="Delete group" onClick={() => removeGroup(g.id)} className="h-6 w-6">
            <Trash2 size={13} />
          </IconButton>
        </div>
      ))}
      <form
        className="flex items-center gap-2 py-2.5"
        onSubmit={(e) => {
          e.preventDefault();
          create();
        }}
      >
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="New group (Personal, Client X…)" className={`${inputClass} !py-1.5`} />
        <Button size="sm" type="submit" icon={<Plus size={13} />} disabled={!name.trim()}>
          Add
        </Button>
      </form>
    </>
  );
}

function InactiveDays() {
  const { inactiveDays, setInactiveDays } = usePrefs();
  return (
    <div className="flex items-center justify-between gap-4 py-2.5 text-[13px]">
      <span>
        <span className="block text-text">Hide inactive projects</span>
        <span className="mt-0.5 block text-[12px] text-muted">Projects without a running agent or recent activity. Favorites always stay.</span>
      </span>
      <select value={inactiveDays} onChange={(e) => setInactiveDays(Number(e.target.value))} className={`${inputClass} !w-[140px] shrink-0 !py-1.5`}>
        <option value={0}>Never</option>
        <option value={3}>After 3 days</option>
        <option value={7}>After 7 days</option>
        <option value={14}>After 14 days</option>
        <option value={30}>After 30 days</option>
      </select>
    </div>
  );
}

export function SettingsPage() {
  const { settings, update } = useSettings();
  const [version, setVersion] = useState("");
  useEffect(() => {
    void getVersion().then(setVersion).catch(() => {});
  }, []);
  return (
    <div className="flex h-full flex-col">
      <PageHeader title="Settings" />
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-6">
        <div className="mx-auto max-w-[640px]">
          <Section title="General">
            <Toggle checked={settings.keep_in_tray} onChange={(v) => void update({ keep_in_tray: v })} label="Keep in the menu bar" description="Closing the window keeps Huntaway running for notifications." />
            <Toggle checked={settings.enter_to_send} onChange={(v) => void update({ enter_to_send: v })} label="Send with Enter" description={settings.enter_to_send ? "Shift + Enter for a new line." : `${MOD} + Enter to send.`} />
            <Toggle checked={settings.show_cost} onChange={(v) => void update({ show_cost: v })} label="Show estimated cost" description="Based on public API prices: subscriptions are billed differently." />
          </Section>
          <Section title="Sidebar">
            <InactiveDays />
          </Section>
          <Section title="Machine groups">
            <MachineGroups />
          </Section>
          <Section title="Notifications">
            <Toggle checked={settings.notify_blocked} onChange={(v) => void update({ notify_blocked: v })} label="An agent needs me" description="Approval, question, plan to review." />
            <Toggle checked={settings.notify_done} onChange={(v) => void update({ notify_done: v })} label="An agent is done" />
            <Toggle checked={settings.notify_error} onChange={(v) => void update({ notify_error: v })} label="An agent stopped" />
            <Toggle checked={settings.notification_sound} onChange={(v) => void update({ notification_sound: v })} label="Sound" />
            <NotificationTest />
          </Section>
          <Section title="Shortcuts">
            {SHORTCUTS.map(([keys, label]) => (
              <div key={label} className="flex items-center justify-between py-2.5 text-[13px]">
                <span className="text-muted">{label}</span>
                <span className="flex gap-1">
                  {keys.map((k) => (
                    <Kbd key={k}>{k}</Kbd>
                  ))}
                </span>
              </div>
            ))}
          </Section>
          <Section title="About">
            <div className="flex items-center gap-3 py-4">
              <Logo size={40} />
              <div>
                <div className="text-[14px] font-semibold">Huntaway Desktop</div>
                <div className="text-[12px] text-muted">Version {version} · control your Herdr agents, locally and on your servers.</div>
              </div>
            </div>
            <Updates />
          </Section>
        </div>
      </div>
    </div>
  );
}
