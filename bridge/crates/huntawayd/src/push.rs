//! Push delivery through UnifiedPush endpoints (PRD §12.3).
//!
//! UnifiedPush endpoints are plain HTTPS URLs (ntfy or another distributor);
//! a POST delivers the body to the app. The payload stays minimal (PRD §12.4):
//! it goes through a third-party relay in clear, so it only names the
//! machine, the agent and the kind of event, with a generic title. The app
//! fetches the details from the bridge. Notifications raised within a short
//! window are grouped into one push.

use std::sync::Arc;
use std::time::Duration;

use futures_util::future::join_all;
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
            warn!(error = %e, "HTTP client unavailable, push disabled");
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
            info!(count = batch.len(), "desktop app active: no push");
            continue;
        }
        let payload = payload(&machine_id, &batch);

        let devices = match store.devices() {
            Ok(d) => d.devices,
            Err(e) => {
                warn!(error = %e, "cannot read devices");
                continue;
            }
        };
        // All devices at once: one slow endpoint must not delay the others.
        let sends = devices.into_iter().filter(|d| d.can("agents.read")).filter_map(|device| {
            let endpoint = device.push_endpoint.clone()?;
            let request = client.post(&endpoint).header("TTL", "86400").json(&payload).send();
            Some(async move { (device.name, endpoint, request.await) })
        });
        for (device, endpoint, result) in join_all(sends).await {
            match result {
                Ok(resp) if resp.status().is_success() => info!(%device, count = batch.len(), "push sent"),
                // The distributor forgot this endpoint (app uninstalled, unregistered).
                Ok(resp) if matches!(resp.status().as_u16(), 404 | 410) => {
                    warn!(%device, status = %resp.status(), "push endpoint gone, unregistered");
                    if let Err(e) = store.drop_push_endpoint(&endpoint) {
                        warn!(error = %e, "cannot unregister the push endpoint");
                    }
                }
                Ok(resp) => warn!(%device, status = %resp.status(), "push refused"),
                Err(e) => warn!(%device, error = %e, "push failed"),
            }
        }
    }
}

/// One notification as is; several become a summary that opens the most
/// urgent agent (blocked first). No message content: titles are generic.
fn payload(machine_id: &str, batch: &[Notification]) -> Value {
    if let [n] = batch {
        return json!({
            "v": 1, "machine_id": machine_id, "agent_id": n.agent_id,
            "kind": n.kind, "interaction_id": n.interaction_id, "title": n.title,
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
        format!("{blocked} agents need you")
    } else if blocked == 1 {
        format!("{} (+{} more)", lead.title, batch.len() - 1)
    } else {
        format!("{} agent notifications", batch.len())
    };
    json!({
        "v": 1, "machine_id": machine_id, "agent_id": lead.agent_id,
        "kind": lead.kind, "interaction_id": lead.interaction_id, "title": title, "count": batch.len(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn n(agent: &str, kind: &str, body: &str) -> Notification {
        Notification { id: "x".into(), agent_id: agent.into(), kind: kind.into(), title: format!("{kind} title"), body: body.into(), interaction_id: None }
    }

    #[test]
    fn single_notification_carries_no_content() {
        let mut one = n("a", "blocked", "api · Approval: Bash rm -rf");
        one.interaction_id = Some("toolu_1".into());
        let p = payload("m", &[one]);
        assert_eq!(p["title"], "blocked title");
        assert_eq!(p["interaction_id"], "toolu_1");
        assert!(p.get("body").is_none());
        assert!(p.get("count").is_none());
    }

    #[test]
    fn several_are_grouped_and_open_the_blocked_agent() {
        let p = payload("m", &[n("a", "done", "web · done"), n("b", "blocked", "api · Bash x"), n("c", "blocked", "app · ?")]);
        assert_eq!(p["title"], "2 agents need you");
        assert_eq!(p["agent_id"], "b");
        assert!(p.get("body").is_none());
        assert_eq!(p["count"], 3);
    }
}
