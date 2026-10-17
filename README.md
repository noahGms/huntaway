<p align="center"><img src="desktop/src-tauri/icons/128x128.png" width="88" alt="Huntaway"></p>

<h1 align="center">Huntaway</h1>

<p align="center">Pilote tes agents de code <a href="https://herdr.dev">Herdr</a> (Claude Code, Codex) depuis ton téléphone ou ton ordinateur :<br>vois ce qu'ils font, réponds-leur, débloque-les, sache quand ils ont fini.</p>

---

## Comment ça marche

Tes agents tournent dans [Herdr](https://herdr.dev), sur ton ordinateur et sur tes serveurs. Sur chaque machine, un petit daemon, **`huntawayd`**, suit les sessions Herdr et lit les conversations des agents. Les apps Huntaway se connectent à ces daemons :

```
   📱 App mobile (Android)          💻 App desktop (macOS, Linux)
            │                                  │
            └──────────── Tailscale ───────────┤  (ou réseau local)
                                               │
        ┌──────────────────────┬───────────────┴──────┐
        ▼                      ▼                      ▼
   huntawayd              huntawayd              huntawayd
   ton Mac (local)        serveur de dev         serveur GPU…
        │                      │                      │
   sessions Herdr         sessions Herdr         sessions Herdr
   Claude Code, Codex…    Claude Code, Codex…    …
```

- **Une seule interface pour tout** : l'app regroupe les agents de toutes tes machines. Les agents qui attendent une réponse passent en premier.
- **La conversation, pas le terminal** : messages, plans, fichiers modifiés (diffs), commandes et résultats viennent des transcripts natifs des agents. Le terminal reste accessible en un clic.
- **Débloquer en un geste** : approuver ou refuser une commande, répondre à une question, valider un plan, interrompre un agent.
- **Notifications** quand un agent a besoin de toi, a terminé ou s'est arrêté.
- **Sécurisé par défaut** : le daemon n'écoute que sur Tailscale et `127.0.0.1`. Chaque appareil est appairé avec son propre token, et l'identité de la machine est vérifiée par signature à l'appairage.

## 1. Installer le daemon sur une machine

À faire sur **chaque machine** qui fait tourner des agents : ton ordinateur et tes serveurs.

**Prérequis**

1. [Herdr](https://herdr.dev) 0.9 ou plus, avec les intégrations des agents. Sans elles, Huntaway ne voit que l'état des agents, pas leur conversation :
   ```sh
   herdr integration install claude
   herdr integration install codex
   ```
   Redémarre ensuite les agents déjà lancés. Pour Codex, approuve une fois le hook Herdr au premier lancement (« Hooks need review » → faire confiance).
2. [Tailscale](https://tailscale.com) sur la machine et sur tes appareils, pour accéder aux serveurs à distance. Sur un réseau local, voir `lan = true` plus bas.

**Installation (Linux x86_64 / arm64, macOS arm64)**

```sh
curl -fsSL https://github.com/noahGms/huntaway/releases/latest/download/install.sh | sh
```

Le script télécharge le binaire de la dernière release, vérifie sa somme SHA-256, l'installe dans `~/.local/bin`, puis le lance en service : systemd `--user` sur Linux (actif même déconnecté), launchd sur macOS. **La même commande met à jour un daemon déjà installé.**

Vérifier que tout va bien :

```sh
huntawayd status      # daemon, sessions Herdr, agents, avertissements
```

Options du script : `--pair` (affiche le QR code d'appairage à la fin), `--no-service` (binaire seul). Variables : `HUNTAWAY_BASE_URL` (autre source des binaires), `HUNTAWAY_BIN_DIR` (dossier d'installation).

**Configuration (facultative)** dans `~/.config/huntaway/config.toml` :

```toml
machine_name = "Serveur de dev"   # nom affiché dans les apps
port = 7420
lan = false                       # écouter aussi sur le réseau local
# listen = ["100.97.66.61:7420"]  # adresses explicites
```

## 2. Installer les apps

Tout est dans la [dernière release](https://github.com/noahGms/huntaway/releases/latest) :

| App | Fichier |
|---|---|
| Desktop macOS (Apple Silicon) | `huntaway-desktop-macos-arm64.dmg` |
| Desktop Linux (x86_64) | `huntaway-desktop-linux-x86_64.AppImage` ou `huntaway-desktop-linux-amd64.deb` |
| Mobile Android | `huntaway-android-arm64.apk` |

- **macOS** : l'app n'est pas signée par Apple. Au premier lancement, fais clic droit sur Huntaway → Ouvrir.
- **Linux** : `chmod +x huntaway-desktop-linux-x86_64.AppImage` puis lance-le, ou `sudo apt install ./huntaway-desktop-linux-amd64.deb`. Les tokens sont rangés dans le trousseau du bureau (GNOME Keyring, KWallet).
- **Android** : ouvre l'APK sur le téléphone pour l'installer.

L'app desktop se met à jour toute seule (Paramètres → Vérifier les mises à jour).

## 3. Ajouter tes machines

### Dans l'app desktop

- **Cet ordinateur** : rien à faire. Si `huntawayd` tourne sur la même machine, l'app s'y connecte toute seule. Le daemon écrit un token local (`~/.config/huntaway/local.token`), accepté uniquement depuis `127.0.0.1`.
- **Un serveur** : sur le serveur, lance

  ```sh
  huntawayd pair --full --link
  ```

  puis colle le lien `huntaway://pair/…` dans l'app (Serveurs → Ajouter une machine). Le lien est valable 5 minutes et ne sert qu'une fois. L'app vérifie l'identité du serveur avant d'enregistrer le token.

### Dans l'app mobile

Sur la machine, lance `huntawayd pair` : un QR code s'affiche. Dans l'app, choisis « Ajouter une machine » et scanne-le.

### Permissions

| Commande | L'appareil peut… |
|---|---|
| `huntawayd pair` | lire (conversations, historique, fichiers, terminal), envoyer des messages, approuver, interrompre |
| `huntawayd pair --full` | tout, y compris créer et reprendre des agents et taper directement dans le terminal |
| `huntawayd pair --read-only` | seulement regarder |

Gérer les appareils appairés :

```sh
huntawayd devices list
huntawayd devices revoke <id>
```

## Utiliser l'app desktop

```
┌────────────┬──────────────────────────────────┬────────────────┐
│ Sidebar    │ Conversation                     │ Activité       │
│ ● en       │  Vous : …                        │  Session       │
│   attente  │  Claude : …                      │  Tâches        │
│ Aujourd'hui│   ✓ Plan  · diff  · $ npm test   │  Commandes     │
│ Hier       │ ┌ Approbation requise ─────────┐ │  Usage         │
│            │ │ [1 Oui] [2 Toujours] [Refuser]│ │────────────────│
│ Serveurs   │ └──────────────────────────────┘ │ Fichiers · Git │
│ ● Mac      │  Écrire un message… @ /          │ Terminal       │
└────────────┴──────────────────────────────────┴────────────────┘
```

- **Sidebar** : toutes les conversations de toutes les machines, groupées par date ou par projet. En haut, celles qui attendent une réponse. Les conversations passées (grisées) peuvent être reprises.
- **Conversation** : le fil de l'agent avec ses plans, ses diffs et ses commandes. Quand l'agent attend, une carte d'approbation apparaît (touches `1` à `9`, `Échap` pour refuser). Dans le champ de saisie : `@` pour citer un fichier du projet, `/` pour les commandes de l'agent, coller ou glisser une image pour la joindre.
- **Panneau Activité** : durée, modèle, tâches, outils utilisés, commandes récentes, tokens, remplissage du contexte, coût estimé et limites du forfait (Codex). L'onglet **Fichiers** montre les fichiers modifiés et le `git status`. L'onglet **Terminal** montre l'écran du pane Herdr en direct.
- **Nouvelle session** (`⌘N`) : choisis la machine, le projet (ou un nouveau dossier), l'agent, le modèle et la consigne.
- **Historique** : toutes les conversations passées de toutes les machines, avec recherche, et « Reprendre » pour les relancer dans Herdr.
- **Notifications** : sur macOS, elles proposent « Approuver » / « Refuser » directement, et un clic ouvre la conversation. Tant que la fenêtre est au premier plan, ton téléphone ne reçoit pas de push.
- **Barre des menus** : nombre d'agents en attente. Fermer la fenêtre laisse l'app active (réglable).

Raccourcis : `⌘K` recherche et actions, `⌘N` nouvelle session, `⌘.` interrompre l'agent, `⌘⇧A` prochain agent en attente, `⌥↑/↓` conversation précédente ou suivante, `⌘B` / `⌘⌥B` barre latérale / panneau.

## Notifications mobiles quand l'app est fermée

Elles passent par UnifiedPush : installe [ntfy](https://ntfy.sh) sur le téléphone, puis dans Huntaway → Réglages → « Notifications app fermée », choisis ntfy. Les messages ne contiennent que le titre et une ligne de résumé.

## Développement

```
bridge/    daemon huntawayd (Rust) + crates herdr-client, huntaway-api, huntaway-client, huntaway-core
app/       app mobile (Flutter)
desktop/   app desktop (Tauri 2 + React + Tailwind)
```

```sh
# Daemon
cd bridge && cargo test
scripts/install-huntawayd.sh            # compile, installe et lance le daemon local

# App desktop
cd desktop && npm install
npm run tauri dev                       # mode développement
npm run bindings                        # régénère les types TypeScript depuis les types Rust
npm test && npm run typecheck
npm run tauri build                     # bundles dans src-tauri/target/release/bundle/

# App mobile
cd app && flutter run
```

**Publier une release** : `git tag v0.1.0 && git push --tags`. La CI construit le daemon (macOS arm64, Linux x86_64/arm64), l'APK, l'app desktop (macOS, Linux), `install.sh`, `latest.json` et `SHA256SUMS`. Les mises à jour du desktop sont signées avec le secret `TAURI_SIGNING_PRIVATE_KEY`. Localement, `scripts/release.sh` remplit `dist/` avec les binaires du daemon.
