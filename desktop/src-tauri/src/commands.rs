//! Tauri commands called by the front end. API calls go through a generic
//! proxy (`api_get` / `api_post`) so the front end never sees tokens.

use base64::Engine as _;
use huntaway_client::pairing;
use huntaway_client::terminal::{self, TerminalEvent, TerminalInput};
use serde::Serialize;
use serde_json::{json, Value};
use tauri::ipc::Channel;
use tauri::{Emitter, State};

use crate::local::{self, LocalStatus};
use crate::machines::{error_value, now_secs, MachineView, Shared};
use crate::storage::{MachineRecord, Settings};

type CmdResult<T> = Result<T, Value>;

fn err(message: impl Into<String>) -> Value {
    json!({ "status": 0, "code": "app_error", "message": message.into() })
}

/// API paths only: no scheme or host from the front end.
fn check_path(path: &str) -> CmdResult<()> {
    if path.starts_with("/v1/") && !path.contains("://") {
        Ok(())
    } else {
        Err(err(format!("path refused: {path}")))
    }
}

#[tauri::command]
pub fn list_machines(machines: State<'_, Shared>) -> Vec<MachineView> {
    machines.views()
}

#[tauri::command]
pub async fn api_get(machines: State<'_, Shared>, machine_id: String, path: String) -> CmdResult<Value> {
    check_path(&path)?;
    tracing::debug!(%machine_id, %path, "GET");
    let client = machines.client(&machine_id).map_err(err)?;
    client.get(&path).await.map_err(|e| error_value(&e))
}

#[tauri::command]
pub async fn api_post(machines: State<'_, Shared>, machine_id: String, path: String, body: Option<Value>) -> CmdResult<Value> {
    check_path(&path)?;
    tracing::debug!(%machine_id, %path, "POST");
    let client = machines.client(&machine_id).map_err(err)?;
    client.post(&path, body.unwrap_or_else(|| json!({}))).await.map_err(|e| error_value(&e))
}

/// Uploads a local file (drag and drop); returns its path on the machine.
#[tauri::command]
pub async fn upload_file(machines: State<'_, Shared>, machine_id: String, path: String) -> CmdResult<String> {
    let client = machines.client(&machine_id).map_err(err)?;
    let bytes = tokio::fs::read(&path).await.map_err(|e| err(e.to_string()))?;
    let name = std::path::Path::new(&path).file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| "file".into());
    client.upload(&name, bytes).await.map_err(|e| error_value(&e))
}

/// Uploads pasted data (base64); returns its path on the machine.
#[tauri::command]
pub async fn upload_data(machines: State<'_, Shared>, machine_id: String, name: String, data_base64: String) -> CmdResult<String> {
    let client = machines.client(&machine_id).map_err(err)?;
    let bytes = base64::engine::general_purpose::STANDARD.decode(data_base64.as_bytes()).map_err(|e| err(e.to_string()))?;
    client.upload(&name, bytes).await.map_err(|e| error_value(&e))
}

#[derive(Serialize)]
pub struct PairPreview {
    machine_id: String,
    machine_name: String,
    addresses: Vec<String>,
    fingerprint: String,
}

/// Decodes a pairing link without using it.
#[tauri::command]
pub fn inspect_pairing(link: String) -> CmdResult<PairPreview> {
    let p = pairing::parse(&link).map_err(|e| err(e.to_string()))?;
    Ok(PairPreview { machine_id: p.machine_id, machine_name: p.machine_name, addresses: p.addresses, fingerprint: p.fingerprint })
}

#[tauri::command]
pub async fn pair_machine(app: tauri::AppHandle, machines: State<'_, Shared>, link: String) -> CmdResult<MachineRecord> {
    let payload = pairing::parse(&link).map_err(|e| err(e.to_string()))?;
    let mut saved = machines.storage.machines();
    if let Some(existing) = saved.iter().find(|r| r.machine_id == payload.machine_id) {
        // Same machine id with another key: refuse rather than trust it silently.
        if let Some(key) = &existing.public_key {
            let fp = base64::engine::general_purpose::STANDARD.decode(key).map(|k| pairing::fingerprint(&k)).unwrap_or_default();
            if fp != payload.fingerprint {
                return Err(err("this machine's identity changed: remove it in Servers first"));
            }
        }
    }
    let paired = pairing::pair(&payload, &local::device_name()).await.map_err(|e| error_value(&e))?;
    let record = MachineRecord {
        machine_id: paired.machine_id.clone(),
        name: paired.machine_name.clone(),
        addresses: paired.addresses.clone(),
        public_key: Some(paired.public_key.clone()),
        device_id: Some(paired.device_id.clone()),
        permissions: paired.permissions.clone(),
        local: false,
        added_at: now_secs(),
    };
    machines.storage.set_token(&record.machine_id, &paired.token).map_err(err)?;
    saved.retain(|r| r.machine_id != record.machine_id);
    saved.push(record.clone());
    machines.storage.save_machines(&saved).map_err(err)?;
    // The local daemon keeps its local connection.
    let is_local = machines.views().iter().any(|v| v.record.local && v.record.machine_id == record.machine_id);
    if !is_local {
        machines.disconnect(&record.machine_id);
        machines.connect(record.clone(), paired.token);
    }
    // Listed right away, before its first event.
    app.emit("machines-changed", ()).ok();
    Ok(record)
}

#[tauri::command]
pub fn forget_machine(app: tauri::AppHandle, machines: State<'_, Shared>, machine_id: String) -> CmdResult<()> {
    machines.disconnect(&machine_id);
    let mut saved = machines.storage.machines();
    saved.retain(|r| r.machine_id != machine_id);
    machines.storage.save_machines(&saved).map_err(err)?;
    machines.storage.delete_token(&machine_id);
    app.emit("machines-changed", ()).ok();
    Ok(())
}

#[tauri::command]
pub fn rename_machine(machines: State<'_, Shared>, machine_id: String, name: String) -> CmdResult<()> {
    machines.rename(&machine_id, name.trim()).map_err(err)
}

#[tauri::command]
pub fn reconnect_machine(machines: State<'_, Shared>, machine_id: String) -> CmdResult<()> {
    machines.reconnect(&machine_id).map_err(err)
}

#[tauri::command]
pub fn local_status() -> LocalStatus {
    local::status()
}

#[tauri::command]
pub async fn start_local_daemon(machines: State<'_, Shared>) -> CmdResult<bool> {
    tokio::task::spawn_blocking(local::start_service).await.map_err(|e| err(e.to_string()))?.map_err(err)?;
    for _ in 0..20 {
        if machines.refresh_local().await {
            return Ok(true);
        }
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    }
    Ok(false)
}

#[tauri::command]
pub async fn refresh_local(machines: State<'_, Shared>) -> CmdResult<bool> {
    Ok(machines.refresh_local().await)
}

/// Conversation on screen: its notifications are skipped while the window is focused.
#[tauri::command]
pub fn set_focus(machines: State<'_, Shared>, machine_id: Option<String>, agent_id: Option<String>) {
    let mut focus = machines.focus.lock().unwrap();
    focus.machine_id = machine_id;
    focus.agent_id = agent_id;
}

#[tauri::command]
pub fn get_settings(machines: State<'_, Shared>) -> Settings {
    machines.settings.lock().unwrap().clone()
}

#[tauri::command]
pub fn set_settings(machines: State<'_, Shared>, settings: Settings) -> CmdResult<()> {
    machines.storage.save_settings(&settings).map_err(err)?;
    *machines.settings.lock().unwrap() = settings;
    Ok(())
}

#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum TerminalMessage {
    Screen { ansi: String },
    Error { code: String, message: String },
    Closed,
}

#[tauri::command]
pub async fn open_terminal(machines: State<'_, Shared>, machine_id: String, agent_id: String, on_event: Channel<TerminalMessage>) -> CmdResult<()> {
    let client = machines.client(&machine_id).map_err(err)?;
    let ticket = machines.begin_terminal(&machine_id, &agent_id);
    let (handle, mut rx) = terminal::open(&client, &agent_id).await.map_err(|e| error_value(&e))?;
    // Closed while it was opening: the handle is dropped, which closes it.
    if !machines.set_terminal(&machine_id, &agent_id, ticket, handle) {
        return Ok(());
    }
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            let msg = match event {
                TerminalEvent::Screen { ansi } => TerminalMessage::Screen { ansi },
                TerminalEvent::Error { code, message } => TerminalMessage::Error { code, message },
                TerminalEvent::Closed => TerminalMessage::Closed,
            };
            let closed = matches!(msg, TerminalMessage::Closed);
            if on_event.send(msg).is_err() || closed {
                break;
            }
        }
    });
    Ok(())
}

#[tauri::command]
pub fn close_terminal(machines: State<'_, Shared>, machine_id: String, agent_id: String) {
    machines.close_terminal(&machine_id, &agent_id);
}

#[tauri::command]
pub fn terminal_input(machines: State<'_, Shared>, machine_id: String, agent_id: String, text: Option<String>, keys: Option<Vec<String>>) -> CmdResult<()> {
    machines.terminal_input(&machine_id, &agent_id, TerminalInput { text, keys: keys.unwrap_or_default() }).map_err(err)
}

/// Sample approval notification (Settings → Test): the chosen action comes
/// back as a `notification-test` event instead of being sent to an agent.
#[tauri::command]
pub fn test_notification(app: tauri::AppHandle) {
    crate::notify::show(crate::notify::Pending {
        app,
        client: huntaway_client::Client::new(vec![], String::new()),
        machine_id: String::new(),
        machine_name: "Test".into(),
        notification: huntaway_api::Notification {
            id: "test".into(),
            agent_id: "test".into(),
            kind: "blocked".into(),
            title: "Claude needs you".into(),
            body: "Approval: Bash npm test".into(),
            interaction_id: Some("test".into()),
        },
        approve: Some(1),
        sound: true,
        test: true,
    });
}
