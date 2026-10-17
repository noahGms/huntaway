<p align="center"><img src="desktop/src-tauri/icons/128x128.png" width="88" alt="Huntaway"></p>

<h1 align="center">Huntaway</h1>

<p align="center">Drive your <a href="https://herdr.dev">Herdr</a> coding agents (Claude Code, Codex) from your phone or your computer:<br>see what they are doing, answer them, unblock them, know when they are done.</p>

---

## How it works

Your agents run in [Herdr](https://herdr.dev), on your computer and on your servers. On each machine, a small daemon, **`huntawayd`**, follows the Herdr sessions and reads the agents' conversations. The Huntaway apps connect to these daemons:

```
   📱 Mobile app (Android)          💻 Desktop app (macOS, Linux)
            │                                  │
            └──────────── Tailscale ───────────┤  (or local network)
                                               │
        ┌──────────────────────┬───────────────┴──────┐
        ▼                      ▼                      ▼
   huntawayd              huntawayd              huntawayd
   your Mac (local)       dev server             GPU server…
        │                      │                      │
   Herdr sessions         Herdr sessions         Herdr sessions
   Claude Code, Codex…    Claude Code, Codex…    …
```

- **One place for everything**: the app gathers the agents of all your machines. Agents waiting for an answer come first.
- **The conversation, not the terminal**: messages, plans, edited files (diffs), commands and their output come from the agents' native transcripts. The terminal is still one click away.
- **Unblock in one gesture**: approve or deny a command, answer a question, accept a plan, interrupt an agent.
- **Notifications** when an agent needs you, is done, or has stopped.
- **Secure by default**: the daemon only listens on Tailscale and `127.0.0.1`. Each device is paired with its own token, and the machine's identity is verified by signature during pairing.

## 1. Install the daemon on a machine

Do this on **every machine** that runs agents: your computer and your servers.

**Requirements**

1. [Herdr](https://herdr.dev) 0.9 or later, with the agent integrations. Without them, Huntaway only sees the agents' state, not their conversation:
   ```sh
   herdr integration install claude
   herdr integration install codex
   ```
   Then restart the agents that are already running. For Codex, approve the Herdr hook once on first launch ("Hooks need review" → trust).
2. [Tailscale](https://tailscale.com) on the machine and on your devices, to reach your servers remotely. On a local network, see `lan = true` below.

**Install (Linux x86_64 / arm64, macOS arm64)**

```sh
curl -fsSL https://github.com/noahGms/huntaway/releases/latest/download/install.sh | sh
```

The script downloads the binary of the latest release, checks its SHA-256 sum, installs it in `~/.local/bin`, then runs it as a service: systemd `--user` on Linux (kept running after you log out), launchd on macOS. **The same command updates an installed daemon.**

Check that everything is fine:

```sh
huntawayd status      # daemon, Herdr sessions, agents, warnings
```

Script options: `--pair` (shows the pairing QR code at the end), `--no-service` (binary only). Environment variables: `HUNTAWAY_BASE_URL` (another source for the binaries), `HUNTAWAY_BIN_DIR` (install directory).

**Configuration (optional)** in `~/.config/huntaway/config.toml`:

```toml
machine_name = "Dev server"       # name shown in the apps
port = 7420
lan = false                       # also listen on the local network
# listen = ["100.97.66.61:7420"]  # explicit addresses
```

## 2. Install the apps

Everything is in the [latest release](https://github.com/noahGms/huntaway/releases/latest):

| App | File |
|---|---|
| Desktop macOS (Apple Silicon) | `huntaway-desktop-macos-arm64.dmg` |
| Desktop Linux (x86_64) | `huntaway-desktop-linux-x86_64.AppImage` or `huntaway-desktop-linux-amd64.deb` |
| Mobile Android | `huntaway-android-arm64.apk` |

- **macOS**: the app is not signed by Apple. On first launch, right-click Huntaway → Open.
- **Linux**: `chmod +x huntaway-desktop-linux-x86_64.AppImage` then run it, or `sudo apt install ./huntaway-desktop-linux-amd64.deb`. Tokens are stored in the desktop keyring (GNOME Keyring, KWallet).
- **Android**: open the APK on the phone to install it.

The desktop app updates itself (Settings → Check for updates).

## 3. Add your machines

### In the desktop app

- **This computer**: nothing to do. If `huntawayd` runs on the same machine, the app connects to it on its own. The daemon writes a local token (`~/.config/huntaway/local.token`), only accepted from `127.0.0.1`.
- **A server**: on the server, run

  ```sh
  huntawayd pair --full --link
  ```

  then paste the `huntaway://pair/…` link in the app (Servers → Add a machine). The link is valid for 5 minutes and can only be used once. The app verifies the server's identity before saving the token.

### In the mobile app

On the machine, run `huntawayd pair`: a QR code is shown. In the app, choose "Add a machine" and scan it.

### Permissions

| Command | The device can… |
|---|---|
| `huntawayd pair` | read (conversations, history, files, terminal), send messages, approve, interrupt |
| `huntawayd pair --full` | everything, including creating and resuming agents and typing directly in the terminal |
| `huntawayd pair --read-only` | only watch |

Manage paired devices:

```sh
huntawayd devices list
huntawayd devices revoke <id>
```

## Using the desktop app

```
┌────────────┬──────────────────────────────────┬────────────────┐
│ Sidebar    │ Conversation                     │ Activity       │
│ ● waiting  │  You: …                          │  Session       │
│            │  Claude: …                       │  Tasks         │
│ Today      │   ✓ Plan  · diff  · $ npm test   │  Commands      │
│ Yesterday  │ ┌ Approval required ───────────┐ │  Usage         │
│            │ │ [1 Yes] [2 Always] [Deny]    │ │────────────────│
│ Servers    │ └──────────────────────────────┘ │ Files · Git    │
│ ● Mac      │  Write a message… @ /            │ Terminal       │
└────────────┴──────────────────────────────────┴────────────────┘
```

- **Sidebar**: every conversation of every machine, grouped by date or by project. Those waiting for an answer are at the top. Past conversations (greyed out) can be resumed.
- **Conversation**: the agent's thread with its plans, diffs and commands. When the agent is waiting, an approval card shows up (keys `1` to `9`, `Esc` to deny). In the input: `@` to mention a project file, `/` for the agent's commands, paste or drop an image to attach it.
- **Activity panel**: duration, model, tasks, tools used, recent commands, tokens, context usage, estimated cost and plan limits (Codex). The **Files** tab shows the edited files and the `git status`. The **Terminal** tab shows the Herdr pane's screen live.
- **New session** (`⌘N`): pick the machine, the project (or a new folder), the agent, the model and the prompt.
- **History**: every past conversation of every machine, with search, and "Resume" to restart it in Herdr.
- **Notifications**: on macOS and Linux they offer "Approve" / "Deny" directly, and a click opens the conversation. While the window is in the foreground, your phone gets no push.
- **Menu bar**: number of waiting agents. Closing the window keeps the app running (configurable).

Shortcuts: `⌘K` search and actions, `⌘N` new session, `⌘.` interrupt the agent, `⌘⇧A` next waiting agent, `⌥↑/↓` previous or next conversation, `⌘B` / `⌘⌥B` sidebar / panel.

## Mobile notifications when the app is closed

They go through UnifiedPush: install [ntfy](https://ntfy.sh) on the phone, then in Huntaway → Settings → "Notifications when closed", choose ntfy. Messages only contain the title and a one-line summary.

## Development

```
bridge/    huntawayd daemon (Rust) + crates herdr-client, huntaway-api, huntaway-client, huntaway-core
app/       mobile app (Flutter)
desktop/   desktop app (Tauri 2 + React + Tailwind)
```

```sh
# Daemon
cd bridge && cargo test
scripts/install-huntawayd.sh            # builds, installs and starts the local daemon

# Desktop app
cd desktop && npm install
npm run tauri dev                       # development mode
npm run bindings                        # regenerates the TypeScript types from the Rust types
npm test && npm run typecheck
npm run tauri build                     # bundles in src-tauri/target/release/bundle/

# Mobile app
cd app && flutter run
```

**Publish a release**: `git tag v0.1.0 && git push --tags`. CI builds the daemon (macOS arm64, Linux x86_64/arm64), the APK, the desktop app (macOS, Linux), `install.sh`, `latest.json` and `SHA256SUMS`. Desktop updates are signed with the `TAURI_SIGNING_PRIVATE_KEY` secret. Locally, `scripts/release.sh` fills `dist/` with the daemon binaries.
