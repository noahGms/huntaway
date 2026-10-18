//! Minimal async client for the Herdr socket API.
//!
//! Herdr exposes newline-delimited JSON over a local Unix socket:
//! `{"id","method","params"}` → `{"id","result"}` or `{"id","error"}`.
//! Plain calls use one short-lived connection each; subscriptions keep a
//! dedicated connection open.

use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::unix::OwnedReadHalf;
use tokio::net::UnixStream;

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("json: {0}")]
    Json(#[from] serde_json::Error),
    #[error("herdr error {code}: {message}")]
    Herdr { code: String, message: String },
    #[error("connection closed")]
    Closed,
    /// Herdr did not answer in time (frozen session).
    #[error("herdr did not answer within {0:?}")]
    Timeout(Duration),
    #[error("unexpected response: {0}")]
    Unexpected(String),
}

impl Error {
    /// Herdr error code, e.g. `agent_blocked`, `not_found`, `events_lost`.
    pub fn code(&self) -> Option<&str> {
        match self {
            Error::Herdr { code, .. } => Some(code),
            _ => None,
        }
    }
}

/// A running Herdr server (one per session) reachable through its socket.
#[derive(Debug, Clone)]
pub struct Session {
    pub name: String,
    pub socket: PathBuf,
}

/// Herdr config directory (`~/.config/herdr`).
pub fn config_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("XDG_CONFIG_HOME") {
        if !dir.is_empty() {
            return PathBuf::from(dir).join("herdr");
        }
    }
    home_dir().join(".config").join("herdr")
}

pub fn home_dir() -> PathBuf {
    PathBuf::from(std::env::var("HOME").unwrap_or_else(|_| ".".into()))
}

/// Lists session sockets that exist on disk: the default session plus
/// `sessions/<name>/herdr.sock`. Liveness is checked separately with `ping`.
pub fn discover_sessions() -> Vec<Session> {
    let dir = config_dir();
    let mut sessions = Vec::new();
    let default = dir.join("herdr.sock");
    if default.exists() {
        sessions.push(Session { name: "default".into(), socket: default });
    }
    if let Ok(entries) = std::fs::read_dir(dir.join("sessions")) {
        let mut named: Vec<Session> = entries
            .flatten()
            .filter_map(|e| {
                let socket = e.path().join("herdr.sock");
                socket.exists().then(|| Session {
                    name: e.file_name().to_string_lossy().into_owned(),
                    socket,
                })
            })
            .collect();
        named.sort_by(|a, b| a.name.cmp(&b.name));
        sessions.extend(named);
    }
    sessions
}

/// Lists sessions whose server answers `ping`.
pub async fn discover_live_sessions() -> Vec<(Session, Pong)> {
    let mut live = Vec::new();
    for session in discover_sessions() {
        let client = Client::new(&session.socket);
        if let Ok(pong) = client.ping().await {
            live.push((session, pong));
        }
    }
    live
}

#[derive(Debug, Clone, Deserialize)]
pub struct Pong {
    pub version: String,
    pub protocol: u32,
    #[serde(default)]
    pub capabilities: Value,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentStatus {
    Idle,
    Working,
    Blocked,
    Done,
    Unknown,
}

impl AgentStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            AgentStatus::Idle => "idle",
            AgentStatus::Working => "working",
            AgentStatus::Blocked => "blocked",
            AgentStatus::Done => "done",
            AgentStatus::Unknown => "unknown",
        }
    }
}

/// Native session reference reported by a Herdr integration
/// (for Claude Code: the session UUID, also the transcript file name).
#[derive(Debug, Clone, Deserialize)]
pub struct AgentSession {
    pub agent: Option<String>,
    pub kind: Option<String>,
    pub source: Option<String>,
    pub value: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct AgentInfo {
    pub pane_id: String,
    pub workspace_id: String,
    pub tab_id: String,
    pub terminal_id: Option<String>,
    /// Agent kind detected by Herdr, e.g. `claude`, `codex`.
    pub agent: Option<String>,
    pub agent_status: AgentStatus,
    pub agent_session: Option<AgentSession>,
    pub cwd: Option<String>,
    pub foreground_cwd: Option<String>,
    pub terminal_title: Option<String>,
    pub state_change_seq: Option<u64>,
    pub completion_seq: Option<u64>,
    #[serde(default)]
    pub focused: bool,
}

#[derive(Debug, Clone, Deserialize)]
pub struct WorkspaceInfo {
    pub workspace_id: String,
    pub label: Option<String>,
    pub agent_status: Option<AgentStatus>,
    pub pane_count: Option<u32>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct TabInfo {
    pub tab_id: String,
    pub label: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Snapshot {
    pub version: Option<String>,
    pub protocol: Option<u32>,
    #[serde(default)]
    pub workspaces: Vec<WorkspaceInfo>,
    #[serde(default)]
    pub panes: Vec<Value>,
    #[serde(default)]
    pub agents: Vec<Value>,
}

#[derive(Debug, Clone, Copy)]
pub enum ReadSource {
    Visible,
    Recent,
    RecentUnwrapped,
    Detection,
}

impl ReadSource {
    fn as_str(self) -> &'static str {
        match self {
            ReadSource::Visible => "visible",
            ReadSource::Recent => "recent",
            ReadSource::RecentUnwrapped => "recent_unwrapped",
            ReadSource::Detection => "detection",
        }
    }
}

/// Every Herdr method this client calls (checked against `herdr api schema`).
pub const USED_METHODS: &[&str] = &[
    "ping",
    "session.snapshot",
    "agent.list",
    "agent.get",
    "agent.read",
    "agent.prompt",
    "agent.send_keys",
    "agent.start",
    "workspace.list",
    "tab.list",
    "tab.create",
    "workspace.create",
    "pane.send_text",
    "events.subscribe",
];

/// Methods of [`USED_METHODS`] missing from a schema printed by
/// `herdr api schema --json`. Empty means compatible.
pub fn missing_methods(schema: &Value) -> Vec<&'static str> {
    let variants = schema["schemas"]["request"]["oneOf"].as_array().cloned().unwrap_or_default();
    let known: std::collections::HashSet<&str> =
        variants.iter().filter_map(|v| v["properties"]["method"]["const"].as_str()).collect();
    USED_METHODS.iter().copied().filter(|m| !known.contains(m)).collect()
}

/// A plain call that takes longer than this means the Herdr server is stuck:
/// fail instead of freezing the caller.
pub const CALL_TIMEOUT: Duration = Duration::from_secs(5);
/// `agent.start` waits up to its own `timeout_ms` (60 s) for the agent.
const AGENT_START_TIMEOUT: Duration = Duration::from_secs(65);

async fn with_timeout<T>(limit: Duration, fut: impl Future<Output = Result<T>>) -> Result<T> {
    tokio::time::timeout(limit, fut).await.unwrap_or(Err(Error::Timeout(limit)))
}

static NEXT_ID: AtomicU64 = AtomicU64::new(1);

fn next_id() -> String {
    format!("huntaway_{}", NEXT_ID.fetch_add(1, Ordering::Relaxed))
}

async fn send_request(stream: &mut UnixStream, id: &str, method: &str, params: Value) -> Result<()> {
    let mut line = serde_json::to_vec(&json!({ "id": id, "method": method, "params": params }))?;
    line.push(b'\n');
    stream.write_all(&line).await?;
    Ok(())
}

fn parse_response(line: &str) -> Result<Value> {
    let mut msg: Value = serde_json::from_str(line)?;
    if let Some(err) = msg.get("error") {
        return Err(Error::Herdr {
            code: err["code"].as_str().unwrap_or("unknown").to_string(),
            message: err["message"].as_str().unwrap_or_default().to_string(),
        });
    }
    match msg.get_mut("result") {
        Some(result) => Ok(result.take()),
        None => Err(Error::Unexpected(line.chars().take(200).collect())),
    }
}

/// Client bound to one Herdr session socket.
#[derive(Debug, Clone)]
pub struct Client {
    socket: PathBuf,
}

impl Client {
    pub fn new(socket: impl AsRef<Path>) -> Self {
        Self { socket: socket.as_ref().to_path_buf() }
    }

    pub fn socket(&self) -> &Path {
        &self.socket
    }

    /// Sends one request and returns its `result`, failing after [`CALL_TIMEOUT`].
    pub async fn call(&self, method: &str, params: Value) -> Result<Value> {
        self.call_within(CALL_TIMEOUT, method, params).await
    }

    async fn call_within(&self, limit: Duration, method: &str, params: Value) -> Result<Value> {
        with_timeout(limit, self.call_raw(method, params)).await
    }

    async fn call_raw(&self, method: &str, params: Value) -> Result<Value> {
        let mut stream = UnixStream::connect(&self.socket).await?;
        let id = next_id();
        send_request(&mut stream, &id, method, params).await?;
        let mut reader = BufReader::new(stream);
        let mut line = String::new();
        if reader.read_line(&mut line).await? == 0 {
            return Err(Error::Closed);
        }
        parse_response(&line)
    }

    async fn call_field<T: DeserializeOwned>(&self, method: &str, params: Value, field: &str) -> Result<T> {
        let mut result = self.call(method, params).await?;
        Ok(serde_json::from_value(result[field].take())?)
    }

    pub async fn ping(&self) -> Result<Pong> {
        Ok(serde_json::from_value(self.call("ping", json!({})).await?)?)
    }

    pub async fn snapshot(&self) -> Result<Snapshot> {
        self.call_field("session.snapshot", json!({}), "snapshot").await
    }

    pub async fn agent_list(&self) -> Result<Vec<AgentInfo>> {
        self.call_field("agent.list", json!({}), "agents").await
    }

    pub async fn workspace_list(&self) -> Result<Vec<WorkspaceInfo>> {
        self.call_field("workspace.list", json!({}), "workspaces").await
    }

    pub async fn tab_list(&self) -> Result<Vec<TabInfo>> {
        self.call_field("tab.list", json!({}), "tabs").await
    }

    pub async fn agent_get(&self, target: &str) -> Result<AgentInfo> {
        self.call_field("agent.get", json!({ "target": target }), "agent").await
    }

    /// Reads the agent's screen as plain text (ANSI stripped).
    pub async fn agent_read(&self, target: &str, source: ReadSource, lines: Option<u32>) -> Result<String> {
        let result = self
            .call(
                "agent.read",
                json!({ "target": target, "source": source.as_str(), "lines": lines }),
            )
            .await?;
        Ok(result["read"]["text"].as_str().unwrap_or_default().to_string())
    }

    /// Reads the agent's screen with ANSI colors kept (for a terminal emulator).
    pub async fn agent_read_ansi(&self, target: &str, source: ReadSource, lines: Option<u32>) -> Result<String> {
        let result = self
            .call(
                "agent.read",
                json!({ "target": target, "source": source.as_str(), "lines": lines, "format": "ansi", "strip_ansi": false }),
            )
            .await?;
        Ok(result["read"]["text"].as_str().unwrap_or_default().to_string())
    }

    /// Submits text + Enter. Fails with `agent_blocked` if the agent waits on a prompt.
    pub async fn agent_prompt(&self, target: &str, text: &str) -> Result<Value> {
        self.call("agent.prompt", json!({ "target": target, "text": text })).await
    }

    pub async fn agent_send_keys(&self, target: &str, keys: &[&str]) -> Result<Value> {
        self.call("agent.send_keys", json!({ "target": target, "keys": keys })).await
    }

    /// Sends literal text to a pane without pressing Enter.
    pub async fn pane_send_text(&self, pane_id: &str, text: &str) -> Result<Value> {
        self.call("pane.send_text", json!({ "pane_id": pane_id, "text": text })).await
    }

    /// Creates a tab in a workspace and returns its root pane id.
    pub async fn tab_create(&self, workspace_id: &str, label: Option<&str>, cwd: Option<&str>) -> Result<String> {
        let mut params = json!({ "workspace_id": workspace_id, "label": label, "focus": false });
        if let Some(cwd) = cwd {
            params["cwd"] = json!(cwd);
        }
        let result = self.call("tab.create", params).await?;
        ["root_pane", "pane"]
            .iter()
            .find_map(|k| result[*k]["pane_id"].as_str())
            .map(str::to_string)
            .ok_or_else(|| Error::Unexpected(result.to_string()))
    }

    /// Creates a workspace (project) rooted at `cwd`. Returns its id.
    pub async fn workspace_create(&self, cwd: &str, label: Option<&str>) -> Result<String> {
        let result = self.call("workspace.create", json!({ "cwd": cwd, "label": label, "focus": false })).await?;
        result["workspace"]["workspace_id"]
            .as_str()
            .or(result["workspace_id"].as_str())
            .map(str::to_string)
            .ok_or_else(|| Error::Unexpected(result.to_string()))
    }

    /// Starts an agent CLI (`kind`: claude, codex…) in an existing shell pane.
    /// Fails with `agent_not_ready` when the agent is blocked at startup
    /// (trust dialog…): it is running, but waiting for an answer.
    pub async fn agent_start(&self, name: &str, kind: &str, pane_id: &str, args: &[String]) -> Result<AgentInfo> {
        let params = json!({ "name": name, "kind": kind, "pane_id": pane_id, "args": args, "timeout_ms": 60000 });
        let mut result = self.call_within(AGENT_START_TIMEOUT, "agent.start", params).await?;
        Ok(serde_json::from_value(result["agent"].take())?)
    }

    /// Opens a subscription. `subscriptions` follows Herdr's `Subscription`
    /// schema; `pane.agent_status_changed` requires a `pane_id`.
    pub async fn subscribe(&self, subscriptions: Vec<Value>) -> Result<Subscription> {
        with_timeout(CALL_TIMEOUT, self.subscribe_raw(subscriptions)).await
    }

    async fn subscribe_raw(&self, subscriptions: Vec<Value>) -> Result<Subscription> {
        let mut stream = UnixStream::connect(&self.socket).await?;
        let id = next_id();
        send_request(&mut stream, &id, "events.subscribe", json!({ "subscriptions": subscriptions })).await?;
        let (read, _write) = stream.into_split();
        let mut reader = BufReader::new(read);
        let mut line = String::new();
        if reader.read_line(&mut line).await? == 0 {
            return Err(Error::Closed);
        }
        let ack = parse_response(&line)?;
        if ack["type"] != "subscription_started" {
            return Err(Error::Unexpected(ack.to_string()));
        }
        Ok(Subscription { reader, _write })
    }
}

impl Client {
    /// Recovery after `events_lost`, in the order Herdr documents: open a new
    /// subscription first, then take a snapshot. The snapshot replaces the
    /// caller's cache; later events are applied on top of it.
    pub async fn resync(&self, subscriptions: Vec<Value>) -> Result<(Subscription, Snapshot)> {
        let subscription = self.subscribe(subscriptions).await?;
        let snapshot = self.snapshot().await?;
        Ok((subscription, snapshot))
    }
}

impl Snapshot {
    /// Agent status of a pane, if the pane exists and hosts an agent.
    pub fn pane_status(&self, pane_id: &str) -> Option<AgentStatus> {
        let pane = self.panes.iter().find(|p| p["pane_id"] == pane_id)?;
        serde_json::from_value(pane["agent_status"].clone()).ok()
    }
}

/// One event received on a subscription.
#[derive(Debug, Clone)]
pub struct Event {
    /// Event kind, e.g. `pane.agent_status_changed`.
    pub kind: String,
    pub data: Value,
}

impl Event {
    pub fn pane_id(&self) -> Option<&str> {
        self.data["pane_id"].as_str()
    }

    pub fn agent_status(&self) -> Option<AgentStatus> {
        serde_json::from_value(self.data["agent_status"].clone()).ok()
    }
}

pub struct Subscription {
    reader: BufReader<OwnedReadHalf>,
    _write: tokio::net::unix::OwnedWriteHalf,
}

impl Subscription {
    /// Waits for the next event. Returns `Error::Closed` when the server
    /// closes the stream and `Error::Herdr { code: "events_lost" }` when this
    /// subscriber fell behind (resync with `snapshot` then resubscribe).
    pub async fn next(&mut self) -> Result<Event> {
        loop {
            let mut line = String::new();
            if self.reader.read_line(&mut line).await? == 0 {
                return Err(Error::Closed);
            }
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            let mut msg: Value = serde_json::from_str(line)?;
            if msg.get("error").is_some() {
                return parse_response(line).map(|_| unreachable!());
            }
            // Events arrive either bare (`{"event","data"}`) or wrapped in a
            // `result`; accept both.
            let body = match msg.get_mut("result") {
                Some(result) if result.get("event").is_some() => result.take(),
                _ => msg,
            };
            if let Some(kind) = body.get("event").and_then(Value::as_str) {
                return Ok(Event { kind: kind.to_string(), data: body["data"].clone() });
            }
            if let Some(kind) = body.get("type").and_then(Value::as_str) {
                return Ok(Event { kind: kind.to_string(), data: body.clone() });
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::AsyncWriteExt;
    use tokio::net::UnixListener;

    /// Fake Herdr server: answers each connection with the given lines,
    /// keyed by the request method.
    async fn fake_server(responses: Vec<(&'static str, Vec<String>)>) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("herdr-fake-{}-{}", std::process::id(), next_id()));
        std::fs::create_dir_all(&dir).unwrap();
        let socket = dir.join("herdr.sock");
        let listener = UnixListener::bind(&socket).unwrap();
        tokio::spawn(async move {
            loop {
                let Ok((stream, _)) = listener.accept().await else { return };
                let responses = responses.clone();
                tokio::spawn(async move {
                    let (read, mut write) = stream.into_split();
                    let mut line = String::new();
                    BufReader::new(read).read_line(&mut line).await.unwrap();
                    let req: Value = serde_json::from_str(&line).unwrap();
                    let id = req["id"].as_str().unwrap().to_string();
                    let method = req["method"].as_str().unwrap();
                    let (_, lines) = responses.iter().find(|(m, _)| *m == method).unwrap();
                    for l in lines {
                        write.write_all(l.replace("$ID", &id).as_bytes()).await.unwrap();
                        write.write_all(b"\n").await.unwrap();
                    }
                    // Keep subscription connections open.
                    tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                });
            }
        });
        socket
    }

    #[tokio::test]
    async fn events_then_events_lost_then_resync() {
        let socket = fake_server(vec![
            (
                "events.subscribe",
                vec![
                    r#"{"id":"$ID","result":{"type":"subscription_started"}}"#.into(),
                    r#"{"event":"pane.agent_status_changed","data":{"pane_id":"w1:p1","workspace_id":"w1","agent_status":"working"}}"#.into(),
                    r#"{"id":"$ID","error":{"code":"events_lost","message":"subscriber fell behind"}}"#.into(),
                ],
            ),
            (
                "session.snapshot",
                vec![r#"{"id":"$ID","result":{"type":"session_snapshot","snapshot":{"panes":[{"pane_id":"w1:p1","agent_status":"blocked"}]}}}"#.into()],
            ),
        ])
        .await;
        let client = Client::new(&socket);
        let subs = vec![json!({ "type": "pane.agent_status_changed", "pane_id": "w1:p1" })];

        let mut sub = client.subscribe(subs.clone()).await.unwrap();
        let event = sub.next().await.unwrap();
        assert_eq!(event.kind, "pane.agent_status_changed");
        assert_eq!(event.agent_status(), Some(AgentStatus::Working));

        let err = sub.next().await.err().unwrap();
        assert_eq!(err.code(), Some("events_lost"));

        let (_sub, snapshot) = client.resync(subs).await.unwrap();
        assert_eq!(snapshot.pane_status("w1:p1"), Some(AgentStatus::Blocked));
        assert_eq!(snapshot.pane_status("w9:p9"), None);
    }

    #[tokio::test]
    async fn frozen_server_times_out() {
        let dir = std::env::temp_dir().join(format!("herdr-frozen-{}-{}", std::process::id(), next_id()));
        std::fs::create_dir_all(&dir).unwrap();
        let socket = dir.join("herdr.sock");
        let listener = UnixListener::bind(&socket).unwrap();
        // Accepts and never answers.
        tokio::spawn(async move {
            let mut held = Vec::new();
            while let Ok((stream, _)) = listener.accept().await {
                held.push(stream);
            }
        });
        let client = Client::new(&socket);
        let err = client.call_within(Duration::from_millis(100), "ping", json!({})).await.err().unwrap();
        assert!(matches!(err, Error::Timeout(_)));
    }

    #[test]
    fn schema_check_reports_missing_methods() {
        let variant = |m: &str| json!({ "properties": { "method": { "const": m } } });
        let all: Vec<Value> = USED_METHODS.iter().map(|m| variant(m)).collect();
        let schema = json!({ "schemas": { "request": { "oneOf": all } } });
        assert!(missing_methods(&schema).is_empty());
        let partial = json!({ "schemas": { "request": { "oneOf": [variant("ping")] } } });
        assert!(missing_methods(&partial).contains(&"agent.prompt"));
    }

    #[tokio::test]
    async fn herdr_errors_carry_their_code() {
        let socket = fake_server(vec![(
            "agent.prompt",
            vec![r#"{"id":"$ID","error":{"code":"agent_blocked","message":"agent is blocked"}}"#.into()],
        )])
        .await;
        let err = Client::new(&socket).agent_prompt("w1:p1", "hi").await.err().unwrap();
        assert_eq!(err.code(), Some("agent_blocked"));
    }
}
