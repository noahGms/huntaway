//! Project scripts and shells run in Herdr tabs (`/v1/scripts`, `/v1/shells`).
//!
//! Each script gets its own tab, labeled `▶ <name>`, in the project's
//! workspace (created when the project has none), so it keeps running
//! without the app and shows in Herdr. The daemon only ever touches panes it
//! created: they are recorded in `processes.json` (state dir) with their
//! terminal id, checked before every action, so a pane id reused after a
//! Herdr restart is never mistaken for one of ours.
//!
//! Status heuristic: Herdr has no exit event for a command typed in a shell,
//! so `pane.process_info` is polled. A script is `running` while the
//! terminal's foreground process group is not the shell's own, `exited` once
//! the shell is back at its prompt (seen twice in a row, and not during the
//! first seconds after a start, so a loop of shell builtins doesn't flicker),
//! and `stopped` when its pane is gone.

use std::collections::{BTreeSet, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use herdr_client::Client;
use huntaway_api::{ProjectScripts, ProjectShells, ScriptView, ShellView};
use serde::{Deserialize, Serialize};
use tracing::{debug, info, warn};

use crate::engine::{agent_id, ActionError, ActionResult, Engine};
use crate::scripts::{self, Defined, ScriptDef, ScriptStore};

const POLL_EVERY: Duration = Duration::from_millis(1500);
/// A script counts as running this long after a start, whatever the shell says.
const START_GRACE: Duration = Duration::from_secs(3);
/// Ctrl-C again after this long, give up waiting after `STOP_TIMEOUT`.
const SECOND_CTRL_C: Duration = Duration::from_secs(4);
const STOP_TIMEOUT: Duration = Duration::from_secs(10);
/// A new shell gets this long to draw its prompt: text typed before is lost
/// (shell init can flush the terminal input).
const SHELL_READY_MAX: Duration = Duration::from_secs(5);

/// Environment of the shells the daemon opens. Commands are typed into an
/// interactive shell, so an update prompt at startup would eat them: turn
/// off Oh My Zsh's.
const SHELL_ENV: &[(&str, &str)] = &[("HUNTAWAY", "1"), ("DISABLE_AUTO_UPDATE", "true")];

pub const SCRIPT_TAB_PREFIX: &str = "▶ ";
pub const SHELL_TAB_LABEL: &str = "❯ shell";

fn now_secs() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// A Herdr tab created by the daemon.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
struct Tab {
    session: String,
    workspace_id: String,
    tab_id: String,
    pane_id: String,
    terminal_id: Option<String>,
}

impl Tab {
    fn of(session: &str, created: herdr_client::CreatedTab, workspace_id: &str) -> Self {
        let workspace_id = if created.workspace_id.is_empty() { workspace_id.to_string() } else { created.workspace_id };
        Self { session: session.to_string(), workspace_id, tab_id: created.tab_id, pane_id: created.pane_id, terminal_id: created.terminal_id }
    }

    /// `<session>:<pane id>`, like an agent id.
    fn pane_ref(&self) -> String {
        agent_id(&self.session, &self.pane_id)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ScriptProc {
    path: String,
    name: String,
    tab: Tab,
    #[serde(skip, default = "Instant::now")]
    started: Instant,
    /// Last state read; a daemon restart assumes running until the first poll.
    #[serde(skip, default = "yes")]
    running: bool,
    #[serde(skip)]
    idle_seen: u8,
}

fn yes() -> bool {
    true
}

impl ScriptProc {
    fn status(&self) -> &'static str {
        if self.running || self.started.elapsed() < START_GRACE {
            "running"
        } else {
            "exited"
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ShellProc {
    path: String,
    tab: Tab,
    opened_at: u64,
    #[serde(skip)]
    busy: bool,
}

impl ShellProc {
    fn view(&self) -> ShellView {
        ShellView { pane: self.tab.pane_ref(), path: self.path.clone(), opened_at: self.opened_at, busy: self.busy }
    }
}

/// `processes.json`: the tabs the daemon created and still follows.
#[derive(Default, Serialize, Deserialize)]
struct Registry {
    #[serde(default)]
    scripts: Vec<ScriptProc>,
    #[serde(default)]
    shells: Vec<ShellProc>,
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum PaneState {
    /// Closed, or another pane now has its id.
    Gone,
    Idle,
    Running,
    /// Herdr could not be asked (session down, timeout): keep what we knew.
    Unknown,
}

pub struct Runner {
    engine: Arc<Engine>,
    store: ScriptStore,
    file: PathBuf,
    registry: Mutex<Registry>,
    /// Scripts and projects with an action in progress: a double click must
    /// not start a script twice.
    inflight: Mutex<HashSet<String>>,
}

/// Releases an in-flight key when the action ends.
struct InFlight<'a> {
    set: &'a Mutex<HashSet<String>>,
    key: String,
}

impl Drop for InFlight<'_> {
    fn drop(&mut self) {
        self.set.lock().unwrap().remove(&self.key);
    }
}

/// Canonical form of a project directory given by a client.
pub fn canonical(path: &str) -> ActionResult<String> {
    let p = Path::new(path);
    if !p.is_absolute() {
        return Err(ActionError::new(400, "invalid_path", "absolute project path expected"));
    }
    let c = std::fs::canonicalize(p).map_err(|_| ActionError::new(404, "not_found", format!("directory not found: {path}")))?;
    if !c.is_dir() {
        return Err(ActionError::new(400, "invalid_path", format!("not a directory: {path}")));
    }
    Ok(c.to_string_lossy().into_owned())
}

/// Single-quotes `s` for a POSIX shell.
fn quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

fn script_not_found(name: &str) -> ActionError {
    ActionError::new(404, "script_not_found", format!("no script named `{name}` in this project"))
}

impl Runner {
    pub fn new(engine: Arc<Engine>, dir: &Path) -> Arc<Self> {
        let file = dir.join("processes.json");
        let registry = std::fs::read_to_string(&file).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();
        Arc::new(Self { engine, store: ScriptStore::open(dir), file, registry: Mutex::new(registry), inflight: Mutex::default() })
    }

    pub fn start(self: &Arc<Self>) {
        let runner = self.clone();
        tokio::spawn(async move { runner.poll_loop().await });
    }

    fn save_registry(&self, registry: &Registry) {
        let write = || -> anyhow::Result<()> {
            let tmp = self.file.with_extension("tmp");
            std::fs::write(&tmp, serde_json::to_string_pretty(registry)?)?;
            std::fs::rename(&tmp, &self.file)?;
            Ok(())
        };
        if let Err(e) = write() {
            warn!(error = %e, "cannot save processes.json");
        }
    }

    fn begin(&self, key: String) -> ActionResult<InFlight<'_>> {
        if !self.inflight.lock().unwrap().insert(key.clone()) {
            return Err(ActionError::new(409, "busy", "another action on it is in progress"));
        }
        Ok(InFlight { set: &self.inflight, key })
    }

    // ------------------------------------------------------------ reads

    /// File and app scripts of a project, and the file's error if any.
    fn defined(&self, path: &str) -> (Vec<Defined>, Option<String>) {
        let (file, error) = match scripts::read_project_file(Path::new(path)) {
            Ok(file) => (file, None),
            Err(e) => (Default::default(), Some(e)),
        };
        (scripts::merge(&file, &self.store.get(path)), error)
    }

    fn views(&self, path: &str, defined: &[Defined]) -> Vec<ScriptView> {
        let registry = self.registry.lock().unwrap();
        let running = |name: &str| registry.scripts.iter().find(|p| p.path == path && p.name == name);
        let mut views: Vec<ScriptView> = defined
            .iter()
            .map(|d| {
                let proc = running(&d.name);
                ScriptView {
                    name: d.name.clone(),
                    cmd: d.def.cmd.clone(),
                    cwd: d.def.cwd.clone(),
                    source: d.source.to_string(),
                    status: proc.map_or("stopped", |p| p.status()).to_string(),
                    pane: proc.map(|p| p.tab.pane_ref()),
                }
            })
            .collect();
        // Still running but no longer defined (file edited, script deleted): listed so it can be stopped.
        for p in registry.scripts.iter().filter(|p| p.path == path && !defined.iter().any(|d| d.name == p.name)) {
            views.push(ScriptView {
                name: p.name.clone(),
                cmd: String::new(),
                cwd: None,
                source: "removed".into(),
                status: p.status().to_string(),
                pane: Some(p.tab.pane_ref()),
            });
        }
        views
    }

    /// `GET /v1/scripts?path=`.
    pub fn scripts(&self, path: &str) -> ActionResult<ProjectScripts> {
        let path = canonical(path)?;
        let (defined, file_error) = self.defined(&path);
        let suggestions = scripts::suggestions(Path::new(&path), &defined);
        Ok(ProjectScripts { scripts: self.views(&path, &defined), path, suggestions, file_error })
    }

    fn emit_scripts(&self, path: &str) {
        let (defined, file_error) = self.defined(path);
        let data = ProjectScripts { path: path.to_string(), scripts: self.views(path, &defined), suggestions: Vec::new(), file_error };
        self.engine.emit("scripts.updated", None, serde_json::to_value(data).unwrap());
    }

    fn shell_views(&self, path: &str) -> Vec<ShellView> {
        self.registry.lock().unwrap().shells.iter().filter(|s| s.path == path).map(ShellProc::view).collect()
    }

    /// `GET /v1/shells?path=`.
    pub fn shells(&self, path: &str) -> ActionResult<ProjectShells> {
        let path = canonical(path)?;
        Ok(ProjectShells { shells: self.shell_views(&path), path })
    }

    fn emit_shells(&self, path: &str) {
        let data = ProjectShells { path: path.to_string(), shells: self.shell_views(path) };
        self.engine.emit("shells.updated", None, serde_json::to_value(data).unwrap());
    }

    // ---------------------------------------------------------- editing

    /// Adds or replaces an app script (`rename_from`: its previous name).
    pub fn save(&self, path: &str, name: &str, cmd: &str, cwd: Option<&str>, rename_from: Option<&str>) -> ActionResult<ProjectScripts> {
        let path = canonical(path)?;
        let name = name.trim();
        scripts::check_name(name).map_err(|e| ActionError::new(400, "invalid_name", e))?;
        if cmd.trim().is_empty() {
            return Err(ActionError::new(400, "empty_command", "empty command"));
        }
        let cwd = cwd.map(str::trim).filter(|c| !c.is_empty() && *c != ".").map(str::to_string);
        let def = ScriptDef { cmd: cmd.trim().to_string(), cwd };
        self.store.save(&path, name, def, rename_from).map_err(|e| ActionError::new(500, "internal", e.to_string()))?;
        self.emit_scripts(&path);
        self.scripts(&path)
    }

    /// Removes an app script (scripts of `.huntaway.toml` are edited in the file).
    pub fn delete(&self, path: &str, name: &str) -> ActionResult<()> {
        let path = canonical(path)?;
        if !self.store.delete(&path, name).map_err(|e| ActionError::new(500, "internal", e.to_string()))? {
            return Err(script_not_found(name));
        }
        self.emit_scripts(&path);
        Ok(())
    }

    // ------------------------------------------------------------ running

    fn script_tab(&self, path: &str, name: &str) -> Option<Tab> {
        self.registry.lock().unwrap().scripts.iter().find(|p| p.path == path && p.name == name).map(|p| p.tab.clone())
    }

    fn just_started(&self, path: &str, name: &str) -> bool {
        let registry = self.registry.lock().unwrap();
        registry.scripts.iter().any(|p| p.path == path && p.name == name && p.started.elapsed() < START_GRACE)
    }

    fn forget_script(&self, path: &str, name: &str) {
        let mut registry = self.registry.lock().unwrap();
        registry.scripts.retain(|p| !(p.path == path && p.name == name));
        self.save_registry(&registry);
    }

    /// Directory a script runs in.
    fn script_dir(path: &str, def: &ScriptDef) -> ActionResult<String> {
        let dir = match &def.cwd {
            Some(cwd) => Path::new(path).join(cwd),
            None => return Ok(path.to_string()),
        };
        if !dir.is_dir() {
            return Err(ActionError::new(400, "invalid_cwd", format!("directory not found: {}", dir.display())));
        }
        Ok(dir.to_string_lossy().into_owned())
    }

    /// Checks one of our panes: still there with the same terminal, and
    /// whether a command runs in it.
    async fn pane_state(&self, tab: &Tab) -> PaneState {
        let Ok(client) = self.engine.session_client(&tab.session) else { return PaneState::Unknown };
        match client.pane_list(Some(&tab.workspace_id)).await {
            Ok(panes) => match panes.iter().find(|p| p.pane_id == tab.pane_id) {
                Some(p) if p.terminal_id == tab.terminal_id => {}
                _ => return PaneState::Gone,
            },
            // The workspace was closed.
            Err(e) if e.code().is_some_and(|c| c.ends_with("not_found")) => return PaneState::Gone,
            Err(_) => return PaneState::Unknown,
        }
        match client.pane_process_info(&tab.pane_id).await {
            Ok(info) if info.command_running() => PaneState::Running,
            Ok(_) => PaneState::Idle,
            Err(e) if e.code().is_some_and(|c| c.ends_with("not_found")) => PaneState::Gone,
            Err(_) => PaneState::Unknown,
        }
    }

    /// A new tab in `dir` in the project's workspace: one already used by
    /// the daemon or an agent for this directory, else one of a pane working
    /// in it, else a new workspace (whose first tab is used). Returns false
    /// with a tab opened at the project root instead of `dir`.
    async fn project_tab(&self, path: &str, label: &str, dir: &str) -> ActionResult<(Client, Tab, bool)> {
        let mut candidates: Vec<(String, String)> = {
            let registry = self.registry.lock().unwrap();
            let scripts = registry.scripts.iter().filter(|p| p.path == path).map(|p| &p.tab);
            let shells = registry.shells.iter().filter(|s| s.path == path).map(|s| &s.tab);
            scripts.chain(shells).map(|t| (t.session.clone(), t.workspace_id.clone())).collect()
        };
        candidates.extend(self.engine.agent_workspace(path));
        let sessions = self.engine.session_names();
        for session in &sessions {
            let Ok(client) = self.engine.session_client(session) else { continue };
            if let Ok(panes) = client.pane_list(None).await {
                candidates.extend(panes.into_iter().filter(|p| p.cwd.as_deref() == Some(path)).map(|p| (session.clone(), p.workspace_id)));
            }
        }
        let mut tried = BTreeSet::new();
        for (session, workspace) in candidates {
            if !tried.insert((session.clone(), workspace.clone())) {
                continue;
            }
            let Ok(client) = self.engine.session_client(&session) else { continue };
            match client.tab_create_full(&workspace, Some(label), Some(dir), SHELL_ENV).await {
                Ok(created) => return Ok((client, Tab::of(&session, created, &workspace), true)),
                Err(e) => debug!(%session, %workspace, error = %e, "cannot open a tab in this workspace"),
            }
        }
        let session = sessions.first().ok_or_else(|| ActionError::new(404, "not_found", "no running Herdr session"))?;
        let client = self.engine.session_client(session)?;
        let name = path.rsplit('/').find(|s| !s.is_empty()).unwrap_or(path);
        let created = client.workspace_create_full(path, Some(name), SHELL_ENV).await?;
        info!(%session, workspace = %created.workspace_id, %path, "workspace created for the project");
        let tab = Tab::of(session, created, "");
        if let Err(e) = client.tab_rename(&tab.tab_id, label).await {
            debug!(error = %e, "cannot rename the first tab");
        }
        Ok((client, tab, dir == path))
    }

    /// Waits for a new shell to draw its prompt.
    async fn wait_ready(client: &Client, tab: &Tab) {
        let started = Instant::now();
        while started.elapsed() < SHELL_READY_MAX {
            match client.pane_read(&tab.pane_id, herdr_client::ReadSource::Visible, None, false).await {
                Ok(text) if !text.trim().is_empty() => break,
                _ => tokio::time::sleep(Duration::from_millis(100)).await,
            }
        }
        // The prompt is drawn just before the line editor reads.
        tokio::time::sleep(Duration::from_millis(150)).await;
    }

    /// Types `cmd` (after a `cd` when given) into one of our panes.
    async fn type_command(client: &Client, tab: &Tab, cmd: &str, cd: Option<&str>) -> ActionResult<()> {
        let line = match cd {
            Some(dir) => format!("cd {} && {}", quote(dir), cmd.trim()),
            None => cmd.trim().to_string(),
        };
        client.pane_send_text(&tab.pane_id, &line).await?;
        client.pane_send_keys(&tab.pane_id, &["enter"]).await?;
        Ok(())
    }

    /// Runs a script: again in its tab when it is at the prompt, else in a new tab.
    async fn run_script(&self, path: &str, script: &Defined) -> ActionResult<ScriptView> {
        let dir = Self::script_dir(path, &script.def)?;
        let mut reused = None;
        if let Some(tab) = self.script_tab(path, &script.name) {
            match self.pane_state(&tab).await {
                // Just typed: the shell may not have started it yet.
                PaneState::Idle if self.just_started(path, &script.name) => {
                    return Err(ActionError::new(409, "already_running", "the script is starting"))
                }
                PaneState::Idle => reused = Some(tab),
                PaneState::Running => return Err(ActionError::new(409, "already_running", "the script is already running")),
                PaneState::Gone | PaneState::Unknown => self.forget_script(path, &script.name),
            }
        }
        let tab = match reused {
            Some(tab) => {
                let client = self.engine.session_client(&tab.session)?;
                // The shell may have moved since: go back to the script's directory.
                Self::type_command(&client, &tab, &script.def.cmd, Some(&dir)).await?;
                tab
            }
            None => {
                let label = format!("{SCRIPT_TAB_PREFIX}{}", script.name);
                let (client, tab, in_dir) = self.project_tab(path, &label, &dir).await?;
                Self::wait_ready(&client, &tab).await;
                let cd = (!in_dir).then_some(dir.as_str());
                Self::type_command(&client, &tab, &script.def.cmd, cd).await?;
                tab
            }
        };
        info!(%path, script = %script.name, pane = %tab.pane_ref(), "script started");
        {
            let mut registry = self.registry.lock().unwrap();
            registry.scripts.retain(|p| !(p.path == path && p.name == script.name));
            registry.scripts.push(ScriptProc {
                path: path.to_string(),
                name: script.name.clone(),
                tab,
                started: Instant::now(),
                running: true,
                idle_seen: 0,
            });
            self.save_registry(&registry);
        }
        self.emit_scripts(path);
        let views = self.views(path, std::slice::from_ref(script));
        Ok(views.into_iter().find(|v| v.name == script.name).expect("script view"))
    }

    fn find_script(&self, path: &str, name: &str) -> ActionResult<Defined> {
        self.defined(path).0.into_iter().find(|d| d.name == name).ok_or_else(|| script_not_found(name))
    }

    /// `POST /v1/scripts/start`.
    pub async fn start_script(&self, path: &str, name: &str) -> ActionResult<ScriptView> {
        let path = canonical(path)?;
        let _busy = self.begin(format!("{path}\n{name}"))?;
        let script = self.find_script(&path, name)?;
        self.run_script(&path, &script).await
    }

    /// Ctrl-C, twice if needed, until the shell is back at its prompt.
    /// Returns whether the command ended.
    async fn interrupt(&self, client: &Client, tab: &Tab) -> ActionResult<bool> {
        client.pane_send_keys(&tab.pane_id, &["ctrl+c"]).await?;
        let started = Instant::now();
        let mut again = false;
        loop {
            tokio::time::sleep(Duration::from_millis(300)).await;
            match self.pane_state(tab).await {
                PaneState::Idle | PaneState::Gone => return Ok(true),
                _ if started.elapsed() >= STOP_TIMEOUT => return Ok(false),
                _ if !again && started.elapsed() >= SECOND_CTRL_C => {
                    again = true;
                    client.pane_send_keys(&tab.pane_id, &["ctrl+c"]).await?;
                }
                _ => {}
            }
        }
    }

    /// Stops what runs in one of our panes and closes it.
    async fn close_tab(&self, tab: &Tab) -> ActionResult<()> {
        let state = self.pane_state(tab).await;
        if state == PaneState::Gone {
            return Ok(());
        }
        let client = self.engine.session_client(&tab.session)?;
        if state == PaneState::Running && !self.interrupt(&client, tab).await? {
            warn!(pane = %tab.pane_ref(), "still running after Ctrl-C: closing its pane");
        }
        match client.pane_close(&tab.pane_id).await {
            Ok(_) => Ok(()),
            Err(e) if e.code().is_some_and(|c| c.ends_with("not_found")) => Ok(()),
            Err(e) => Err(e.into()),
        }
    }

    /// `POST /v1/scripts/stop`: Ctrl-C, then closes its tab. Stopping a
    /// stopped script is not an error.
    pub async fn stop_script(&self, path: &str, name: &str) -> ActionResult<()> {
        let path = canonical(path)?;
        let _busy = self.begin(format!("{path}\n{name}"))?;
        let Some(tab) = self.script_tab(&path, name) else { return Ok(()) };
        self.close_tab(&tab).await?;
        info!(%path, script = %name, "script stopped");
        self.forget_script(&path, name);
        self.emit_scripts(&path);
        Ok(())
    }

    /// `POST /v1/scripts/restart`: Ctrl-C and runs it again in the same tab
    /// (a new one if it won't stop).
    pub async fn restart_script(&self, path: &str, name: &str) -> ActionResult<ScriptView> {
        let path = canonical(path)?;
        let _busy = self.begin(format!("{path}\n{name}"))?;
        let script = self.find_script(&path, name)?;
        if let Some(tab) = self.script_tab(&path, name) {
            if self.pane_state(&tab).await == PaneState::Running {
                let client = self.engine.session_client(&tab.session)?;
                if !self.interrupt(&client, &tab).await? {
                    self.close_tab(&tab).await?;
                    self.forget_script(&path, name);
                }
            }
        }
        self.run_script(&path, &script).await
    }

    // ------------------------------------------------------------- shells

    /// `POST /v1/shells`: a new shell tab in the project.
    pub async fn open_shell(&self, path: &str) -> ActionResult<ShellView> {
        let path = canonical(path)?;
        let _busy = self.begin(format!("{path}\nshell"))?;
        let (_, tab, _) = self.project_tab(&path, SHELL_TAB_LABEL, &path).await?;
        info!(%path, pane = %tab.pane_ref(), "shell opened");
        let shell = ShellProc { path: path.clone(), tab, opened_at: now_secs(), busy: false };
        let view = shell.view();
        {
            let mut registry = self.registry.lock().unwrap();
            registry.shells.push(shell);
            self.save_registry(&registry);
        }
        self.emit_shells(&path);
        Ok(view)
    }

    /// `POST /v1/shells/close`: only shells opened by the daemon.
    pub async fn close_shell(&self, pane: &str) -> ActionResult<()> {
        let shell = self.registry.lock().unwrap().shells.iter().find(|s| s.tab.pane_ref() == pane).cloned();
        let shell = shell.ok_or_else(|| ActionError::new(404, "not_found", "no such shell"))?;
        let _busy = self.begin(pane.to_string())?;
        self.close_tab(&shell.tab).await?;
        {
            let mut registry = self.registry.lock().unwrap();
            registry.shells.retain(|s| s.tab.pane_ref() != pane);
            self.save_registry(&registry);
        }
        self.emit_shells(&shell.path);
        Ok(())
    }

    // ------------------------------------------------------------- polling

    async fn poll_loop(self: Arc<Self>) {
        loop {
            tokio::time::sleep(POLL_EVERY).await;
            self.poll().await;
        }
    }

    /// Reads the state of every followed pane, forgets closed ones and
    /// sends `scripts.updated` / `shells.updated` for projects that changed.
    async fn poll(&self) {
        let tabs: Vec<Tab> = {
            let registry = self.registry.lock().unwrap();
            registry.scripts.iter().map(|p| p.tab.clone()).chain(registry.shells.iter().map(|s| s.tab.clone())).collect()
        };
        if tabs.is_empty() {
            return;
        }
        let mut states = Vec::with_capacity(tabs.len());
        for tab in tabs {
            let state = self.pane_state(&tab).await;
            states.push((tab, state));
        }
        let state_of = |tab: &Tab| states.iter().find(|(t, _)| t == tab).map_or(PaneState::Unknown, |(_, s)| *s);
        let mut script_paths = BTreeSet::new();
        let mut shell_paths = BTreeSet::new();
        {
            let mut registry = self.registry.lock().unwrap();
            let before = registry.scripts.len() + registry.shells.len();
            registry.scripts.retain_mut(|p| {
                let status = p.status();
                match state_of(&p.tab) {
                    PaneState::Gone => {
                        script_paths.insert(p.path.clone());
                        return false;
                    }
                    PaneState::Running => {
                        p.running = true;
                        p.idle_seen = 0;
                    }
                    PaneState::Idle => {
                        p.idle_seen = p.idle_seen.saturating_add(1);
                        if p.idle_seen >= 2 {
                            p.running = false;
                        }
                    }
                    PaneState::Unknown => {}
                }
                if p.status() != status {
                    script_paths.insert(p.path.clone());
                }
                true
            });
            registry.shells.retain_mut(|s| {
                let busy = match state_of(&s.tab) {
                    PaneState::Gone => {
                        shell_paths.insert(s.path.clone());
                        return false;
                    }
                    PaneState::Running => true,
                    PaneState::Idle => false,
                    PaneState::Unknown => s.busy,
                };
                if busy != s.busy {
                    s.busy = busy;
                    shell_paths.insert(s.path.clone());
                }
                true
            });
            if registry.scripts.len() + registry.shells.len() != before {
                self.save_registry(&registry);
            }
        }
        for path in script_paths {
            self.emit_scripts(&path);
        }
        for path in shell_paths {
            self.emit_shells(&path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quoting_survives_single_quotes() {
        assert_eq!(quote("/tmp/it's here"), r"'/tmp/it'\''s here'");
    }

    #[test]
    fn exited_only_after_the_grace_period() {
        let tab = Tab { session: "s".into(), workspace_id: "w1".into(), tab_id: "w1:t1".into(), pane_id: "w1:p1".into(), terminal_id: None };
        let mut p = ScriptProc { path: "/p".into(), name: "dev".into(), tab, started: Instant::now(), running: false, idle_seen: 2 };
        assert_eq!(p.status(), "running");
        p.started = Instant::now() - START_GRACE;
        assert_eq!(p.status(), "exited");
        assert_eq!(p.tab.pane_ref(), "s:w1:p1");
        let saved: ScriptProc = serde_json::from_str(&serde_json::to_string(&p).unwrap()).unwrap();
        assert!(saved.running, "a restarted daemon assumes running until it checks");
    }

    #[test]
    fn canonical_paths() {
        assert_eq!(canonical("relative").unwrap_err().code, "invalid_path");
        assert_eq!(canonical("/no/such/dir/huntaway").unwrap_err().status, 404);
        let dir = std::env::temp_dir();
        assert_eq!(canonical(dir.to_str().unwrap()).unwrap(), std::fs::canonicalize(&dir).unwrap().to_string_lossy());
    }
}
