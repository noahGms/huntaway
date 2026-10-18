//! HTTP + WebSocket API for the mobile app (PRD §16). JSON is snake_case.

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use axum::body::Bytes;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{ConnectInfo, DefaultBodyLimit, FromRequestParts, Path, Query, State};
use axum::http::request::Parts;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::sync::broadcast::error::RecvError;

use crate::auth::{Device, Identity, Store};
use crate::engine::{ActionError, CreateAgent, Engine};
use crate::history::{HistoryIndex, HistoryQuery};

pub struct AppState {
    pub engine: Arc<Engine>,
    pub store: Store,
    pub identity: Identity,
    pub history: HistoryIndex,
    pub presence: Arc<crate::presence::Presence>,
    pub listeners: Arc<crate::listen::Listeners>,
}

type Shared = Arc<AppState>;

pub fn router(state: Shared) -> Router {
    Router::new()
        .route("/healthz", get(|| async { Json(json!({ "ok": true })) }))
        .route("/v1/pair", post(pair))
        .route("/v1/machine", get(machine))
        .route("/v1/state", get(snapshot))
        .route("/v1/agents", post(create_agent))
        .route("/v1/agents/{id}", get(agent))
        .route("/v1/agents/{id}/timeline", get(timeline))
        .route("/v1/agents/{id}/messages", post(send_message))
        .route("/v1/agents/{id}/interrupt", post(interrupt))
        .route("/v1/agents/{id}/choice", post(choice))
        .route("/v1/agents/{id}/deny", post(deny))
        .route("/v1/agents/{id}/input", post(input))
        .route("/v1/agents/{id}/screen", get(screen))
        .route("/v1/agents/{id}/terminal", get(terminal))
        .route("/v1/agents/{id}/files", get(search_files))
        .route("/v1/agents/{id}/git/status", get(git_status))
        .route("/v1/agents/{id}/git/diff", get(git_diff))
        .route("/v1/workspaces", post(create_workspace))
        .route("/v1/uploads", post(upload).layer(DefaultBodyLimit::max(crate::files::UPLOAD_MAX)))
        .route("/v1/usage", get(usage))
        .route("/v1/history", get(history_list))
        .route("/v1/history/{id}", get(history_get))
        .route("/v1/history/{id}/timeline", get(history_timeline))
        .route("/v1/history/{id}/resume", post(history_resume))
        .route("/v1/push", post(register_push))
        .route("/v1/presence", post(presence))
        .route("/v1/metrics", get(metrics))
        .route("/v1/stream", get(stream))
        .with_state(state)
}

// --------------------------------------------------------------------- errors

pub struct ApiError {
    status: StatusCode,
    code: String,
    message: String,
}

impl ApiError {
    fn new(status: StatusCode, code: &str, message: impl Into<String>) -> Self {
        Self { status, code: code.into(), message: message.into() }
    }
    fn unauthorized() -> Self {
        Self::new(StatusCode::UNAUTHORIZED, "unauthorized", "token manquant ou révoqué")
    }
    fn forbidden(permission: &str) -> Self {
        Self::new(StatusCode::FORBIDDEN, "forbidden", format!("permission requise : {permission}"))
    }
    fn not_found() -> Self {
        Self::new(StatusCode::NOT_FOUND, "not_found", "agent introuvable")
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.status, Json(json!({ "error": { "code": self.code, "message": self.message } }))).into_response()
    }
}

impl From<ActionError> for ApiError {
    fn from(e: ActionError) -> Self {
        Self::new(StatusCode::from_u16(e.status).unwrap_or(StatusCode::BAD_GATEWAY), e.code, e.message)
    }
}

impl From<anyhow::Error> for ApiError {
    fn from(e: anyhow::Error) -> Self {
        Self::new(StatusCode::INTERNAL_SERVER_ERROR, "internal", e.to_string())
    }
}

type ApiResult<T> = Result<T, ApiError>;

// ----------------------------------------------------------------------- auth

/// Authenticated device, from `Authorization: Bearer <token>` or `?token=`
/// (WebSocket clients that cannot set headers).
pub struct Auth(pub Device);

impl Auth {
    fn require(&self, permission: &str) -> ApiResult<()> {
        if self.0.can(permission) {
            Ok(())
        } else {
            Err(ApiError::forbidden(permission))
        }
    }
}

impl FromRequestParts<Shared> for Auth {
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, state: &Shared) -> Result<Self, Self::Rejection> {
        let header = parts
            .headers
            .get(axum::http::header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.strip_prefix("Bearer "))
            .map(str::to_string);
        let query = parts.uri.query().and_then(|q| {
            q.split('&').find_map(|kv| kv.strip_prefix("token=")).map(|t| t.to_string())
        });
        let token = header.or(query).ok_or_else(ApiError::unauthorized)?;
        match state.store.authenticate(&token)? {
            Some(device) if device.local_only => {
                // The local token is readable by any local process, never valid from the network.
                let loopback = parts.extensions.get::<ConnectInfo<SocketAddr>>().is_some_and(|c| c.0.ip().is_loopback());
                if loopback {
                    Ok(Auth(device))
                } else {
                    Err(ApiError::unauthorized())
                }
            }
            Some(device) => Ok(Auth(device)),
            None => Err(ApiError::unauthorized()),
        }
    }
}

// --------------------------------------------------------------------- pairing

#[derive(Deserialize)]
struct PairRequest {
    code: String,
    device_name: String,
    /// Random client nonce; the bridge signs it so the app can check it
    /// talks to the bridge whose fingerprint was in the QR code.
    nonce: String,
}

async fn pair(State(state): State<Shared>, Json(req): Json<PairRequest>) -> ApiResult<Json<Value>> {
    let Some((device, token)) = state.store.redeem_pairing(&req.code, &req.device_name)? else {
        return Err(ApiError::new(StatusCode::FORBIDDEN, "invalid_code", "code de pairing invalide ou expiré"));
    };
    let machine = &state.engine.machine;
    let signed = huntaway_api::pair_signed_message(&req.nonce, &machine.machine_id, &device.id);
    tracing::info!(device = %device.name, "nouvel appareil appairé");
    Ok(Json(json!({
        "device_id": device.id,
        "token": token,
        "permissions": device.permissions,
        "machine_id": machine.machine_id,
        "machine_name": machine.machine_name,
        "public_key": state.identity.public_key_b64(),
        "signature": state.identity.sign_b64(signed.as_bytes()),
    })))
}

// ---------------------------------------------------------------------- reads

async fn machine(State(state): State<Shared>, auth: Auth) -> ApiResult<Json<Value>> {
    auth.require("agents.read")?;
    Ok(Json(json!({
        "machine": state.engine.machine,
        "seq": state.engine.current_seq(),
        "device": { "id": auth.0.id, "name": auth.0.name, "permissions": auth.0.permissions },
        "uptime_secs": state.engine.uptime_secs(),
        "sessions": state.engine.sessions(),
        "addresses": state.listeners.addresses(),
    })))
}

async fn metrics(State(state): State<Shared>, auth: Auth) -> ApiResult<Json<Value>> {
    auth.require("agents.read")?;
    Ok(Json(state.engine.metrics()))
}

async fn snapshot(State(state): State<Shared>, auth: Auth) -> ApiResult<Json<Value>> {
    auth.require("agents.read")?;
    Ok(Json(state.engine.snapshot()))
}

async fn agent(State(state): State<Shared>, auth: Auth, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    auth.require("agents.read")?;
    let view = state.engine.agent(&id).ok_or_else(ApiError::not_found)?;
    Ok(Json(serde_json::to_value(view).unwrap()))
}

#[derive(Deserialize)]
struct TimelineQuery {
    before: Option<u64>,
    limit: Option<usize>,
}

async fn timeline(State(state): State<Shared>, auth: Auth, Path(id): Path<String>, Query(q): Query<TimelineQuery>) -> ApiResult<Json<Value>> {
    auth.require("agents.read")?;
    let limit = q.limit.unwrap_or(100).clamp(1, 500);
    let items = state.engine.timeline(&id, q.before, limit).ok_or_else(ApiError::not_found)?;
    let has_more = items.first().is_some_and(|i| i.n > 0);
    Ok(Json(json!({ "items": items, "has_more": has_more })))
}

#[derive(Deserialize)]
struct ScreenQuery {
    lines: Option<u32>,
    /// `1` to also get the screen with ANSI colors.
    ansi: Option<u8>,
}

async fn screen(State(state): State<Shared>, auth: Auth, Path(id): Path<String>, Query(q): Query<ScreenQuery>) -> ApiResult<Json<Value>> {
    auth.require("terminal.read")?;
    Ok(Json(state.engine.screen(&id, q.lines, q.ansi == Some(1)).await?))
}

// -------------------------------------------------------------------- actions

#[derive(Deserialize)]
struct MessageBody {
    text: String,
}

async fn send_message(State(state): State<Shared>, auth: Auth, Path(id): Path<String>, Json(body): Json<MessageBody>) -> ApiResult<Json<Value>> {
    auth.require("agents.message")?;
    state.engine.send_message(&id, &body.text).await?;
    Ok(Json(json!({ "ok": true })))
}

#[derive(Deserialize, Default)]
struct InterruptBody {
    /// Also when the agent waits on a prompt (Esc then denies it).
    #[serde(default)]
    force: bool,
}

async fn interrupt(State(state): State<Shared>, auth: Auth, Path(id): Path<String>, body: axum::body::Bytes) -> ApiResult<Json<Value>> {
    auth.require("agents.interrupt")?;
    // The body is optional: older clients post nothing.
    let force = serde_json::from_slice::<InterruptBody>(&body).map(|b| b.force).unwrap_or_default();
    state.engine.interrupt(&id, force).await?;
    Ok(Json(json!({ "ok": true })))
}

#[derive(Deserialize)]
struct ChoiceBody {
    number: u32,
    /// Free-text answer typed into the chosen option.
    text: Option<String>,
    /// `Interaction.id` the answer is meant for.
    interaction_id: Option<String>,
}

async fn choice(State(state): State<Shared>, auth: Auth, Path(id): Path<String>, Json(body): Json<ChoiceBody>) -> ApiResult<Json<Value>> {
    auth.require("agents.approve")?;
    let keys = state.engine.choose(&id, body.number, body.text.as_deref(), body.interaction_id.as_deref()).await?;
    Ok(Json(json!({ "ok": true, "keys": keys })))
}

#[derive(Deserialize)]
struct DenyBody {
    text: Option<String>,
    interaction_id: Option<String>,
}

async fn deny(State(state): State<Shared>, auth: Auth, Path(id): Path<String>, Json(body): Json<DenyBody>) -> ApiResult<Json<Value>> {
    auth.require("agents.approve")?;
    let message_sent = state.engine.deny(&id, body.text.as_deref(), body.interaction_id.as_deref()).await?;
    Ok(Json(json!({ "ok": true, "message_sent": message_sent })))
}

#[derive(Deserialize)]
struct InputBody {
    text: Option<String>,
    #[serde(default)]
    keys: Vec<String>,
}

async fn input(State(state): State<Shared>, auth: Auth, Path(id): Path<String>, Json(body): Json<InputBody>) -> ApiResult<Json<Value>> {
    auth.require("agents.input")?;
    state.engine.input(&id, body.text.as_deref(), &body.keys).await?;
    Ok(Json(json!({ "ok": true })))
}

#[derive(Deserialize)]
struct CreateAgentBody {
    session: String,
    workspace_id: String,
    kind: String,
    #[serde(default)]
    prompt: String,
    /// Model passed as `--model`.
    model: Option<String>,
    /// Directory of the new tab (defaults to the workspace's).
    cwd: Option<String>,
}

async fn create_agent(State(state): State<Shared>, auth: Auth, Json(body): Json<CreateAgentBody>) -> ApiResult<Json<Value>> {
    auth.require("agents.create")?;
    let req = CreateAgent {
        session: &body.session,
        workspace_id: &body.workspace_id,
        kind: &body.kind,
        prompt: &body.prompt,
        model: body.model.as_deref(),
        cwd: body.cwd.as_deref(),
    };
    let (id, prompt_sent) = state.engine.create_agent(&req).await?;
    Ok(Json(json!({ "ok": true, "agent_id": id, "prompt_sent": prompt_sent })))
}

#[derive(Deserialize)]
struct CreateWorkspaceBody {
    session: String,
    cwd: String,
    label: Option<String>,
}

async fn create_workspace(State(state): State<Shared>, auth: Auth, Json(body): Json<CreateWorkspaceBody>) -> ApiResult<Json<Value>> {
    auth.require("agents.create")?;
    let id = state.engine.create_workspace(&body.session, &body.cwd, body.label.as_deref()).await?;
    Ok(Json(json!({ "ok": true, "workspace_id": id })))
}

// ---------------------------------------------------------------- usage

async fn usage(State(state): State<Shared>, auth: Auth) -> ApiResult<Json<Value>> {
    auth.require("agents.read")?;
    let snapshot = state.engine.snapshot();
    let mut total = huntaway_api::Usage::default();
    let mut cost = 0.0;
    let mut agents = Vec::new();
    for agent in snapshot["agents"].as_array().into_iter().flatten() {
        let Some(u) = agent.get("usage").filter(|u| !u.is_null()) else { continue };
        let Ok(u) = serde_json::from_value::<huntaway_api::Usage>(u.clone()) else { continue };
        total.input_tokens += u.input_tokens;
        total.output_tokens += u.output_tokens;
        total.cache_read_tokens += u.cache_read_tokens;
        total.cache_write_tokens += u.cache_write_tokens;
        cost += u.cost_usd.unwrap_or(0.0);
        if total.rate_limits.is_none() {
            total.rate_limits = u.rate_limits.clone();
        }
        agents.push(json!({ "agent_id": agent["id"], "usage": u }));
    }
    total.cost_usd = Some((cost * 10_000.0).round() / 10_000.0);
    Ok(Json(json!({ "agents": agents, "total": total })))
}

// -------------------------------------------------------------- history

#[derive(Deserialize)]
struct HistoryParams {
    before: Option<u64>,
    limit: Option<usize>,
    project: Option<String>,
    kind: Option<String>,
    q: Option<String>,
}

async fn history_list(State(state): State<Shared>, auth: Auth, Query(p): Query<HistoryParams>) -> ApiResult<Json<Value>> {
    auth.require("history.read")?;
    let query = HistoryQuery { before: p.before, limit: p.limit.unwrap_or(50).clamp(1, 200), project: p.project, kind: p.kind, q: p.q };
    let live = state.engine.live_sessions();
    let st = state.clone();
    let page = tokio::task::spawn_blocking(move || st.history.page(&query, &live)).await.map_err(|e| anyhow::anyhow!(e))?;
    Ok(Json(serde_json::to_value(page).unwrap()))
}

fn history_not_found() -> ApiError {
    ApiError::new(StatusCode::NOT_FOUND, "not_found", "conversation introuvable")
}

async fn history_get(State(state): State<Shared>, auth: Auth, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    auth.require("history.read")?;
    let live = state.engine.live_sessions();
    let st = state.clone();
    let found = tokio::task::spawn_blocking(move || st.history.get(&id, &live)).await.map_err(|e| anyhow::anyhow!(e))?;
    let (_, entry) = found.ok_or_else(history_not_found)?;
    Ok(Json(serde_json::to_value(entry).unwrap()))
}

async fn history_timeline(State(state): State<Shared>, auth: Auth, Path(id): Path<String>, Query(q): Query<TimelineQuery>) -> ApiResult<Json<Value>> {
    auth.require("history.read")?;
    let limit = q.limit.unwrap_or(100).clamp(1, 500);
    let page = tokio::task::spawn_blocking(move || {
        let found = huntaway_core::history::find(&id)?;
        state.history.timeline(&found, q.before, limit).ok()
    })
    .await
    .map_err(|e| anyhow::anyhow!(e))?
    .ok_or_else(history_not_found)?;
    Ok(Json(serde_json::to_value(page).unwrap()))
}

#[derive(Deserialize, Default)]
struct ResumeBody {
    session: Option<String>,
    workspace_id: Option<String>,
    #[serde(default)]
    prompt: String,
}

async fn history_resume(State(state): State<Shared>, auth: Auth, Path(id): Path<String>, body: Option<Json<ResumeBody>>) -> ApiResult<Json<Value>> {
    auth.require("agents.resume")?;
    let body = body.map(|b| b.0).unwrap_or_default();
    let live = state.engine.live_sessions();
    let st = state.clone();
    let lookup = id.clone();
    let (found, entry) = tokio::task::spawn_blocking(move || st.history.get(&lookup, &live))
        .await
        .map_err(|e| anyhow::anyhow!(e))?
        .ok_or_else(history_not_found)?;
    if let Some(agent_id) = entry.live_agent_id {
        return Ok(Json(json!({ "ok": true, "agent_id": agent_id, "prompt_sent": false, "already_running": true })));
    }
    let (agent_id, prompt_sent) = state
        .engine
        .resume(&found, entry.cwd.as_deref(), body.session.as_deref(), body.workspace_id.as_deref(), &body.prompt)
        .await?;
    Ok(Json(json!({ "ok": true, "agent_id": agent_id, "prompt_sent": prompt_sent })))
}

// ---------------------------------------------------------------- files

#[derive(Deserialize)]
struct FilesQuery {
    #[serde(default)]
    q: String,
    limit: Option<usize>,
}

async fn search_files(State(state): State<Shared>, auth: Auth, Path(id): Path<String>, Query(q): Query<FilesQuery>) -> ApiResult<Json<Value>> {
    auth.require("files.read")?;
    let cwd = state.engine.agent_cwd(&id)?;
    let limit = q.limit.unwrap_or(50).clamp(1, 200);
    let files = tokio::task::spawn_blocking(move || crate::files::search(std::path::Path::new(&cwd), &q.q, limit))
        .await
        .map_err(|e| anyhow::anyhow!(e))?;
    Ok(Json(json!({ "files": files })))
}

async fn git_status(State(state): State<Shared>, auth: Auth, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    auth.require("files.read")?;
    let cwd = state.engine.agent_cwd(&id)?;
    let status = tokio::task::spawn_blocking(move || crate::files::git_status(std::path::Path::new(&cwd)))
        .await
        .map_err(|e| anyhow::anyhow!(e))?
        .map_err(|e| ApiError::new(StatusCode::CONFLICT, "not_a_git_repo", e))?;
    Ok(Json(serde_json::to_value(status).unwrap()))
}

#[derive(Deserialize)]
struct DiffQuery {
    path: Option<String>,
}

async fn git_diff(State(state): State<Shared>, auth: Auth, Path(id): Path<String>, Query(q): Query<DiffQuery>) -> ApiResult<Json<Value>> {
    auth.require("files.read")?;
    let cwd = state.engine.agent_cwd(&id)?;
    let diff = tokio::task::spawn_blocking(move || crate::files::git_diff(std::path::Path::new(&cwd), q.path.as_deref()))
        .await
        .map_err(|e| anyhow::anyhow!(e))?
        .map_err(|e| ApiError::new(StatusCode::CONFLICT, "git_error", e))?;
    Ok(Json(json!({ "diff": diff })))
}

#[derive(Deserialize)]
struct UploadQuery {
    name: Option<String>,
}

async fn upload(auth: Auth, Query(q): Query<UploadQuery>, body: Bytes) -> ApiResult<Json<Value>> {
    auth.require("agents.message")?;
    if body.is_empty() {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, "empty_upload", "fichier vide"));
    }
    let name = q.name.unwrap_or_else(|| "fichier".into());
    let path = tokio::task::spawn_blocking(move || crate::files::save_upload(&name, &body))
        .await
        .map_err(|e| anyhow::anyhow!(e))?
        .map_err(|e| anyhow::anyhow!(e))?;
    Ok(Json(json!({ "path": path.to_string_lossy() })))
}

#[derive(Deserialize)]
struct PushBody {
    /// UnifiedPush endpoint URL, or null to unregister.
    endpoint: Option<String>,
}

async fn register_push(State(state): State<Shared>, auth: Auth, Json(body): Json<PushBody>) -> ApiResult<Json<Value>> {
    if let Some(endpoint) = &body.endpoint {
        if !(endpoint.starts_with("https://") || endpoint.starts_with("http://")) {
            return Err(ApiError::new(StatusCode::BAD_REQUEST, "invalid_endpoint", "endpoint http(s) attendu"));
        }
    }
    state.store.set_push_endpoint(&auth.0.id, body.endpoint)?;
    Ok(Json(json!({ "ok": true })))
}

#[derive(Deserialize)]
struct PresenceBody {
    active: bool,
}

/// Desktop app focused (`active: true`, repeated every 30 s) or not.
async fn presence(State(state): State<Shared>, auth: Auth, Json(body): Json<PresenceBody>) -> ApiResult<Json<Value>> {
    auth.require("agents.read")?;
    state.presence.set(&auth.0.id, body.active);
    Ok(Json(json!({ "ok": true, "ttl_secs": crate::presence::PRESENCE_TTL.as_secs() })))
}

// ----------------------------------------------------------------- websocket

#[derive(Deserialize)]
struct StreamQuery {
    since: Option<u64>,
    epoch: Option<String>,
}

async fn stream(State(state): State<Shared>, auth: Auth, Query(q): Query<StreamQuery>, ws: WebSocketUpgrade) -> ApiResult<Response> {
    auth.require("agents.read")?;
    Ok(ws.on_upgrade(move |socket| serve_stream(socket, state, q)))
}

/// Sends `hello`, replays missed events (or `resync_required`), then live events.
async fn serve_stream(socket: WebSocket, state: Shared, q: StreamQuery) {
    let engine = &state.engine;
    let (mut tx, mut rx) = socket.split();
    // Subscribe before reading the journal so nothing falls in between.
    let mut live = engine.subscribe();

    let mut last = engine.current_seq();
    let resync = match (q.since, q.epoch.as_deref()) {
        (Some(since), Some(epoch)) if epoch == engine.machine.epoch => match engine.replay(since) {
            Some(events) => {
                last = since;
                let hello = json!({ "type": "hello", "epoch": engine.machine.epoch, "seq": engine.current_seq(), "resync_required": false });
                if tx.send(Message::Text(hello.to_string().into())).await.is_err() {
                    return;
                }
                for event in events {
                    last = event.seq;
                    if tx.send(Message::Text(serde_json::to_string(&event).unwrap().into())).await.is_err() {
                        return;
                    }
                }
                false
            }
            None => true,
        },
        _ => true,
    };
    if resync {
        // Client must GET /v1/state, then reconnect with the returned seq.
        let hello = json!({ "type": "hello", "epoch": engine.machine.epoch, "seq": engine.current_seq(), "resync_required": true });
        if tx.send(Message::Text(hello.to_string().into())).await.is_err() {
            return;
        }
    }

    let mut heartbeat = tokio::time::interval(Duration::from_secs(20));
    loop {
        tokio::select! {
            event = live.recv() => match event {
                Ok(event) if event.seq <= last => {}
                Ok(event) => {
                    last = event.seq;
                    if tx.send(Message::Text(serde_json::to_string(&event).unwrap().into())).await.is_err() {
                        return;
                    }
                }
                Err(RecvError::Lagged(_)) => {
                    let msg = json!({ "type": "hello", "epoch": engine.machine.epoch, "seq": engine.current_seq(), "resync_required": true });
                    let _ = tx.send(Message::Text(msg.to_string().into())).await;
                    return;
                }
                Err(RecvError::Closed) => return,
            },
            _ = heartbeat.tick() => {
                if tx.send(Message::Ping(Vec::new().into())).await.is_err() {
                    return;
                }
            }
            incoming = rx.next() => match incoming {
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => return,
                _ => {}
            },
        }
    }
}

// ------------------------------------------------------------- terminal

const TERMINAL_REFRESH: Duration = Duration::from_millis(250);

/// Live view of an agent's pane: Herdr has no output stream, so the screen
/// is read a few times per second and sent when it changes. Client messages
/// `{"text"?, "keys"?}` are typed into the pane (permission `agents.input`).
async fn terminal(State(state): State<Shared>, auth: Auth, Path(id): Path<String>, ws: WebSocketUpgrade) -> ApiResult<Response> {
    auth.require("terminal.read")?;
    state.engine.agent(&id).ok_or_else(ApiError::not_found)?;
    let can_input = auth.0.can("agents.input");
    Ok(ws.on_upgrade(move |socket| serve_terminal(socket, state, id, can_input)))
}

async fn serve_terminal(socket: WebSocket, state: Shared, id: String, can_input: bool) {
    let (mut tx, mut rx) = socket.split();
    let mut last = String::new();
    let mut refresh = tokio::time::interval(TERMINAL_REFRESH);
    let mut heartbeat = tokio::time::interval(Duration::from_secs(20));
    loop {
        tokio::select! {
            _ = refresh.tick() => {
                let screen = match state.engine.screen(&id, None, true).await {
                    Ok(v) => v,
                    Err(e) => {
                        let msg = json!({ "type": "error", "code": e.code, "message": e.message });
                        let _ = tx.send(Message::Text(msg.to_string().into())).await;
                        return;
                    }
                };
                let ansi = screen["ansi"].as_str().unwrap_or_default().to_string();
                if ansi != last {
                    let msg = json!({ "type": "screen", "ansi": ansi, "text": screen["text"] });
                    last = ansi;
                    if tx.send(Message::Text(msg.to_string().into())).await.is_err() {
                        return;
                    }
                }
            }
            _ = heartbeat.tick() => {
                if tx.send(Message::Ping(Vec::new().into())).await.is_err() {
                    return;
                }
            }
            incoming = rx.next() => match incoming {
                Some(Ok(Message::Text(text))) => {
                    if !can_input {
                        let msg = json!({ "type": "error", "code": "forbidden", "message": "permission requise : agents.input" });
                        let _ = tx.send(Message::Text(msg.to_string().into())).await;
                        continue;
                    }
                    let Ok(body) = serde_json::from_str::<InputBody>(&text) else { continue };
                    if let Err(e) = state.engine.input(&id, body.text.as_deref(), &body.keys).await {
                        let msg = json!({ "type": "error", "code": e.code, "message": e.message });
                        let _ = tx.send(Message::Text(msg.to_string().into())).await;
                    }
                    refresh.reset_immediately();
                }
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => return,
                _ => {}
            },
        }
    }
}
