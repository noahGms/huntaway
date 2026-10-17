import { getVersion } from "@tauri-apps/api/app";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { listen } from "@tauri-apps/api/event";
import { app, errorMessage } from "../api/client";
import { useEffect, useState } from "react";
import { Button, Kbd } from "../components/ui/Button";
import { Logo } from "../components/ui/Logo";
import { Toggle } from "../components/ui/Toggle";
import { useSettings } from "../store/settings";
import { PageHeader } from "./ServersPage";

const SHORTCUTS: [string[], string][] = [
  [["⌘", "K"], "Rechercher, aller à une conversation, lancer une action"],
  [["⌘", "N"], "Nouvelle session"],
  [["⌘", "."], "Interrompre l'agent affiché"],
  [["1", "…", "9"], "Choisir une option de la carte d'approbation"],
  [["Esc"], "Refuser une approbation"],
  [["⌘", "B"], "Afficher ou masquer la barre latérale"],
  [["⌘", "⌥", "B"], "Afficher ou masquer le panneau d'activité"],
  [["⌘", "1/2/3"], "Onglet Détails, Fichiers, Terminal"],
  [["⌥", "↑/↓"], "Conversation précédente, suivante"],
  [["⌘", "⇧", "A"], "Aller au prochain agent qui attend"],
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
  const [state, setState] = useState<{ step: "idle" | "checking" | "none" | "available" | "installing" | "error"; update?: Update; error?: string }>({ step: "idle" });
  const run = async () => {
    setState({ step: "checking" });
    try {
      const update = await check();
      setState(update ? { step: "available", update } : { step: "none" });
    } catch (e) {
      setState({ step: "error", error: errorMessage(e) });
    }
  };
  const install = async () => {
    if (!state.update) return;
    setState({ ...state, step: "installing" });
    try {
      await state.update.downloadAndInstall();
      await relaunch();
    } catch (e) {
      setState({ step: "error", error: errorMessage(e) });
    }
  };
  return (
    <div className="flex items-center justify-between gap-4 py-3 text-[13px]">
      <span className="text-muted">
        {state.step === "none" && "Huntaway est à jour."}
        {state.step === "available" && `Version ${state.update?.version} disponible.`}
        {state.step === "error" && <span className="text-error">{state.error}</span>}
        {(state.step === "idle" || state.step === "checking" || state.step === "installing") && "Mises à jour signées, publiées avec les releases."}
      </span>
      {state.step === "available" || state.step === "installing" ? (
        <Button size="sm" variant="primary" loading={state.step === "installing"} onClick={() => void install()}>
          Installer et redémarrer
        </Button>
      ) : (
        <Button size="sm" loading={state.step === "checking"} onClick={() => void run()}>
          Vérifier les mises à jour
        </Button>
      )}
    </div>
  );
}

const TEST_RESULT: Record<string, string> = {
  "Approve(1)": "« Approuver » reçu : l'agent aurait reçu l'option 1.",
  Deny: "« Refuser » reçu : l'agent aurait été refusé.",
  Open: "Clic reçu : la conversation se serait ouverte.",
  Nothing: "Notification fermée sans action.",
};

function NotificationTest() {
  const [result, setResult] = useState<string | null>(null);
  useEffect(() => {
    const un = listen<string>("notification-test", (e) => setResult(TEST_RESULT[e.payload] ?? e.payload));
    return () => void un.then((u) => u());
  }, []);
  return (
    <div className="flex items-center justify-between gap-4 py-3 text-[13px]">
      <span className="text-muted">{result ?? "Affiche une notification d'approbation factice avec ses boutons."}</span>
      <Button
        size="sm"
        onClick={() => {
          setResult("Notification envoyée : clique sur « Approuver » ou « Refuser ».");
          void app.testNotification();
        }}
      >
        Tester
      </Button>
    </div>
  );
}

export function SettingsPage() {
  const { settings, update } = useSettings();
  const [version, setVersion] = useState("");
  useEffect(() => {
    void getVersion().then(setVersion);
  }, []);
  return (
    <div className="flex h-full flex-col">
      <PageHeader title="Paramètres" />
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-6">
        <div className="mx-auto max-w-[640px]">
          <Section title="Général">
            <Toggle checked={settings.keep_in_tray} onChange={(v) => void update({ keep_in_tray: v })} label="Garder dans la barre des menus" description="Fermer la fenêtre laisse Huntaway actif pour recevoir les notifications." />
            <Toggle checked={settings.enter_to_send} onChange={(v) => void update({ enter_to_send: v })} label="Envoyer avec Entrée" description={settings.enter_to_send ? "Maj + Entrée pour aller à la ligne." : "⌘ + Entrée pour envoyer."} />
            <Toggle checked={settings.show_cost} onChange={(v) => void update({ show_cost: v })} label="Afficher le coût estimé" description="Calculé aux prix publics de l'API : un abonnement est facturé autrement." />
          </Section>
          <Section title="Notifications">
            <Toggle checked={settings.notify_blocked} onChange={(v) => void update({ notify_blocked: v })} label="Un agent a besoin de moi" description="Approbation, question, plan à valider." />
            <Toggle checked={settings.notify_done} onChange={(v) => void update({ notify_done: v })} label="Un agent a terminé" />
            <Toggle checked={settings.notify_error} onChange={(v) => void update({ notify_error: v })} label="Un agent s'est arrêté" />
            <Toggle checked={settings.notification_sound} onChange={(v) => void update({ notification_sound: v })} label="Son" />
            <NotificationTest />
          </Section>
          <Section title="Raccourcis">
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
          <Section title="À propos">
            <div className="flex items-center gap-3 py-4">
              <Logo size={40} />
              <div>
                <div className="text-[14px] font-semibold">Huntaway Desktop</div>
                <div className="text-[12px] text-muted">Version {version} · pilote tes agents Herdr, en local comme sur tes serveurs.</div>
              </div>
            </div>
            <Updates />
          </Section>
        </div>
      </div>
    </div>
  );
}
