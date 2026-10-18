//! Push delivery through UnifiedPush endpoints (PRD §12.3).
//!
//! UnifiedPush endpoints are plain HTTPS URLs (ntfy or another distributor);
//! a POST delivers the body to the app. The payload stays minimal (PRD §12.4):
//! the app fetches details from the bridge when opened. Notifications raised
//! within a short window are grouped into one push.

use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};
use tokio::sync::mpsc;
use tracing::{info, warn};

use crate::auth::Store;
use crate::engine::Notification;
use crate::presence::Presence;

/// Notifications arriving within this window after the first are grouped.
const GROUP_WINDOW: Duration = Duration::from_secs(2);

pub async fn run(mut rx: mpsc::UnboundedReceiver<Notification>, store: Store, machine_id: String, presence: Arc<Presence>) {
    let client = match reqwest::Client::builder().timeout(Duration::from_secs(10)).build() {
        Ok(client) => client,
        Err(e) => {
            warn!(error = %e, "client HTTP indisponible, push désactivé");
            return;
        }
    };
    while let Some(first) = rx.recv().await {
        let mut batch = vec![first];
        let deadline = tokio::time::Instant::now() + GROUP_WINDOW;
        while let Ok(Some(n)) = tokio::time::timeout_at(deadline, rx.recv()).await {
            batch.push(n);
        }
        // The desktop app in front of the user already showed it.
        if presence.desktop_active() {
            info!(count = batch.len(), "app desktop active : pas de push");
            continue;
        }
        let payload = payload(&machine_id, &batch);

        let devices = match store.devices() {
            Ok(d) => d.devices,
            Err(e) => {
                warn!(error = %e, "lecture des appareils impossible");
                continue;
            }
        };
        for device in devices.into_iter().filter(|d| d.can("agents.read")) {
            let Some(endpoint) = device.push_endpoint else { continue };
            match client.post(&endpoint).header("TTL", "86400").json(&payload).send().await {
                Ok(resp) if resp.status().is_success() => info!(device = %device.name, count = batch.len(), "push envoyé"),
                Ok(resp) => warn!(device = %device.name, status = %resp.status(), "push refusé"),
                Err(e) => warn!(device = %device.name, error = %e, "push impossible"),
            }
        }
    }
}

/// One notification as is; several become a summary that opens the most
/// urgent agent (blocked first).
fn payload(machine_id: &str, batch: &[Notification]) -> Value {
    if let [n] = batch {
        return json!({
            "v": 1, "machine_id": machine_id, "agent_id": n.agent_id,
            "kind": n.kind, "title": n.title, "body": n.body,
        });
    }
    let rank = |n: &Notification| match n.kind.as_str() {
        "blocked" => 0,
        "error" => 1,
        _ => 2,
    };
    let lead = batch.iter().min_by_key(|n| rank(n)).expect("non-empty batch");
    let blocked = batch.iter().filter(|n| n.kind == "blocked").count();
    let title = if blocked > 1 {
        format!("{blocked} agents ont besoin de toi")
    } else if blocked == 1 {
        format!("{} · et {} autre(s)", lead.title, batch.len() - 1)
    } else {
        format!("{} notifications d'agents", batch.len())
    };
    let body = batch.iter().map(|n| n.body.split(" · ").next().unwrap_or(&n.body).to_string()).collect::<Vec<_>>().join(", ");
    json!({
        "v": 1, "machine_id": machine_id, "agent_id": lead.agent_id,
        "kind": lead.kind, "title": title, "body": body, "count": batch.len(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn n(agent: &str, kind: &str, body: &str) -> Notification {
        Notification { id: "x".into(), agent_id: agent.into(), kind: kind.into(), title: format!("{kind} title"), body: body.into(), interaction_id: None }
    }

    #[test]
    fn single_notification_is_passed_through() {
        let p = payload("m", &[n("a", "done", "api · ok")]);
        assert_eq!(p["title"], "done title");
        assert_eq!(p["body"], "api · ok");
        assert!(p.get("count").is_none());
    }

    #[test]
    fn several_are_grouped_and_open_the_blocked_agent() {
        let p = payload("m", &[n("a", "done", "web · fini"), n("b", "blocked", "api · Bash x"), n("c", "blocked", "app · ?")]);
        assert_eq!(p["title"], "2 agents ont besoin de toi");
        assert_eq!(p["agent_id"], "b");
        assert_eq!(p["body"], "web, api, app");
        assert_eq!(p["count"], 3);
    }
}
