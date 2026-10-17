//! The bridge engine: follows every Herdr session of this machine, keeps a
//! normalized view of each agent, numbers events for reconnection and
//! executes actions (PRD §9).
//!
//! Herdr and the agent transcripts are the source of truth, so the engine
//! keeps everything in memory. Each daemon start gets a new `epoch`: a client
//! holding another epoch must reload the state instead of replaying events.

use std::collections::{BTreeMap, HashSet, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use herdr_client::{AgentInfo, Client, ReadSource, Session};
use huntaway_core::attention::{classify, Attention, BlockedReason};
use huntaway_core::claude;
use huntaway_core::codex;
use huntaway_core::transcript::TranscriptTail;
use huntaway_core::screen::{keys_for_choice, numbered_options, ScreenOption};
use huntaway_core::TimelineItem;
pub use huntaway_api::{AgentView, Envelope, Interaction, MachineInfo, Notification, PendingToolView, SessionView, StoredItem, WorkspaceView};
use serde_json::{json, Value};
use tokio::sync::{broadcast, mpsc};
use tracing::{debug, info, warn};

use crate::config::Config;

/// Herdr reports a transient `done` right before `blocked` when a permission
/// prompt appears; `done`/`idle` only count once stable for this long.
const SETTLE: Duration = Duration::from_millis(1500);
const TICK: Duration = Duration::from_millis(400);
const DISCOVERY_EVERY: Duration = Duration::from_secs(3);
const RECENT_ITEMS: usize = 80;
/// Give up on a `done` notification if the agent keeps working this long after a turn end.
const DONE_WAIT_MAX: Duration = Duration::from_secs(60);
/// Delay before notifying `blocked`, so the pending tool line is read first.
const BLOCKED_NOTIFY_DELAY: Duration = Duration::from_millis(800);
/// An agent that vanishes within this delay after being busy counts as crashed.
const CRASH_WINDOW: Duration = Duration::from_secs(5);
/// How often to ask Herdr for a Claude session id that is still missing.
const SESSION_LOOKUP_EVERY: Duration = Duration::from_secs(2);

fn is_busy(status: &str) -> bool {
    matches!(status, "working" | "blocked")
}

/// The agent left (or was replaced in its pane) while working or waiting:
/// crash, killed process… (PRD §11 Error). Herdr often reports one last
/// status change just before, hence the time window.
fn crashed(entry: &AgentEntry) -> bool {
    entry.view.kind != "shell"
        && (is_busy(&entry.status)
            || is_busy(&entry.raw_status)
            || entry.busy_at.is_some_and(|t| t.elapsed() < CRASH_WINDOW))
}

/// Records a status reported by Herdr (applied later by the debounce).
fn set_raw_status(entry: &mut AgentEntry, status: &str) {
    if entry.raw_status == status {
        return;
    }
    if is_busy(&entry.raw_status) {
        entry.busy_at = Some(Instant::now());
    }
    entry.raw_status = status.to_string();
    entry.raw_since = Instant::now();
}

// ----------------------------------------------------------------- API types

/// Herdr socket protocol this bridge was developed and tested against.
pub const TESTED_HERDR_PROTOCOL: u32 = 22;

fn session_warnings(protocol: u32) -> Vec<String> {
    if protocol == TESTED_HERDR_PROTOCOL {
        Vec::new()
    } else {
        vec!["herdr_protocol_untested".to_string()]
    }
}

#[derive(Debug)]
pub struct ActionError {
    pub status: u16,
    pub code: &'static str,
    pub message: String,
}

impl ActionError {
    pub fn new(status: u16, code: &'static str, message: impl Into<String>) -> Self {
        Self { status, code, message: message.into() }
    }
    fn not_found() -> Self {
        Self::new(404, "not_found", "agent introuvable")
    }
}

impl From<herdr_client::Error> for ActionError {
    fn from(e: herdr_client::Error) -> Self {
        match e.code() {
            Some("agent_blocked") => Self::new(409, "agent_blocked", "l'agent attend une réponse"),
            Some("not_found") => Self::not_found(),
            _ => Self::new(502, "herdr_error", e.to_string()),
        }
    }
}

pub type ActionResult<T> = Result<T, ActionError>;

/// `POST /v1/agents`.
pub struct CreateAgent<'a> {
    pub session: &'a str,
    pub workspace_id: &'a str,
    pub kind: &'a str,
    pub prompt: &'a str,
    pub model: Option<&'a str>,
    pub cwd: Option<&'a str>,
}

// -------------------------------------------------------------- engine state

struct AgentEntry {
    view: AgentView,
    client: Client,
    info: AgentInfo,
    tail: Option<TranscriptTail>,
    items: VecDeque<StoredItem>,
    next_n: u64,
    recent: VecDeque<TimelineItem>,
    /// Status reported by Herdr, not yet applied (debounce).
    raw_status: String,
    raw_since: Instant,
    /// Status in effect.
    status: String,
    screen_options: Vec<ScreenOption>,
    needs_screen: bool,
    interrupted_by_huntaway: bool,
    notified_blocked: bool,
    /// A turn ended at this instant; notify `done` once settled.
    pending_done: Option<Instant>,
    /// Last time the agent was seen working or blocked (crash detection).
    busy_at: Option<Instant>,
    /// Last time we asked Herdr for a missing native session id.
    session_lookup_at: Option<Instant>,
    /// Current blocking episode (metrics) and whether Huntaway answered it.
    blocked_since: Option<Instant>,
    answered_from_huntaway: bool,
    /// When the daemon first saw this agent (seconds since the epoch).
    seen_at_secs: u64,
    /// Latest request typed by the user (not a slash command), for the summary.
    last_request: Option<String>,
}

/// Usage metrics (PRD §22), in memory since the daemon started.
#[derive(Default)]
struct Metrics {
    /// (seconds blocked, resolved from Huntaway)
    episodes: Vec<(f64, bool)>,
    notifications: BTreeMap<String, u64>,
}

fn percentile(sorted: &[f64], p: f64) -> Option<f64> {
    if sorted.is_empty() {
        return None;
    }
    let idx = ((sorted.len() - 1) as f64 * p).round() as usize;
    Some((sorted[idx] * 10.0).round() / 10.0)
}

#[derive(Default)]
struct State {
    sessions: BTreeMap<String, SessionView>,
    agents: BTreeMap<String, AgentEntry>,
    /// Herdr workspaces (projects) per session, including those without agents.
    workspaces: BTreeMap<String, Vec<WorkspaceView>>,
}

pub struct Engine {
    pub machine: MachineInfo,
    config: Config,
    state: Mutex<State>,
    seq: AtomicU64,
    journal: Mutex<VecDeque<Envelope>>,
    tx: broadcast::Sender<Envelope>,
    notify_tx: mpsc::UnboundedSender<Notification>,
    running_sessions: Mutex<HashSet<String>>,
    metrics: Mutex<Metrics>,
    started: Instant,
}

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

pub fn agent_id(session: &str, pane: &str) -> String {
    format!("{session}:{pane}")
}

impl Engine {
    pub fn new(config: Config, machine_id: String) -> (Arc<Self>, mpsc::UnboundedReceiver<Notification>) {
        let (tx, _) = broadcast::channel(4096);
        let (notify_tx, notify_rx) = mpsc::unbounded_channel();
        let machine = MachineInfo {
            machine_id,
            machine_name: config.machine_name.clone(),
            bridge_version: env!("CARGO_PKG_VERSION").to_string(),
            epoch: format!("e{}", now_ms()),
            os: Some(format!("{} {}", std::env::consts::OS, std::env::consts::ARCH)),
            hostname: crate::config::hostname(),
            started_at: Some(now_ms() / 1000),
        };
        let engine = Arc::new(Self {
            machine,
            config,
            state: Mutex::new(State::default()),
            seq: AtomicU64::new(0),
            journal: Mutex::new(VecDeque::new()),
            tx,
            notify_tx,
            running_sessions: Mutex::new(HashSet::new()),
            metrics: Mutex::new(Metrics::default()),
            started: Instant::now(),
        });
        (engine, notify_rx)
    }

    /// Starts discovery and the periodic tick.
    pub fn start(self: &Arc<Self>) {
        let engine = self.clone();
        tokio::spawn(async move { engine.discovery_loop().await });
        let engine = self.clone();
        tokio::spawn(async move { engine.tick_loop().await });
    }

    // ------------------------------------------------------------- events

    fn emit(&self, kind: &str, agent_id: Option<&str>, data: Value) {
        let envelope = Envelope {
            seq: self.seq.fetch_add(1, Ordering::SeqCst) + 1,
            at: now_ms(),
            kind: kind.to_string(),
            agent_id: agent_id.map(str::to_string),
            data,
        };
        {
            let mut journal = self.journal.lock().unwrap();
            journal.push_back(envelope.clone());
            while journal.len() > self.config.journal_size {
                journal.pop_front();
            }
        }
        let _ = self.tx.send(envelope);
    }

    pub fn subscribe(&self) -> broadcast::Receiver<Envelope> {
        self.tx.subscribe()
    }

    pub fn current_seq(&self) -> u64 {
        self.seq.load(Ordering::SeqCst)
    }

    /// Events after `since`, or `None` when they are no longer in the journal.
    pub fn replay(&self, since: u64) -> Option<Vec<Envelope>> {
        let journal = self.journal.lock().unwrap();
        let oldest = journal.front().map_or(self.current_seq() + 1, |e| e.seq);
        if since + 1 < oldest {
            return None;
        }
        Some(journal.iter().filter(|e| e.seq > since).cloned().collect())
    }

    pub fn snapshot(&self) -> Value {
        // Read seq under the state lock so no event is both in the snapshot and replayed after it.
        let state = self.state.lock().unwrap();
        let mut agents: Vec<&AgentView> = state.agents.values().map(|a| &a.view).collect();
        agents.sort_by(|a, b| {
            a.attention
                .priority()
                .cmp(&b.attention.priority())
                .then_with(|| b.last_activity_at.cmp(&a.last_activity_at))
        });
        let workspaces: Vec<WorkspaceView> = state
            .workspaces
            .values()
            .flatten()
            .map(|w| {
                let cwd = state
                    .agents
                    .values()
                    .find(|a| a.view.session == w.session && a.view.workspace_id == w.workspace_id && a.view.cwd.is_some())
                    .and_then(|a| a.view.cwd.clone());
                WorkspaceView { cwd, ..w.clone() }
            })
            .collect();
        json!({
            "machine": self.machine,
            "seq": self.current_seq(),
            "sessions": state.sessions.values().collect::<Vec<_>>(),
            "workspaces": workspaces,
            "agents": agents,
        })
    }

    pub fn uptime_secs(&self) -> u64 {
        self.started.elapsed().as_secs()
    }

    pub fn sessions(&self) -> Vec<SessionView> {
        self.state.lock().unwrap().sessions.values().cloned().collect()
    }

    pub fn agent(&self, id: &str) -> Option<AgentView> {
        self.state.lock().unwrap().agents.get(id).map(|a| a.view.clone())
    }

    /// Items with `n < before` (newest first page when `before` is None), oldest first.
    pub fn timeline(&self, id: &str, before: Option<u64>, limit: usize) -> Option<Vec<StoredItem>> {
        let state = self.state.lock().unwrap();
        let entry = state.agents.get(id)?;
        let mut page: Vec<StoredItem> = entry
            .items
            .iter()
            .rev()
            .filter(|i| before.is_none_or(|b| i.n < b))
            .take(limit)
            .cloned()
            .collect();
        page.reverse();
        Some(page)
    }

    // ---------------------------------------------------------- discovery

    async fn discovery_loop(self: Arc<Self>) {
        loop {
            let live = herdr_client::discover_live_sessions().await;
            let mut changed = false;
            for (session, pong) in &live {
                let start = self.running_sessions.lock().unwrap().insert(session.name.clone());
                if start {
                    info!(session = %session.name, version = %pong.version, "session Herdr détectée");
                    if pong.protocol != TESTED_HERDR_PROTOCOL {
                        warn!(
                            session = %session.name,
                            protocol = pong.protocol,
                            tested = TESTED_HERDR_PROTOCOL,
                            "protocole Herdr non testé : certaines fonctions peuvent mal se comporter"
                        );
                    }
                    self.state.lock().unwrap().sessions.insert(
                        session.name.clone(),
                        SessionView {
                            name: session.name.clone(),
                            herdr_version: pong.version.clone(),
                            protocol: pong.protocol,
                            warnings: session_warnings(pong.protocol),
                        },
                    );
                    changed = true;
                    let engine = self.clone();
                    let session = session.clone();
                    tokio::spawn(async move { engine.session_worker(session).await });
                }
            }
            if changed {
                self.emit_sessions();
            }
            tokio::time::sleep(DISCOVERY_EVERY).await;
        }
    }

    fn emit_sessions(&self) {
        let sessions: Vec<SessionView> = self.state.lock().unwrap().sessions.values().cloned().collect();
        self.emit("sessions.updated", None, json!({ "sessions": sessions }));
    }

    async fn session_worker(self: Arc<Self>, session: Session) {
        let client = Client::new(&session.socket);
        let mut failures = 0;
        loop {
            match self.follow_session(&session, &client).await {
                Ok(()) => failures = 0,
                Err(e) => {
                    failures += 1;
                    debug!(session = %session.name, error = %e, "flux de session interrompu");
                    if client.ping().await.is_err() || failures > 5 {
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(500)).await;
                }
            }
        }
        info!(session = %session.name, "session Herdr perdue");
        let removed: Vec<String> = {
            let mut state = self.state.lock().unwrap();
            state.sessions.remove(&session.name);
            state.workspaces.remove(&session.name);
            let ids: Vec<String> = state.agents.values().filter(|a| a.view.session == session.name).map(|a| a.view.id.clone()).collect();
            for id in &ids {
                state.agents.remove(id);
            }
            ids
        };
        for id in removed {
            self.emit("agent.removed", Some(&id), json!({}));
        }
        self.emit_sessions();
        self.running_sessions.lock().unwrap().remove(&session.name);
    }

    /// One subscription cycle: sync agents, subscribe, consume events until a
    /// lifecycle change requires a fresh subscription.
    async fn follow_session(&self, session: &Session, client: &Client) -> herdr_client::Result<()> {
        let agents = client.agent_list().await?;
        let workspaces = client.workspace_list().await;
        let listed = workspaces.is_ok();
        let workspaces = workspaces.unwrap_or_default();
        let tabs = client.tab_list().await.unwrap_or_default();
        self.reconcile(session, client, agents.clone(), listed.then_some(workspaces.as_slice()), &tabs);

        let mut subs: Vec<Value> =
            agents.iter().map(|a| json!({ "type": "pane.agent_status_changed", "pane_id": a.pane_id })).collect();
        for kind in ["pane.agent_detected", "pane.created", "pane.closed", "pane.exited", "workspace.created", "workspace.closed", "workspace.renamed", "tab.renamed", "tab.moved"] {
            subs.push(json!({ "type": kind }));
        }
        // Subscribe, then re-read: a status change between the list and the
        // subscription would otherwise be missed.
        let mut sub = client.subscribe(subs).await?;
        let agents = client.agent_list().await?;
        self.reconcile(session, client, agents, listed.then_some(workspaces.as_slice()), &tabs);

        loop {
            let event = sub.next().await?;
            match event.kind.as_str() {
                "pane.agent_status_changed" => {
                    if let (Some(pane), Some(status)) = (event.pane_id(), event.agent_status()) {
                        self.on_status(&agent_id(&session.name, pane), status.as_str());
                    }
                }
                _ => return Ok(()),
            }
        }
    }

    /// `workspaces` is `None` when Herdr could not list them (keep the previous list).
    fn reconcile(&self, session: &Session, client: &Client, agents: Vec<AgentInfo>, listed: Option<&[herdr_client::WorkspaceInfo]>, tabs: &[herdr_client::TabInfo]) {
        let workspaces = listed.unwrap_or_default();
        let mut events: Vec<(String, &'static str, Value)> = Vec::new();
        let mut notifications = Vec::new();
        let mut workspaces_changed = false;
        {
            let mut state = self.state.lock().unwrap();
            if listed.is_some() {
                let views: Vec<WorkspaceView> = workspaces
                    .iter()
                    .map(|w| WorkspaceView { session: session.name.clone(), workspace_id: w.workspace_id.clone(), label: w.label.clone(), cwd: None })
                    .collect();
                if state.workspaces.get(&session.name) != Some(&views) {
                    state.workspaces.insert(session.name.clone(), views);
                    workspaces_changed = true;
                }
            }
            let live: HashSet<String> = agents.iter().map(|a| agent_id(&session.name, &a.pane_id)).collect();
            let stale: Vec<String> = state
                .agents
                .values()
                .filter(|a| a.view.session == session.name && !live.contains(&a.view.id))
                .map(|a| a.view.id.clone())
                .collect();
            for id in stale {
                if let Some(entry) = state.agents.remove(&id) {
                    if crashed(&entry) {
                        notifications.push(build_notification(&entry, "error"));
                    }
                }
                events.push((id, "agent.removed", json!({})));
            }

            for info in agents {
                let id = agent_id(&session.name, &info.pane_id);
                let label = workspaces.iter().find(|w| w.workspace_id == info.workspace_id).and_then(|w| w.label.clone());
                let tab_label = tabs.iter().find(|t| t.tab_id == info.tab_id).and_then(|t| t.label.clone());
                let instance = instance_key(&info);
                let replace = state.agents.get(&id).is_none_or(|e| {
                    // A session id reported after the agent appeared is the same occupant.
                    let late_session = e.info.agent_session.is_none()
                        && e.info.terminal_id == info.terminal_id
                        && e.info.agent == info.agent;
                    e.view.instance_id != instance && !late_session
                });
                if replace {
                    // After a crash Herdr keeps the pane, now a plain shell: new occupant.
                    if let Some(old) = state.agents.get(&id) {
                        if crashed(old) {
                            notifications.push(build_notification(old, "error"));
                        }
                    }
                    let mut entry = self.new_entry(session, client, &id, info, label, instance);
                    entry.view.tab_label = tab_label;
                    events.push((id.clone(), "agent.updated", serde_json::to_value(&entry.view).unwrap()));
                    state.agents.insert(id, entry);
                } else if let Some(entry) = state.agents.get_mut(&id) {
                    entry.view.workspace_label = label;
                    entry.view.tab_label = tab_label;
                    if entry.tail.is_none() && info.agent_session.is_some() {
                        attach_session(entry, &info);
                        let _ = self.poll_transcript(entry, false);
                    }
                    set_raw_status(entry, info.agent_status.as_str());
                    entry.info = info;
                }
            }
        }
        for n in notifications {
            info!(agent = %n.agent_id, "agent arrêté pendant son travail");
            self.emit("notification", Some(&n.agent_id), serde_json::to_value(&n).unwrap());
            let _ = self.notify_tx.send(n);
        }
        for (id, kind, data) in events {
            self.emit(kind, Some(&id), data);
        }
        if workspaces_changed {
            let workspaces = self.snapshot()["workspaces"].clone();
            self.emit("workspaces.updated", None, json!({ "workspaces": workspaces }));
        }
    }

    fn new_entry(&self, session: &Session, client: &Client, id: &str, info: AgentInfo, label: Option<String>, instance: String) -> AgentEntry {
        let kind = info.agent.clone().unwrap_or_else(|| "shell".into());
        let mut warnings = Vec::new();
        if has_adapter(&kind) && info.agent_session.is_none() {
            warnings.push("missing_herdr_integration".to_string());
        }
        let tail = locate_transcript(&info);
        let status = info.agent_status.as_str().to_string();
        let project = info
            .cwd
            .as_deref()
            .map(|c| c.rsplit('/').find(|s| !s.is_empty()).unwrap_or(c).to_string())
            .unwrap_or_default();
        let view = AgentView {
            id: id.to_string(),
            instance_id: instance,
            session: session.name.clone(),
            pane_id: info.pane_id.clone(),
            workspace_id: info.workspace_id.clone(),
            workspace_label: label,
            tab_label: None,
            project,
            cwd: info.cwd.clone(),
            kind,
            name: None,
            herdr_status: status.clone(),
            attention: Attention::Unknown,
            summary: title_summary(&info),
            title: None,
            started_at: None,
            last_activity_at: None,
            interaction: None,
            has_transcript: tail.is_some(),
            item_count: 0,
            model: None,
            usage: None,
            native_session: info.agent_session.as_ref().map(|s| s.value.clone()),
            warnings,
        };
        let mut entry = AgentEntry {
            view,
            client: client.clone(),
            info,
            tail,
            items: VecDeque::new(),
            next_n: 0,
            recent: VecDeque::new(),
            raw_status: status.clone(),
            raw_since: Instant::now() - SETTLE,
            status,
            screen_options: Vec::new(),
            needs_screen: true,
            interrupted_by_huntaway: false,
            // Don't notify for states that existed before the daemon saw the agent.
            notified_blocked: true,
            pending_done: None,
            busy_at: None,
            session_lookup_at: None,
            blocked_since: None,
            answered_from_huntaway: false,
            seen_at_secs: now_ms() / 1000,
            last_request: None,
        };
        // Load history without notifications.
        let _ = self.poll_transcript(&mut entry, false);
        entry.pending_done = None;
        recompute(&mut entry);
        entry.notified_blocked = matches!(entry.view.attention, Attention::Blocked(_));
        entry
    }

    fn on_status(&self, id: &str, status: &str) {
        let mut state = self.state.lock().unwrap();
        let Some(entry) = state.agents.get_mut(id) else { return };
        set_raw_status(entry, status);
    }

    /// Codex 0.161 + Herdr hook may never report the session id: find the
    /// rollout started in the agent's directory after it appeared.
    fn attach_codex_by_cwd(&self, id: &str, info: &AgentInfo) {
        if info.agent.as_deref() != Some("codex") {
            return;
        }
        let Some(cwd) = info.cwd.as_deref() else { return };
        let view = {
            let mut state = self.state.lock().unwrap();
            let taken: Vec<std::path::PathBuf> =
                state.agents.values().filter_map(|a| a.tail.as_ref().map(|t| t.path().to_path_buf())).collect();
            let Some(entry) = state.agents.get_mut(id) else { return };
            // A few seconds of slack: the session may start just before we notice the agent.
            let Some(path) = codex::transcript_by_cwd(cwd, entry.seen_at_secs.saturating_sub(30), &taken) else {
                return;
            };
            info!(agent = %id, path = %path.display(), "session Codex retrouvée par dossier (identifiant absent)");
            entry.tail = Some(TranscriptTail::codex(path));
            entry.view.warnings.retain(|w| w != "missing_herdr_integration");
            // The session started after the agent appeared: its lines are live.
            let _ = self.poll_transcript(entry, true);
            recompute(entry);
            entry.view.clone()
        };
        self.emit("agent.updated", Some(id), serde_json::to_value(view).unwrap());
    }

    // --------------------------------------------------------------- tick

    async fn tick_loop(self: Arc<Self>) {
        let mut interval = tokio::time::interval(TICK);
        loop {
            interval.tick().await;
            let (screens, lookups) = self.tick();
            for (id, client, pane) in lookups {
                let Ok(info) = client.agent_get(&pane).await else { continue };
                if info.agent_session.is_none() {
                    self.attach_codex_by_cwd(&id, &info);
                    continue;
                }
                let update = {
                    let mut state = self.state.lock().unwrap();
                    state.agents.get_mut(&id).and_then(|entry| {
                        attach_session(entry, &info);
                        // No transcript file yet (no message sent): keep looking.
                        entry.tail.as_ref()?;
                        // History written so far is loaded quietly; later lines are live.
                        let _ = self.poll_transcript(entry, false);
                        entry.pending_done = None;
                        recompute(entry);
                        Some(entry.view.clone())
                    })
                };
                if let Some(view) = update {
                    info!(agent = %id, "session native trouvée, transcript attaché");
                    self.emit("agent.updated", Some(&id), serde_json::to_value(view).unwrap());
                }
            }
            for (id, client, pane) in screens {
                let options = match client.agent_read(&pane, ReadSource::Visible, None).await {
                    Ok(text) => numbered_options(&text),
                    Err(_) => continue,
                };
                let update = {
                    let mut state = self.state.lock().unwrap();
                    state.agents.get_mut(&id).and_then(|entry| {
                        entry.screen_options = options;
                        let before = entry.view.clone();
                        recompute(entry);
                        (entry.view != before).then(|| entry.view.clone())
                    })
                };
                if let Some(view) = update {
                    self.emit("agent.updated", Some(&id), serde_json::to_value(view).unwrap());
                }
            }
        }
    }

    /// Applies settled statuses, reads new transcript lines, recomputes views
    /// and raises notifications. Returns the agents whose screen must be read.
    #[allow(clippy::type_complexity)]
    fn tick(&self) -> (Vec<(String, Client, String)>, Vec<(String, Client, String)>) {
        let mut emitted: Vec<(String, &'static str, Value)> = Vec::new();
        let mut notifications = Vec::new();
        let mut screens = Vec::new();
        let mut lookups = Vec::new();
        {
            let mut state = self.state.lock().unwrap();
            for (id, entry) in state.agents.iter_mut() {
                let before = entry.view.clone();

                // Debounced status: blocked/working apply at once, done/idle once stable.
                if entry.raw_status != entry.status {
                    let settles = matches!(entry.raw_status.as_str(), "done" | "idle");
                    if !settles || entry.raw_since.elapsed() >= SETTLE {
                        entry.status = entry.raw_status.clone();
                        if entry.status == "blocked" {
                            entry.needs_screen = true;
                        }
                    }
                }

                for item in self.poll_transcript(entry, true) {
                    emitted.push((id.clone(), "agent.item", serde_json::to_value(&item).unwrap()));
                }
                recompute(entry);

                // Notifications.
                let blocked = matches!(entry.view.attention, Attention::Blocked(_));
                match (blocked, entry.blocked_since) {
                    (true, None) => {
                        entry.blocked_since = Some(Instant::now());
                        entry.answered_from_huntaway = false;
                    }
                    (false, Some(since)) => {
                        entry.blocked_since = None;
                        let huntaway = std::mem::take(&mut entry.answered_from_huntaway);
                        self.metrics.lock().unwrap().episodes.push((since.elapsed().as_secs_f64(), huntaway));
                    }
                    _ => {}
                }
                // Let the transcript catch up so the notification names the real command.
                let blocked_settled = entry.status != "blocked" || entry.raw_since.elapsed() >= BLOCKED_NOTIFY_DELAY;
                if blocked && blocked_settled && !entry.notified_blocked {
                    entry.notified_blocked = true;
                    notifications.push(build_notification(entry, "blocked"));
                } else if !blocked {
                    entry.notified_blocked = false;
                }
                // The turn-end line often lands while Herdr still says `working`:
                // wait for the status to settle instead of dropping the notification.
                if let Some(at) = entry.pending_done {
                    if blocked || at.elapsed() > DONE_WAIT_MAX {
                        entry.pending_done = None;
                    } else if entry.status != "working" && entry.raw_status != "working" && at.elapsed() >= SETTLE {
                        entry.pending_done = None;
                        if !std::mem::take(&mut entry.interrupted_by_huntaway) {
                            notifications.push(build_notification(entry, "done"));
                        }
                    }
                }

                // Claude agents seen before their integration reported a session id.
                if entry.tail.is_none()
                    && has_adapter(&entry.view.kind)
                    && entry.session_lookup_at.is_none_or(|t| t.elapsed() >= SESSION_LOOKUP_EVERY)
                {
                    entry.session_lookup_at = Some(Instant::now());
                    lookups.push((id.clone(), entry.client.clone(), entry.view.pane_id.clone()));
                }
                if entry.status == "blocked" && entry.needs_screen {
                    entry.needs_screen = false;
                    screens.push((id.clone(), entry.client.clone(), entry.view.pane_id.clone()));
                }
                if entry.view != before {
                    emitted.push((id.clone(), "agent.updated", serde_json::to_value(&entry.view).unwrap()));
                }
            }
        }
        for (id, kind, data) in emitted {
            self.emit(kind, Some(&id), data);
        }
        for n in notifications {
            *self.metrics.lock().unwrap().notifications.entry(n.kind.clone()).or_default() += 1;
            info!(agent = %n.agent_id, kind = %n.kind, "notification");
            self.emit("notification", Some(&n.agent_id), serde_json::to_value(&n).unwrap());
            let _ = self.notify_tx.send(n);
        }
        (screens, lookups)
    }

    /// Reads new transcript lines into the entry. Returns the new items.
    fn poll_transcript(&self, entry: &mut AgentEntry, live: bool) -> Vec<StoredItem> {
        let Some(tail) = entry.tail.as_mut() else { return Vec::new() };
        let items = match tail.poll() {
            Ok(items) => items,
            Err(e) => {
                warn!(agent = %entry.view.id, error = %e, "lecture du transcript impossible");
                return Vec::new();
            }
        };
        let mut stored = Vec::with_capacity(items.len());
        for item in items {
            match &item {
                TimelineItem::TurnEnded { .. } if live => entry.pending_done = Some(Instant::now()),
                TimelineItem::UserMessage { text, .. } => {
                    entry.pending_done = None;
                    entry.interrupted_by_huntaway = false;
                    if !text.starts_with('/') {
                        entry.last_request = Some(first_line(text, 140));
                    }
                }
                _ => {}
            }
            entry.recent.push_back(item.clone());
            while entry.recent.len() > RECENT_ITEMS {
                entry.recent.pop_front();
            }
            let s = StoredItem { n: entry.next_n, item };
            entry.next_n += 1;
            entry.items.push_back(s.clone());
            while entry.items.len() > self.config.items_per_agent {
                entry.items.pop_front();
            }
            stored.push(s);
        }
        stored
    }

    // ------------------------------------------------------------ actions

    fn target(&self, id: &str) -> ActionResult<(Client, String, String)> {
        let state = self.state.lock().unwrap();
        let entry = state.agents.get(id).ok_or_else(ActionError::not_found)?;
        Ok((entry.client.clone(), entry.view.pane_id.clone(), entry.view.kind.clone()))
    }

    async fn fresh_status(&self, client: &Client, pane: &str) -> ActionResult<String> {
        Ok(client.agent_get(pane).await?.agent_status.as_str().to_string())
    }

    /// Sends a message. Refused while the agent waits on a prompt.
    pub async fn send_message(&self, id: &str, text: &str) -> ActionResult<()> {
        let text = text.trim();
        if text.is_empty() {
            return Err(ActionError::new(400, "empty_message", "message vide"));
        }
        let (client, pane, kind) = self.target(id)?;
        if self.fresh_status(&client, &pane).await? == "blocked" {
            return Err(ActionError::new(409, "agent_blocked", "l'agent attend une réponse : utilise choice ou deny"));
        }
        if kind == "claude" {
            // Claude puts an interrupted prompt back in its input box.
            client.agent_send_keys(&pane, claude::CLEAR_INPUT_KEYS).await?;
        }
        client.agent_prompt(&pane, text).await?;
        Ok(())
    }

    pub async fn interrupt(&self, id: &str) -> ActionResult<()> {
        let (client, pane, _) = self.target(id)?;
        client.agent_send_keys(&pane, &["esc"]).await?;
        if let Some(entry) = self.state.lock().unwrap().agents.get_mut(id) {
            entry.interrupted_by_huntaway = true;
        }
        Ok(())
    }

    /// Picks option `number` of the menu on screen. With `text`, types it
    /// into the picked option (Claude's "Type something." answer) and submits.
    pub async fn choose(&self, id: &str, number: u32, text: Option<&str>) -> ActionResult<Vec<String>> {
        let (client, pane, _) = self.target(id)?;
        if self.fresh_status(&client, &pane).await? != "blocked" {
            return Err(ActionError::new(409, "already_resolved", "l'agent n'attend plus de réponse"));
        }
        let screen = client.agent_read(&pane, ReadSource::Visible, None).await?;
        let options = numbered_options(&screen);
        let keys = keys_for_choice(&options, number)
            .ok_or_else(|| ActionError::new(409, "option_not_found", format!("option {number} absente de l'écran")))?;
        let refs: Vec<&str> = keys.iter().map(String::as_str).collect();
        client.agent_send_keys(&pane, &refs).await?;
        if let Some(text) = text.map(str::trim).filter(|t| !t.is_empty()) {
            tokio::time::sleep(Duration::from_millis(300)).await;
            client.pane_send_text(&pane, text).await?;
            tokio::time::sleep(Duration::from_millis(150)).await;
            client.agent_send_keys(&pane, &["enter"]).await?;
        }
        self.mark_screen_stale(id);
        Ok(keys)
    }

    /// Rejects the pending prompt (Esc) and optionally explains why.
    pub async fn deny(&self, id: &str, text: Option<&str>) -> ActionResult<()> {
        let (client, pane, _) = self.target(id)?;
        if self.fresh_status(&client, &pane).await? != "blocked" {
            return Err(ActionError::new(409, "already_resolved", "l'agent n'attend plus de réponse"));
        }
        client.agent_send_keys(&pane, &["esc"]).await?;
        self.mark_screen_stale(id);
        if let Some(text) = text.filter(|t| !t.trim().is_empty()) {
            // Let Claude leave the prompt before typing.
            for _ in 0..10 {
                tokio::time::sleep(Duration::from_millis(250)).await;
                if self.fresh_status(&client, &pane).await? != "blocked" {
                    break;
                }
            }
            self.send_message(id, text).await?;
        }
        Ok(())
    }

    /// Raw input (permission `agents.input`).
    pub async fn input(&self, id: &str, text: Option<&str>, keys: &[String]) -> ActionResult<()> {
        let (client, pane, _) = self.target(id)?;
        if let Some(text) = text {
            client.pane_send_text(&pane, text).await?;
        }
        if !keys.is_empty() {
            let refs: Vec<&str> = keys.iter().map(String::as_str).collect();
            client.agent_send_keys(&pane, &refs).await?;
        }
        Ok(())
    }

    /// Screen text and detected menu; with `ansi`, also the colored version.
    pub async fn screen(&self, id: &str, lines: Option<u32>, ansi: bool) -> ActionResult<Value> {
        let (client, pane, _) = self.target(id)?;
        let source = if lines.is_some() { ReadSource::Recent } else { ReadSource::Visible };
        let text = client.agent_read(&pane, source, lines).await?;
        let colored = if ansi { Some(client.agent_read_ansi(&pane, source, lines).await?) } else { None };
        Ok(json!({ "text": text, "ansi": colored, "options": numbered_options(&text) }))
    }

    /// Herdr client of a live session.
    fn session_client(&self, session: &str) -> ActionResult<Client> {
        let client = {
            let state = self.state.lock().unwrap();
            if !state.sessions.contains_key(session) {
                return Err(ActionError::new(404, "not_found", "session Herdr introuvable"));
            }
            state.agents.values().find(|a| a.view.session == session).map(|a| a.client.clone())
        };
        match client {
            Some(c) => Ok(c),
            None => herdr_client::discover_sessions()
                .into_iter()
                .find(|s| s.name == session)
                .map(|s| Client::new(&s.socket))
                .ok_or_else(|| ActionError::new(404, "not_found", "session Herdr introuvable")),
        }
    }

    /// Starts a new agent in a new tab of `workspace_id` and sends `prompt`
    /// (PRD §13.7). Returns the agent id and whether the prompt was sent: an
    /// agent blocked at startup (trust dialog) must be answered first.
    pub async fn create_agent(&self, req: &CreateAgent<'_>) -> ActionResult<(String, bool)> {
        if !matches!(req.kind, "claude" | "codex") {
            return Err(ActionError::new(400, "unsupported_kind", format!("type d'agent non pris en charge : {}", req.kind)));
        }
        let client = self.session_client(req.session)?;
        let mut args = Vec::new();
        if let Some(model) = req.model.map(str::trim).filter(|m| !m.is_empty()) {
            args.push("--model".to_string());
            args.push(model.to_string());
        }
        self.start_agent(&client, req.session, req.workspace_id, req.kind, &args, req.cwd, req.prompt).await
    }

    /// Opens a tab in `workspace_id`, starts `kind` with `args` and sends `prompt`.
    #[allow(clippy::too_many_arguments)]
    async fn start_agent(
        &self,
        client: &Client,
        session: &str,
        workspace_id: &str,
        kind: &str,
        args: &[String],
        cwd: Option<&str>,
        prompt: &str,
    ) -> ActionResult<(String, bool)> {
        let pane = client.tab_create(workspace_id, Some(kind), cwd).await?;
        let name = format!("k{}", now_ms() % 1_000_000_000);
        let id = agent_id(session, &pane);
        match client.agent_start(&name, kind, &pane, args).await {
            Ok(_) => {}
            Err(e) if e.code() == Some("agent_not_ready") => return Ok((id, false)),
            Err(e) => return Err(e.into()),
        }
        if prompt.trim().is_empty() {
            return Ok((id, false));
        }
        // `agent.start` returns before the agent accepts input
        // (`agent_not_ready`): retry for a while.
        let mut last = None;
        for _ in 0..40 {
            let result = async {
                if kind == "claude" {
                    client.agent_send_keys(&pane, claude::CLEAR_INPUT_KEYS).await?;
                }
                client.agent_prompt(&pane, prompt.trim()).await
            }
            .await;
            match result {
                Ok(_) => return Ok((id, true)),
                // A startup dialog (trust, update, hooks…) waits for an answer:
                // the agent exists, the app shows the dialog to answer first.
                Err(e) if e.code() == Some("agent_blocked") => return Ok((id, false)),
                Err(e) if e.code() == Some("agent_not_ready") => {
                    last = Some(e);
                    tokio::time::sleep(Duration::from_millis(500)).await;
                }
                Err(e) => return Err(e.into()),
            }
        }
        if let Some(e) = last {
            warn!(agent = %id, error = %e, "consigne non envoyée : agent pas prêt");
        }
        Ok((id, false))
    }

    /// Creates a Herdr workspace (project) rooted at `cwd`.
    pub async fn create_workspace(&self, session: &str, cwd: &str, label: Option<&str>) -> ActionResult<String> {
        if !std::path::Path::new(cwd).is_dir() {
            return Err(ActionError::new(400, "invalid_cwd", format!("dossier introuvable : {cwd}")));
        }
        let client = self.session_client(session)?;
        let label = label.map(str::to_string).or_else(|| cwd.rsplit('/').find(|s| !s.is_empty()).map(str::to_string));
        let id = client.workspace_create(cwd, label.as_deref()).await?;
        self.state.lock().unwrap().workspaces.entry(session.to_string()).or_default().push(WorkspaceView {
            session: session.to_string(),
            workspace_id: id.clone(),
            label,
            cwd: Some(cwd.to_string()),
        });
        Ok(id)
    }

    /// Resumes a past conversation in a new tab: `claude --resume <id>` or
    /// `codex resume <id>`. Without a workspace, uses one whose agents work
    /// in the same directory, else creates one.
    pub async fn resume(&self, found: &huntaway_core::history::Found, cwd: Option<&str>, session: Option<&str>, workspace_id: Option<&str>, prompt: &str) -> ActionResult<(String, bool)> {
        let session = match session {
            Some(s) => s.to_string(),
            None => {
                let state = self.state.lock().unwrap();
                let by_cwd = cwd.and_then(|c| state.agents.values().find(|a| a.view.cwd.as_deref() == Some(c)).map(|a| a.view.session.clone()));
                by_cwd
                    .or_else(|| state.sessions.keys().find(|k| *k == "default").cloned())
                    .or_else(|| state.sessions.keys().next().cloned())
                    .ok_or_else(|| ActionError::new(404, "not_found", "aucune session Herdr active"))?
            }
        };
        let client = self.session_client(&session)?;
        let workspace = match workspace_id {
            Some(w) => w.to_string(),
            None => {
                let existing = cwd.and_then(|c| {
                    let state = self.state.lock().unwrap();
                    state
                        .agents
                        .values()
                        .find(|a| a.view.session == session && a.view.cwd.as_deref() == Some(c))
                        .map(|a| a.view.workspace_id.clone())
                });
                match (existing, cwd) {
                    (Some(w), _) => w,
                    (None, Some(c)) if std::path::Path::new(c).is_dir() => self.create_workspace(&session, c, None).await?,
                    _ => return Err(ActionError::new(400, "workspace_required", "choisis un projet pour reprendre cette conversation")),
                }
            }
        };
        let args: Vec<String> = match found.kind {
            "codex" => vec!["resume".into(), found.session_id.clone()],
            _ => vec!["--resume".into(), found.session_id.clone()],
        };
        self.start_agent(&client, &session, &workspace, found.kind, &args, cwd, prompt).await
    }

    /// Native session ids of running agents → agent id.
    pub fn live_sessions(&self) -> std::collections::HashMap<String, String> {
        self.state
            .lock()
            .unwrap()
            .agents
            .values()
            .filter_map(|a| a.view.native_session.clone().map(|s| (s, a.view.id.clone())))
            .collect()
    }

    /// Working directory of an agent.
    pub fn agent_cwd(&self, id: &str) -> ActionResult<String> {
        let state = self.state.lock().unwrap();
        let entry = state.agents.get(id).ok_or_else(ActionError::not_found)?;
        entry.view.cwd.clone().ok_or_else(|| ActionError::new(404, "no_cwd", "dossier de l'agent inconnu"))
    }

    fn mark_screen_stale(&self, id: &str) {
        if let Some(entry) = self.state.lock().unwrap().agents.get_mut(id) {
            entry.needs_screen = true;
            // Only called after answering a prompt (choice / deny).
            entry.answered_from_huntaway = true;
        }
    }

    /// Usage metrics since the daemon started (PRD §22).
    pub fn metrics(&self) -> Value {
        let m = self.metrics.lock().unwrap();
        let mut all: Vec<f64> = m.episodes.iter().map(|(s, _)| *s).collect();
        all.sort_by(|a, b| a.total_cmp(b));
        let mut remote: Vec<f64> = m.episodes.iter().filter(|(_, k)| *k).map(|(s, _)| *s).collect();
        remote.sort_by(|a, b| a.total_cmp(b));
        let resolved_remote = remote.len();
        json!({
            "uptime_secs": self.started.elapsed().as_secs(),
            "blocked_episodes": all.len(),
            "resolved_from_huntaway": resolved_remote,
            "remote_unblock_rate": if all.is_empty() { None } else { Some(resolved_remote as f64 / all.len() as f64) },
            "time_to_unblock_secs": { "median": percentile(&all, 0.5), "p90": percentile(&all, 0.9) },
            "time_to_unblock_from_huntaway_secs": { "median": percentile(&remote, 0.5) },
            "notifications": m.notifications,
        })
    }
}

/// Attaches the native session (transcript) reported late by the Herdr integration.
fn attach_session(entry: &mut AgentEntry, info: &AgentInfo) {
    entry.info = info.clone();
    entry.view.instance_id = instance_key(info);
    entry.view.warnings.retain(|w| w != "missing_herdr_integration");
    entry.view.native_session = info.agent_session.as_ref().map(|s| s.value.clone());
    entry.tail = locate_transcript(info);
}

/// Identifies the occupant of a pane: native session id, else kind.
fn instance_key(info: &AgentInfo) -> String {
    let base = info.agent_session.as_ref().map(|s| s.value.clone()).unwrap_or_else(|| info.agent.clone().unwrap_or_default());
    format!("{}:{}", info.terminal_id.as_deref().unwrap_or(""), base)
}

/// Opens the transcript of an agent, in the format of its kind.
fn locate_transcript(info: &AgentInfo) -> Option<TranscriptTail> {
    let session = &info.agent_session.as_ref()?.value;
    match info.agent.as_deref()? {
        "claude" => claude::transcript_path(info.cwd.as_deref(), session).map(TranscriptTail::new),
        "codex" => codex::transcript_path(session).map(TranscriptTail::codex),
        _ => None,
    }
}

/// Agent kinds whose conversation Huntaway can read.
fn has_adapter(kind: &str) -> bool {
    matches!(kind, "claude" | "codex")
}

/// Recomputes attention, summary and interaction from the entry state.
fn recompute(entry: &mut AgentEntry) {
    let recent: Vec<TimelineItem> = entry.recent.iter().cloned().collect();
    let pending = entry.tail.as_ref().and_then(|t| t.pending_tool_calls().last().map(|p| (*p).clone()));
    let mut attention = classify(&entry.status, pending.as_ref().map(|p| p.kind), &recent);
    // Headless servers report `idle` instead of `done`: a finished turn means done.
    if attention == Attention::Idle && turn_ended(&recent) {
        attention = Attention::Done;
    }

    entry.view.herdr_status = entry.status.clone();
    entry.view.attention = attention;
    entry.view.has_transcript = entry.tail.is_some();
    entry.view.item_count = entry.next_n;
    entry.view.last_activity_at = recent.iter().rev().map(|i| i.timestamp()).find(|t| !t.is_empty()).map(str::to_string);
    if entry.view.started_at.is_none() {
        entry.view.started_at = entry.items.iter().map(|i| i.item.timestamp()).find(|t| !t.is_empty()).map(str::to_string);
    }
    if let Some(tail) = entry.tail.as_ref() {
        entry.view.usage = tail.usage();
        entry.view.model = entry.view.usage.as_ref().and_then(|u| u.model.clone());
        entry.view.title = tail.title().map(str::to_string);
    }
    if let Some(summary) = summary(entry, &recent) {
        entry.view.summary = summary;
    }

    entry.view.interaction = match attention {
        Attention::Blocked(reason) => {
            let questions = pending
                .as_ref()
                .and_then(|p| {
                    recent.iter().rev().find_map(|i| match i {
                        TimelineItem::QuestionAsked { tool_use_id, questions, .. } if *tool_use_id == p.tool_use_id => Some(questions.clone()),
                        _ => None,
                    })
                })
                .unwrap_or_default();
            Some(Interaction {
                reason,
                tool: pending.map(|p| PendingToolView { tool_use_id: p.tool_use_id, name: p.name, summary: p.summary, input: p.input }),
                questions,
                options: entry.screen_options.clone(),
            })
        }
        _ => {
            entry.screen_options.clear();
            None
        }
    };
}

fn turn_ended(recent: &[TimelineItem]) -> bool {
    for item in recent.iter().rev() {
        match item {
            TimelineItem::TurnEnded { .. } => return true,
            TimelineItem::UserMessage { .. } => return false,
            _ => {}
        }
    }
    false
}

/// Terminal title as a last-resort summary, unless it is just the launch
/// command (`claude --resume <id>`).
fn title_summary(info: &AgentInfo) -> String {
    let title = info.terminal_title.as_deref().unwrap_or_default().trim();
    let kind = info.agent.as_deref().unwrap_or_default();
    if title.is_empty() || (!kind.is_empty() && title.starts_with(kind)) {
        String::new()
    } else {
        title.to_string()
    }
}

/// Card summary: todo in progress, else last user request.
fn summary(entry: &AgentEntry, recent: &[TimelineItem]) -> Option<String> {
    if let Some(todo) = entry.tail.as_ref().and_then(|t| t.todos().iter().find(|t| t.status == "in_progress")) {
        return Some(todo.content.clone());
    }
    recent
        .iter()
        .rev()
        .find_map(|i| match i {
            TimelineItem::UserMessage { text, .. } if !text.starts_with('/') => Some(first_line(text, 140)),
            _ => None,
        })
        .or_else(|| entry.last_request.clone())
}

fn first_line(text: &str, max: usize) -> String {
    let line = text.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or_default();
    if line.chars().count() > max {
        format!("{}…", line.chars().take(max).collect::<String>())
    } else {
        line.to_string()
    }
}

fn display_name(entry: &AgentEntry) -> String {
    let kind = &entry.view.kind;
    let mut chars = kind.chars();
    chars.next().map(|c| c.to_uppercase().chain(chars).collect()).unwrap_or_else(|| "Agent".into())
}

fn build_notification(entry: &AgentEntry, kind: &str) -> Notification {
    let name = display_name(entry);
    let project = &entry.view.project;
    let (title, detail) = match kind {
        "blocked" => {
            let title = format!("{name} a besoin de toi");
            let detail = match &entry.view.interaction {
                Some(Interaction { tool: Some(tool), reason: BlockedReason::Approval, .. }) => format!("Approbation : {} {}", tool.name, tool.summary),
                Some(Interaction { questions, .. }) if !questions.is_empty() => questions[0].question.clone(),
                _ => last_assistant_text(entry).unwrap_or_else(|| "En attente d'une réponse".into()),
            };
            (title, detail)
        }
        "error" => (format!("{name} s'est arrêté"), "l'agent a quitté pendant son travail".to_string()),
        _ => {
            // Only the current turn: an older away summary would be stale.
            let turn: Vec<&TimelineItem> =
                entry.recent.iter().rev().take_while(|i| !matches!(i, TimelineItem::UserMessage { .. })).collect();
            let detail = turn
                .iter()
                .find_map(|i| match i {
                    TimelineItem::AwaySummary { text, .. } => Some(text.clone()),
                    _ => None,
                })
                .or_else(|| last_assistant_text(entry))
                .unwrap_or_else(|| "Tâche terminée".into());
            (format!("{name} a terminé"), detail)
        }
    };
    Notification {
        id: format!("n{}", now_ms()),
        agent_id: entry.view.id.clone(),
        kind: kind.to_string(),
        title,
        body: first_line(&format!("{project} · {detail}"), 180),
    }
}

fn last_assistant_text(entry: &AgentEntry) -> Option<String> {
    entry.recent.iter().rev().find_map(|i| match i {
        TimelineItem::AssistantMessage { text, sidechain: false, .. } => Some(first_line(text, 160)),
        _ => None,
    })
}
