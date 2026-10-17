//! Native notifications with actions: « Approuver » / « Refuser » for a
//! permission prompt, and a click opens the conversation. macOS goes through
//! NSUserNotification, Linux through freedesktop notifications (D-Bus);
//! elsewhere, or if the system refuses, the Tauri notification plugin is used.

use huntaway_api::{AgentView, Notification};
use huntaway_client::Client;
use serde_json::json;
use tauri::{AppHandle, Emitter};
use tauri_plugin_notification::NotificationExt;

/// Option chosen by « Approuver »: the first one of the menu (« Yes »).
pub fn approve_option(agent: Option<&AgentView>) -> Option<u32> {
    let interaction = agent?.interaction.as_ref()?;
    if interaction.reason != huntaway_api::BlockedReason::Approval {
        return None;
    }
    let first = interaction.options.first()?;
    let label = first.label.to_lowercase();
    (label.starts_with("yes") || label.starts_with("oui") || label.starts_with("allow") || label.starts_with("approve")).then_some(first.number)
}

/// What a click in a notification asks for.
#[derive(Debug, Clone, PartialEq)]
pub enum Action {
    Approve(u32),
    Deny,
    Open,
    Nothing,
}

/// Maps the notification response (button label, close button, click) to an action.
pub fn action_for(response: Response, approve: Option<u32>) -> Action {
    match (response, approve) {
        (Response::MainButton, Some(n)) => Action::Approve(n),
        (Response::CloseButton, Some(_)) => Action::Deny,
        (Response::Click, _) => Action::Open,
        _ => Action::Nothing,
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Response {
    MainButton,
    CloseButton,
    Click,
    Dismissed,
}

pub struct Pending {
    pub app: AppHandle,
    pub client: Client,
    pub machine_id: String,
    pub machine_name: String,
    pub notification: Notification,
    pub approve: Option<u32>,
    pub sound: bool,
    /// Test notification (Settings): report the action instead of doing it.
    pub test: bool,
}

fn open_conversation(app: &AppHandle, machine_id: &str, agent_id: &str) {
    crate::tray::show_window(app);
    app.emit("open-conversation", json!({ "machine_id": machine_id, "agent_id": agent_id })).ok();
}

pub fn show(p: Pending) {
    // Waiting for the user's answer blocks: one thread per notification.
    std::thread::spawn(move || {
        if let Err(fallback) = show_native(&p) {
            tracing::debug!(error = %fallback, "notification native impossible, repli sur le plugin");
            show_plugin(&p);
        }
    });
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn show_native(_: &Pending) -> Result<(), String> {
    Err("pas de notifications à actions sur ce système".into())
}

#[cfg(target_os = "linux")]
fn show_native(p: &Pending) -> Result<(), String> {
    let body = format!("{} · {}", p.machine_name, p.notification.body);
    let mut n = notify_rust::Notification::new();
    n.appname("Huntaway").summary(&p.notification.title).body(&body).action("default", "Ouvrir");
    if p.approve.is_some() {
        n.action("approve", "Approuver").action("deny", "Refuser");
    }
    if p.sound {
        n.sound_name("message-new-instant");
    }
    let handle = n.show().map_err(|e| e.to_string())?;
    let mut response = Response::Dismissed;
    handle.wait_for_action(|action| {
        response = match action {
            "approve" => Response::MainButton,
            "deny" => Response::CloseButton,
            "default" => Response::Click,
            _ => Response::Dismissed,
        }
    });
    run(p, action_for(response, p.approve));
    Ok(())
}

/// Carries out the action chosen in a notification.
fn run(p: &Pending, action: Action) {
    if p.test {
        crate::tray::show_window(&p.app);
        p.app.emit("notification-test", format!("{action:?}")).ok();
        return;
    }
    let agent = p.notification.agent_id.clone();
    let path = |a: &str| format!("/v1/agents/{}/{a}", Client::segment(&agent));
    match action {
        Action::Approve(number) => {
            let (client, path, app, m, a) = (p.client.clone(), path("choice"), p.app.clone(), p.machine_id.clone(), agent.clone());
            tauri::async_runtime::spawn(async move {
                if let Err(e) = client.post(&path, json!({ "number": number })).await {
                    tracing::warn!(error = %e, "approbation depuis la notification impossible");
                    open_conversation(&app, &m, &a);
                }
            });
        }
        Action::Deny => {
            let (client, path) = (p.client.clone(), path("deny"));
            tauri::async_runtime::spawn(async move {
                if let Err(e) = client.post(&path, json!({})).await {
                    tracing::warn!(error = %e, "refus depuis la notification impossible");
                }
            });
        }
        Action::Open => open_conversation(&p.app, &p.machine_id, &agent),
        Action::Nothing => {}
    }
}

fn show_plugin(p: &Pending) {
    let mut builder = p.app.notification().builder().title(&p.notification.title).body(format!("{} · {}", p.machine_name, p.notification.body));
    if p.sound {
        builder = builder.sound("default");
    }
    if let Err(e) = builder.show() {
        tracing::warn!(error = %e, "notification impossible");
    }
}

#[cfg(target_os = "macos")]
fn show_native(p: &Pending) -> Result<(), String> {
    use mac_notification_sys::{MainButton, NotificationResponse};
    static APP: std::sync::Once = std::sync::Once::new();
    APP.call_once(|| {
        // Inside Huntaway.app the notification comes from the app itself.
        let bundled = std::env::current_exe().map(|e| e.to_string_lossy().contains(".app/Contents/MacOS")).unwrap_or(false);
        let id = if bundled { "app.huntaway.desktop".to_string() } else { mac_notification_sys::get_bundle_identifier_or_default("Huntaway") };
        let _ = mac_notification_sys::set_application(&id);
    });
    let body = format!("{} · {}", p.machine_name, p.notification.body);
    let mut n = mac_notification_sys::Notification::new();
    n.title(&p.notification.title).message(&body);
    if p.sound {
        n.default_sound();
    }
    if p.approve.is_some() {
        n.main_button(MainButton::SingleAction("Approuver")).close_button("Refuser");
    } else {
        n.wait_for_click(true);
    }
    let response = match n.send().map_err(|e| e.to_string())? {
        NotificationResponse::ActionButton(_) => Response::MainButton,
        NotificationResponse::CloseButton(_) => Response::CloseButton,
        NotificationResponse::Click => Response::Click,
        _ => Response::Dismissed,
    };
    run(p, action_for(response, p.approve));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use huntaway_api::{Attention, BlockedReason, Interaction, ScreenOption};

    fn agent(reason: BlockedReason, first: &str) -> AgentView {
        let json = serde_json::json!({
            "id": "s:w1:p1", "instance_id": "i", "session": "s", "pane_id": "w1:p1", "workspace_id": "w1",
            "workspace_label": null, "tab_label": null, "project": "api", "kind": "claude", "name": null,
            "herdr_status": "blocked", "attention": {"status": "blocked", "reason": "approval"}, "summary": "",
            "last_activity_at": null, "interaction": null, "has_transcript": true, "item_count": 1, "warnings": []
        });
        let mut a: AgentView = serde_json::from_value(json).unwrap();
        a.attention = Attention::Blocked(reason);
        a.interaction = Some(Interaction {
            reason,
            tool: None,
            questions: vec![],
            options: vec![
                ScreenOption { number: 1, label: first.into(), detail: None, selected: true, numbered: true },
                ScreenOption { number: 2, label: "No".into(), detail: None, selected: false, numbered: true },
            ],
        });
        a
    }

    #[test]
    fn approve_only_for_yes_permission_prompts() {
        assert_eq!(approve_option(Some(&agent(BlockedReason::Approval, "Yes"))), Some(1));
        assert_eq!(approve_option(Some(&agent(BlockedReason::Approval, "No, exit"))), None);
        assert_eq!(approve_option(Some(&agent(BlockedReason::Question, "Yes"))), None);
        assert_eq!(approve_option(None), None);
    }

    #[test]
    fn responses_map_to_actions() {
        assert_eq!(action_for(Response::MainButton, Some(1)), Action::Approve(1));
        assert_eq!(action_for(Response::CloseButton, Some(1)), Action::Deny);
        assert_eq!(action_for(Response::CloseButton, None), Action::Nothing);
        assert_eq!(action_for(Response::Click, None), Action::Open);
        assert_eq!(action_for(Response::Dismissed, Some(1)), Action::Nothing);
    }
}
