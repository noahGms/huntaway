//! One connection per machine: event stream with reconnection, a cache of
//! the machine state (for the tray badge and front-end reloads), native
//! notifications, and the live terminals opened by the front end.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use huntaway_api::{AgentView, Envelope, Notification, SessionView, StateSnapshot};
use huntaway_client::stream::{self, StreamEvent, StreamHandle};
use huntaway_client::terminal::TerminalHandle;
use huntaway_client::Client;
use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

use crate::local;
use crate::storage::{MachineRecord, Settings, Storage};

pub fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct MachineStatus {
    /// `connecting`, `online` or `offline`.
    pub state: String,
    pub address: Option<String>,
    pub latency_ms: Option<u64>,
    pub error: Option<String>,
    /// Seconds since the epoch of the last message received.
    pub last_seen: Option<u64>,
    pub retry_in_ms: Option<u64>,
}

/// What the front end gets for each machine.
#[derive(Debug, Clone, Serialize)]
pub struct MachineView {
    pub record: MachineRecord,
    pub status: MachineStatus,
    pub snapshot: Option<StateSnapshot>,
}

struct Machine {
    record: MachineRecord,
    client: Client,
    status: MachineStatus,
    snapshot: Option<StateSnapshot>,
    stream: Option<StreamHandle>,
    /// Live terminals by agent id (or `pane|<pane>` for pane terminals).
    terminals: HashMap<String, TerminalHandle>,
    /// Terminal being opened per key: a close in the meantime cancels it.
    opening: HashMap<String, u64>,
    /// Agents whose `agent.item` events the front end wants (`None` = all).
    items: Option<Vec<String>>,
    /// Number of its last successful connection (`CONNECT_SEQ`): a new one
    /// means the daemon may have restarted.
    connects: u64,
}

static CONNECT_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// An online machine, for background jobs (skills sync).
#[derive(Clone)]
pub struct OnlineMachine {
    pub machine_id: String,
    pub permissions: Vec<String>,
    pub client: Client,
    pub connects: u64,
}

/// Conversation shown in the focused window: no notification for it.
#[derive(Default, Clone)]
pub struct Focus {
    pub machine_id: Option<String>,
    pub agent_id: Option<String>,
}

pub struct Machines {
    app: AppHandle,
    pub storage: Storage,
    inner: Mutex<HashMap<String, Machine>>,
    pub focus: Mutex<Focus>,
    pub settings: Mutex<Settings>,
    /// Main window focused: daemons skip phone pushes meanwhile.
    window_focused: std::sync::atomic::AtomicBool,
    /// One local daemon lookup at a time (background loop, Start button).
    local_lock: tokio::sync::Mutex<()>,
    terminal_seq: std::sync::atomic::AtomicU64,
}

pub type Shared = Arc<Machines>;

impl Machines {
    pub fn new(app: AppHandle, storage: Storage) -> Shared {
        let settings = storage.settings();
        Arc::new(Self {
            app,
            storage,
            inner: Mutex::new(HashMap::new()),
            focus: Mutex::new(Focus::default()),
            settings: Mutex::new(settings),
            window_focused: std::sync::atomic::AtomicBool::new(true),
            local_lock: tokio::sync::Mutex::new(()),
            terminal_seq: std::sync::atomic::AtomicU64::new(0),
        })
    }

    /// Connects every saved machine, then looks for the local daemon.
    pub fn start(self: &Arc<Self>) {
        for record in self.storage.machines() {
            if record.local {
                continue;
            }
            if let Some(token) = self.storage.token(&record.machine_id) {
                self.connect(record, token);
            }
        }
        let me = self.clone();
        tauri::async_runtime::spawn(async move {
            loop {
                me.refresh_local().await;
                tokio::time::sleep(Duration::from_secs(10)).await;
            }
        });
        // Presence is repeated while focused: it expires on the daemon after 60 s.
        let me = self.clone();
        tauri::async_runtime::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_secs(30)).await;
                if me.window_focused.load(std::sync::atomic::Ordering::Relaxed) {
                    me.send_presence();
                }
            }
        });
    }

    pub fn set_window_focused(&self, focused: bool) {
        let before = self.window_focused.swap(focused, std::sync::atomic::Ordering::Relaxed);
        if before != focused {
            self.send_presence();
            // Back from sleep or another app: don't wait for the backoff.
            if focused {
                self.kick_all();
            }
        }
    }

    /// Checks every connection now: offline machines retry at once, and a
    /// socket that died during sleep is noticed within seconds.
    pub fn kick_all(&self) {
        for m in self.inner.lock().unwrap().values() {
            if let Some(stream) = &m.stream {
                stream.kick();
            }
        }
    }

    /// Tells every online daemon whether this desktop is in front of the user.
    fn send_presence(&self) {
        let active = self.window_focused.load(std::sync::atomic::Ordering::Relaxed);
        let clients: Vec<Client> = self.inner.lock().unwrap().values().filter(|m| m.status.state == "online").map(|m| m.client.clone()).collect();
        for client in clients {
            tauri::async_runtime::spawn(async move {
                // Older daemons have no presence route: ignore the 404.
                let _ = client.post("/v1/presence", json!({ "active": active })).await;
            });
        }
    }

    /// Connects the local daemon when its token appears (or changes).
    pub async fn refresh_local(self: &Arc<Self>) -> bool {
        let _lock = self.local_lock.lock().await;
        let Some(daemon) = local::detect() else { return false };
        let current = {
            let inner = self.inner.lock().unwrap();
            inner.values().find(|m| m.record.local).map(|m| (m.record.machine_id.clone(), m.client.token().to_string()))
        };
        if let Some((_, token)) = &current {
            if *token == daemon.token {
                return true;
            }
        }
        let client = Client::new(vec![daemon.address.clone()], daemon.token.clone());
        let info = match client.machine().await {
            Ok(info) => info,
            Err(_) => return false,
        };
        if let Some((id, _)) = current {
            self.disconnect(&id);
        }
        // The same machine paired remotely: the local connection wins.
        self.disconnect(&info.machine.machine_id);
        let record = MachineRecord {
            machine_id: info.machine.machine_id.clone(),
            name: info.machine.machine_name.clone(),
            addresses: vec![daemon.address],
            public_key: None,
            device_id: Some(info.device.id.clone()),
            permissions: info.device.permissions.clone(),
            local: true,
            added_at: now_secs(),
        };
        self.connect(record, daemon.token);
        self.app.emit("machines-changed", ()).ok();
        true
    }

    pub fn connect(self: &Arc<Self>, record: MachineRecord, token: String) {
        let client = Client::new(record.addresses.clone(), token);
        // Also called from `setup`, on the main thread, outside the runtime.
        let runtime = tauri::async_runtime::handle();
        let _guard = runtime.inner().enter();
        let id = record.machine_id.clone();
        // A reconnection keeps the item filter the front end set.
        let items = self.inner.lock().unwrap().get(&id).and_then(|m| m.items.clone());
        let (handle, mut rx) = stream::spawn_with_items(client.clone(), items.clone());
        let status = MachineStatus { state: "connecting".into(), ..Default::default() };
        let machine = Machine {
            record,
            client,
            status: status.clone(),
            snapshot: None,
            stream: Some(handle),
            terminals: HashMap::new(),
            opening: HashMap::new(),
            items,
            connects: 0,
        };
        let known = self.inner.lock().unwrap().insert(id.clone(), machine).is_some();
        // A reconnection shows "connecting" right away; a new machine comes with `machines-changed`.
        if known {
            self.app.emit("machine-status", json!({ "machine_id": id, "status": status })).ok();
        }
        let me = self.clone();
        tauri::async_runtime::spawn(async move {
            while let Some(event) = rx.recv().await {
                me.on_stream_event(&id, event);
            }
        });
    }

    pub fn disconnect(&self, machine_id: &str) -> Option<MachineRecord> {
        let removed = self.inner.lock().unwrap().remove(machine_id).map(|m| m.record);
        if removed.is_some() {
            self.update_badge();
        }
        removed
    }

    pub fn client(&self, machine_id: &str) -> Result<Client, String> {
        self.inner
            .lock()
            .unwrap()
            .get(machine_id)
            .map(|m| m.client.clone())
            .ok_or_else(|| "unknown machine".to_string())
    }

    pub fn online(&self) -> Vec<OnlineMachine> {
        self.inner
            .lock()
            .unwrap()
            .values()
            .filter(|m| m.status.state == "online")
            .map(|m| OnlineMachine {
                machine_id: m.record.machine_id.clone(),
                permissions: m.record.permissions.clone(),
                client: m.client.clone(),
                connects: m.connects,
            })
            .collect()
    }

    pub fn views(&self) -> Vec<MachineView> {
        let inner = self.inner.lock().unwrap();
        let mut views: Vec<MachineView> = inner
            .values()
            .map(|m| MachineView { record: m.record.clone(), status: m.status.clone(), snapshot: m.snapshot.clone() })
            .collect();
        views.sort_by(|a, b| b.record.local.cmp(&a.record.local).then_with(|| a.record.name.cmp(&b.record.name)));
        views
    }

    pub fn rename(&self, machine_id: &str, name: &str) -> Result<(), String> {
        let mut inner = self.inner.lock().unwrap();
        let machine = inner.get_mut(machine_id).ok_or("unknown machine")?;
        machine.record.name = name.to_string();
        if !machine.record.local {
            let mut saved = self.storage.machines();
            if let Some(r) = saved.iter_mut().find(|r| r.machine_id == machine_id) {
                r.name = name.to_string();
            }
            self.storage.save_machines(&saved)?;
        }
        Ok(())
    }

    /// Reconnects at once (skips the backoff).
    pub fn reconnect(self: &Arc<Self>, machine_id: &str) -> Result<(), String> {
        let (record, token) = {
            let inner = self.inner.lock().unwrap();
            let m = inner.get(machine_id).ok_or("unknown machine")?;
            (m.record.clone(), m.client.token().to_string())
        };
        // Replaces the old connection (dropped with its stream).
        self.connect(record, token);
        self.update_badge();
        Ok(())
    }

    /// Starts opening a terminal; returns the ticket `set_terminal` needs.
    pub fn begin_terminal(&self, machine_id: &str, key: &str) -> u64 {
        let ticket = self.terminal_seq.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1;
        if let Some(m) = self.inner.lock().unwrap().get_mut(machine_id) {
            m.opening.insert(key.to_string(), ticket);
        }
        ticket
    }

    /// Keeps an opened terminal, unless it was closed (or reopened) meanwhile:
    /// returns false and the handle is dropped, which closes it.
    pub fn set_terminal(&self, machine_id: &str, key: &str, ticket: u64, handle: TerminalHandle) -> bool {
        let mut inner = self.inner.lock().unwrap();
        let Some(m) = inner.get_mut(machine_id) else { return false };
        if m.opening.get(key) != Some(&ticket) {
            return false;
        }
        m.opening.remove(key);
        m.terminals.insert(key.to_string(), handle);
        true
    }

    pub fn close_terminal(&self, machine_id: &str, key: &str) {
        if let Some(m) = self.inner.lock().unwrap().get_mut(machine_id) {
            m.opening.remove(key);
            m.terminals.remove(key);
        }
    }

    pub fn terminal_input(&self, machine_id: &str, key: &str, input: huntaway_client::terminal::TerminalInput) -> Result<(), String> {
        let inner = self.inner.lock().unwrap();
        let handle = inner.get(machine_id).and_then(|m| m.terminals.get(key)).ok_or("terminal closed")?;
        handle.input.send(input).map_err(|_| "terminal closed".to_string())
    }

    /// Limits the `agent.item` events of a machine's stream to these agents.
    pub fn set_stream_items(&self, machine_id: &str, agent_ids: Option<Vec<String>>) -> Result<(), String> {
        let mut inner = self.inner.lock().unwrap();
        let m = inner.get_mut(machine_id).ok_or("unknown machine")?;
        if let Some(stream) = &m.stream {
            stream.set_items(agent_ids.clone());
        }
        m.items = agent_ids;
        Ok(())
    }

    // ------------------------------------------------------------- stream

    fn on_stream_event(&self, machine_id: &str, event: StreamEvent) {
        let mut notification = None;
        let mut status_changed = false;
        let mut badge = false;
        {
            let mut inner = self.inner.lock().unwrap();
            let Some(m) = inner.get_mut(machine_id) else { return };
            m.status.last_seen = Some(now_secs());
            match &event {
                StreamEvent::Connected { address } => {
                    if self.window_focused.load(std::sync::atomic::Ordering::Relaxed) {
                        let client = m.client.clone();
                        tauri::async_runtime::spawn(async move {
                            let _ = client.post("/v1/presence", json!({ "active": true })).await;
                        });
                    }
                    m.status.state = "online".into();
                    m.connects = CONNECT_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1;
                    m.status.address = Some(address.clone());
                    m.status.error = None;
                    m.status.retry_in_ms = None;
                    status_changed = true;
                    badge = true;
                }
                StreamEvent::Latency(ms) => {
                    m.status.latency_ms = Some(*ms);
                    status_changed = true;
                }
                StreamEvent::Disconnected { error, retry_in } => {
                    m.status.state = "offline".into();
                    m.status.error = Some(error.clone());
                    m.status.retry_in_ms = Some(retry_in.as_millis() as u64);
                    m.status.latency_ms = None;
                    status_changed = true;
                    // Its agents no longer count as waiting.
                    badge = true;
                }
                StreamEvent::Snapshot(snapshot) => {
                    // The local machine follows the daemon's name; paired machines keep the one given in the app.
                    if m.record.local {
                        m.record.name = snapshot.machine.machine_name.clone();
                    }
                    m.snapshot = Some((**snapshot).clone());
                    badge = true;
                }
                StreamEvent::Event(envelope) => {
                    badge = apply(m.snapshot.as_mut(), envelope);
                    if envelope.kind == "notification" {
                        if let Ok(n) = serde_json::from_value::<Notification>(envelope.data.clone()) {
                            let agent = m.snapshot.as_ref().and_then(|s| s.agents.iter().find(|a| a.id == n.agent_id));
                            let approve = if n.kind == "blocked" { crate::notify::approve_option(agent, n.interaction_id.as_deref()) } else { None };
                            notification = Some((n, m.record.name.clone(), m.client.clone(), approve));
                        }
                    }
                    if let Some(agent_id) = &envelope.agent_id {
                        if envelope.kind == "agent.updated" || envelope.kind == "agent.removed" {
                            let agent = m.snapshot.as_ref().and_then(|s| s.agents.iter().find(|a| &a.id == agent_id));
                            let current = agent.filter(|a| a.attention.is_blocked()).and_then(|a| a.interaction.as_ref()).map(|i| i.id.as_str());
                            crate::notify::dismiss_stale(&self.app, machine_id, agent_id, current);
                        }
                    }
                }
            }
            if status_changed {
                let payload = json!({ "machine_id": machine_id, "status": m.status });
                self.app.emit("machine-status", payload).ok();
            }
        }
        match event {
            StreamEvent::Snapshot(snapshot) => {
                self.app.emit("machine-snapshot", json!({ "machine_id": machine_id, "snapshot": snapshot })).ok();
            }
            StreamEvent::Event(envelope) => {
                self.app.emit("machine-event", json!({ "machine_id": machine_id, "event": envelope })).ok();
            }
            _ => {}
        }
        if badge {
            self.update_badge();
        }
        if let Some((n, machine_name, client, approve)) = notification {
            self.notify(machine_id, &machine_name, client, n, approve);
        }
    }

    fn notify(&self, machine_id: &str, machine_name: &str, client: Client, n: Notification, approve: Option<u32>) {
        let settings = self.settings.lock().unwrap().clone();
        let wanted = match n.kind.as_str() {
            "blocked" => settings.notify_blocked,
            "done" => settings.notify_done,
            "error" => settings.notify_error,
            _ => true,
        };
        if !wanted {
            return;
        }
        // Already looking at this conversation.
        let focused = self.app.get_webview_window("main").and_then(|w| w.is_focused().ok()).unwrap_or(false);
        let focus = self.focus.lock().unwrap().clone();
        if focused && focus.machine_id.as_deref() == Some(machine_id) && focus.agent_id.as_deref() == Some(n.agent_id.as_str()) {
            return;
        }
        crate::notify::show(crate::notify::Pending {
            app: self.app.clone(),
            client,
            machine_id: machine_id.to_string(),
            machine_name: machine_name.to_string(),
            notification: n,
            approve,
            sound: settings.notification_sound,
            test: false,
        });
    }

    /// Agents waiting for the user, on the machines online (the state of the
    /// others is stale).
    pub fn blocked_count(&self) -> usize {
        self.inner
            .lock()
            .unwrap()
            .values()
            .filter(|m| m.status.state == "online")
            .filter_map(|m| m.snapshot.as_ref())
            .flat_map(|s| s.agents.iter())
            .filter(|a| a.attention.is_blocked())
            .count()
    }

    pub fn update_badge(&self) {
        let count = self.blocked_count();
        crate::tray::set_count(&self.app, count);
        if let Some(window) = self.app.get_webview_window("main") {
            let _ = window.set_badge_count(if count > 0 { Some(count as i64) } else { None });
        }
    }
}

/// Applies a stream event to the cached state. Returns true when the number
/// of waiting agents may have changed.
fn apply(snapshot: Option<&mut StateSnapshot>, envelope: &Envelope) -> bool {
    let Some(state) = snapshot else { return false };
    state.seq = envelope.seq;
    match envelope.kind.as_str() {
        "agent.updated" => {
            let Ok(agent) = serde_json::from_value::<AgentView>(envelope.data.clone()) else { return false };
            match state.agents.iter_mut().find(|a| a.id == agent.id) {
                Some(existing) => *existing = agent,
                None => state.agents.push(agent),
            }
            true
        }
        "agent.removed" => {
            if let Some(id) = &envelope.agent_id {
                state.agents.retain(|a| &a.id != id);
            }
            true
        }
        "workspaces.updated" => {
            if let Some(list) = envelope.data.get("workspaces").cloned() {
                if let Ok(list) = serde_json::from_value(list) {
                    state.workspaces = list;
                }
            }
            false
        }
        "sessions.updated" => {
            if let Some(sessions) = envelope.data.get("sessions").cloned() {
                if let Ok(sessions) = serde_json::from_value::<Vec<SessionView>>(sessions) {
                    state.sessions = sessions;
                }
            }
            false
        }
        _ => false,
    }
}

/// Error payload returned to the front end.
pub fn error_value(e: &huntaway_client::Error) -> Value {
    match e {
        huntaway_client::Error::Api { status, code, message } => json!({ "status": status, "code": code, "message": message }),
        other => json!({ "status": 0, "code": other.code(), "message": other.to_string() }),
    }
}
