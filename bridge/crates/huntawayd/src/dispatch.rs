//! `huntawayd dispatch`: starts another agent next to the calling one, for
//! orchestrator skills. Run from an agent's Herdr pane, it picks the agent
//! kind from the `[routing]` table of the config, splits the caller's pane,
//! starts the agent, sends the task and optionally waits for the answer.
//! The parent → child link is recorded for the daemon (nested agents).

use std::collections::HashMap;
use std::time::{Duration, Instant};

use anyhow::{bail, Context, Result};
use herdr_client::Client;
use huntaway_core::claude;
use huntaway_core::TimelineItem;
use serde_json::json;

use crate::config::{state_dir, Config};
use crate::engine::{agent_id, locate_transcript, read_dispatch_links};

/// Links file in the state dir: child agent id → parent agent id.
pub const LINKS_FILE: &str = "agent-links.json";
const LINKS_KEPT: usize = 500;

pub struct Dispatch {
    pub task: Option<String>,
    pub role: Option<String>,
    pub kind: Option<String>,
    pub name: Option<String>,
    pub model: Option<String>,
    pub cwd: Option<String>,
    pub wait: bool,
    pub timeout_secs: u64,
}

/// Agent kind for `role`: explicit kind, else `[routing]`, else its `default`, else Claude.
pub fn route(config: &Config, role: Option<&str>, kind: Option<&str>) -> String {
    if let Some(kind) = kind.filter(|k| !k.is_empty()) {
        return kind.to_string();
    }
    role.and_then(|r| config.routing.get(r))
        .or_else(|| config.routing.get("default"))
        .cloned()
        .unwrap_or_else(|| "claude".into())
}

/// A valid Herdr agent name (`[a-z][a-z0-9_-]{0,31}`) from `base`, with a random suffix.
fn agent_name(base: &str) -> String {
    let mut clean: String = base
        .to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '-' })
        .collect();
    if !clean.starts_with(|c: char| c.is_ascii_lowercase()) {
        clean.insert(0, 'a');
    }
    clean.truncate(26);
    format!("{clean}-{:04x}", rand::random::<u16>())
}

pub async fn run(config: &Config, d: Dispatch) -> Result<()> {
    if std::env::var("HERDR_ENV").as_deref() != Ok("1") {
        bail!("not running inside a Herdr pane (HERDR_ENV is not 1)");
    }
    let parent_pane = std::env::var("HERDR_PANE_ID").context("HERDR_PANE_ID is not set")?;
    let socket = std::env::var("HERDR_SOCKET_PATH").context("HERDR_SOCKET_PATH is not set")?;
    let session = herdr_client::discover_sessions()
        .into_iter()
        .find(|s| s.socket == std::path::Path::new(&socket))
        .map(|s| s.name)
        .unwrap_or_else(|| "default".into());
    let client = Client::new(&socket);

    let kind = route(config, d.role.as_deref(), d.kind.as_deref());
    let name = match &d.name {
        Some(n) => n.clone(),
        None => agent_name(d.role.as_deref().unwrap_or(&kind)),
    };
    let cwd = match &d.cwd {
        Some(c) => c.clone(),
        None => std::env::current_dir()?.to_string_lossy().into_owned(),
    };

    // Wide layouts first: split right while the tab has one pane, then down.
    let caller = client.agent_get(&parent_pane).await.ok();
    let siblings = match &caller {
        Some(c) => client.pane_list(Some(&c.workspace_id)).await.map(|p| p.iter().filter(|p| p.tab_id == c.tab_id).count()).unwrap_or(1),
        None => 1,
    };
    let direction = if siblings <= 1 { "right" } else { "down" };
    let pane = client.pane_split(&parent_pane, direction, Some(&cwd), &[]).await.context("cannot split the pane")?;
    let child = agent_id(&session, &pane);
    record_link(&child, &agent_id(&session, &parent_pane))?;

    let mut args = Vec::new();
    if let Some(model) = d.model.as_deref().filter(|m| !m.is_empty()) {
        args.push("--model".to_string());
        args.push(model.to_string());
    }
    let mut status = match client.agent_start(&name, &kind, &pane, &args).await {
        Ok(info) => info.agent_status.as_str().to_string(),
        Err(e) if e.code() == Some("agent_not_ready") => "blocked".to_string(),
        Err(e) => return Err(e).context(format!("cannot start {kind}")),
    };

    let mut sent = false;
    if let Some(task) = d.task.as_deref().map(str::trim).filter(|t| !t.is_empty()) {
        for _ in 0..60 {
            if kind == "claude" {
                let _ = client.agent_send_keys(&pane, claude::CLEAR_INPUT_KEYS).await;
            }
            match client.agent_prompt(&pane, task).await {
                Ok(_) => {
                    sent = true;
                    break;
                }
                Err(e) if e.code() == Some("agent_blocked") => {
                    status = "blocked".into();
                    break;
                }
                Err(e) if e.code() == Some("agent_not_ready") => tokio::time::sleep(Duration::from_millis(500)).await,
                Err(e) => return Err(e).context("cannot send the task"),
            }
        }
    }

    let mut answer = None;
    if sent && d.wait {
        status = wait_settled(&client, &pane, Duration::from_secs(d.timeout_secs)).await?;
        answer = last_answer(&client, &pane).await;
    }
    let out = json!({
        "name": name,
        "kind": kind,
        "pane_id": pane,
        "agent_id": child,
        "task_sent": sent,
        "status": status,
        "answer": answer,
    });
    println!("{}", serde_json::to_string_pretty(&out)?);
    Ok(())
}

/// Waits until the agent has worked and settled (`idle`, `done` or `blocked`).
async fn wait_settled(client: &Client, pane: &str, timeout: Duration) -> Result<String> {
    let start = Instant::now();
    let mut active = false;
    loop {
        let status = client.agent_get(pane).await.map(|i| i.agent_status.as_str().to_string()).unwrap_or_else(|_| "unknown".into());
        if status == "blocked" {
            return Ok(status);
        }
        if status == "working" {
            active = true;
        } else if matches!(status.as_str(), "idle" | "done") && (active || start.elapsed() > Duration::from_secs(10)) {
            return Ok(status);
        }
        if start.elapsed() > timeout {
            return Ok("timeout".into());
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
}

/// Last agent message of the child's transcript.
async fn last_answer(client: &Client, pane: &str) -> Option<String> {
    let info = client.agent_get(pane).await.ok()?;
    let mut tail = locate_transcript(&info)?;
    tail.poll().ok()?.into_iter().rev().find_map(|i| match i {
        TimelineItem::AssistantMessage { text, sidechain: false, .. } => Some(text),
        _ => None,
    })
}

/// Adds `child → parent` to the links file read by the daemon.
fn record_link(child: &str, parent: &str) -> Result<()> {
    let dir = state_dir();
    std::fs::create_dir_all(&dir)?;
    let path = dir.join(LINKS_FILE);
    let mut links: HashMap<String, String> = read_dispatch_links(&path);
    links.insert(child.to_string(), parent.to_string());
    if links.len() > LINKS_KEPT {
        // Pane ids grow: drop the lowest ones.
        let mut keys: Vec<String> = links.keys().cloned().collect();
        keys.sort_by_key(|k| pane_rank(k));
        for k in keys.into_iter().take(links.len() - LINKS_KEPT) {
            links.remove(&k);
        }
    }
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_string(&links)?)?;
    std::fs::rename(&tmp, &path)?;
    Ok(())
}

/// Sort key of `session:w3:p1A`: Herdr pane ids are base-36-ish counters.
fn pane_rank(id: &str) -> u64 {
    id.rsplit(":p").next().and_then(|n| u64::from_str_radix(n, 36).ok()).unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn routing_and_names() {
        let mut config = Config::default();
        assert_eq!(route(&config, Some("review"), None), "claude");
        config.routing.insert("review".into(), "codex".into());
        config.routing.insert("default".into(), "opencode".into());
        assert_eq!(route(&config, Some("review"), None), "codex");
        assert_eq!(route(&config, Some("ui"), None), "opencode");
        assert_eq!(route(&config, Some("review"), Some("claude")), "claude");
        let n = agent_name("Review UI");
        assert!(n.starts_with("review-ui-"), "{n}");
        assert!(agent_name("42").starts_with("a42-"));
    }
}
