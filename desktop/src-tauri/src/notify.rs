//! Native notifications with actions: "Approve" / "Deny" for a permission
//! prompt, and a click opens the conversation. macOS goes through
//! NSUserNotification, Linux through freedesktop notifications (D-Bus);
//! elsewhere, or if the system refuses, the Tauri notification plugin is used.
//! Answers carry the id of the prompt they were shown for: the daemon refuses
//! them if the agent has moved on to another prompt.

use huntaway_api::{AgentView, Notification};
use huntaway_client::Client;
use serde_json::json;
use tauri::{AppHandle, Emitter};
use tauri_plugin_notification::NotificationExt;

/// Option chosen by "Approve": the first one of the menu ("Yes"), only when
/// the agent still shows the prompt the notification is about.
pub fn approve_option(agent: Option<&AgentView>, interaction_id: Option<&str>) -> Option<u32> {
    let interaction = agent?.interaction.as_ref()?;
    if interaction.reason != huntaway_api::BlockedReason::Approval || interaction_id != Some(interaction.id.as_str()) || interaction.id.is_empty() {
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
    // A newer notification for the same agent replaces the previous one
    // (Linux replaces it in place, by id).
    #[cfg(target_os = "macos")]
    dismiss(&p.app, &p.machine_id, &p.notification.agent_id);
    // Waiting for the user's answer blocks: one thread per notification.
    std::thread::spawn(move || {
        if let Err(fallback) = show_native(&p) {
            tracing::debug!(error = %fallback, "native notification failed, using the plugin");
            show_plugin(&p);
        }
    });
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn show_native(_: &Pending) -> Result<(), String> {
    Err("no actionable notifications on this system".into())
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
pub fn dismiss(_: &AppHandle, _: &str, _: &str) {}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
pub fn dismiss_stale(_: &AppHandle, _: &str, _: &str, _: Option<&str>) {}

/// Notifications on screen per agent (`machine/agent`), for systems that
/// address them by id (freedesktop). Each one shown gets a new generation:
/// a notification replaced in place keeps its id, so the thread waiting on
/// the older one hears the newer one's actions too, and must ignore them.
#[derive(Default)]
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub struct OnScreen {
    shown: std::collections::HashMap<String, ShownId>,
    generation: u64,
}

#[derive(Debug, Clone, PartialEq)]
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub struct ShownId {
    pub id: u32,
    pub generation: u64,
    pub interaction_id: Option<String>,
    pub summary: String,
    pub body: String,
}

#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
impl OnScreen {
    /// Id of the agent's notification still on screen, to replace it.
    pub fn replaces(&self, key: &str) -> Option<u32> {
        self.shown.get(key).map(|s| s.id)
    }

    /// Records a notification just shown; returns its generation.
    pub fn shown(&mut self, key: &str, id: u32, interaction_id: Option<String>, summary: String, body: String) -> u64 {
        self.generation += 1;
        let generation = self.generation;
        self.shown.insert(key.to_string(), ShownId { id, generation, interaction_id, summary, body });
        generation
    }

    /// The user acted on (or closed) notification `generation`: true when it
    /// is still the agent's latest, which alone may act. Forgets it.
    pub fn answered(&mut self, key: &str, generation: u64) -> bool {
        let latest = self.shown.get(key).is_some_and(|s| s.generation == generation);
        if latest {
            self.shown.remove(key);
        }
        latest
    }

    /// Takes the agent's notification off the books if it is about another
    /// prompt than `current` (answered elsewhere, or a new one): to close.
    pub fn take_stale(&mut self, key: &str, current: Option<&str>) -> Option<ShownId> {
        let stale = self.shown.get(key).is_some_and(|s| s.interaction_id.as_deref() != current);
        if stale {
            self.shown.remove(key)
        } else {
            None
        }
    }

    #[cfg(test)]
    pub fn take(&mut self, key: &str) -> Option<ShownId> {
        self.shown.remove(key)
    }
}

#[cfg(target_os = "linux")]
fn on_screen() -> &'static std::sync::Mutex<OnScreen> {
    static ON_SCREEN: std::sync::OnceLock<std::sync::Mutex<OnScreen>> = std::sync::OnceLock::new();
    ON_SCREEN.get_or_init(Default::default)
}

/// Closes a notification by id: notify-rust only closes through a handle,
/// so take the id over with the same text, then close it. Its waiting
/// thread then sees it closed. D-Bus calls block: off the caller's thread.
#[cfg(target_os = "linux")]
fn close_linux(shown: ShownId) {
    std::thread::spawn(move || {
        let mut n = notify_rust::Notification::new();
        n.appname("Huntaway").summary(&shown.summary).body(&shown.body).id(shown.id);
        match n.show() {
            Ok(handle) => handle.close(),
            Err(e) => tracing::debug!(error = %e, "cannot close the notification"),
        }
    });
}

/// Closes the notification of an agent once it no longer shows the prompt
/// it was about (answered elsewhere, or another prompt).
#[cfg(target_os = "linux")]
pub fn dismiss_stale(_: &AppHandle, machine_id: &str, agent_id: &str, current: Option<&str>) {
    let stale = on_screen().lock().unwrap().take_stale(&format!("{machine_id}/{agent_id}"), current);
    if let Some(shown) = stale {
        close_linux(shown);
    }
}

#[cfg(target_os = "linux")]
fn show_native(p: &Pending) -> Result<(), String> {
    let key = format!("{}/{}", p.machine_id, p.notification.agent_id);
    let body = format!("{} · {}", p.machine_name, p.notification.body);
    let mut n = notify_rust::Notification::new();
    n.appname("Huntaway").summary(&p.notification.title).body(&body).action("default", "Open");
    if p.approve.is_some() {
        n.action("approve", "Approve").action("deny", "Deny");
    }
    if p.sound {
        n.sound_name("message-new-instant");
    }
    // The agent's previous notification is replaced in place, not stacked.
    if let Some(id) = on_screen().lock().unwrap().replaces(&key) {
        n.id(id);
    }
    let handle = n.show().map_err(|e| e.to_string())?;
    let generation = on_screen().lock().unwrap().shown(&key, handle.id(), p.notification.interaction_id.clone(), p.notification.title.clone(), body);
    let mut response = Response::Dismissed;
    handle.wait_for_action(|action| {
        response = match action {
            "approve" => Response::MainButton,
            "deny" => Response::CloseButton,
            "default" => Response::Click,
            _ => Response::Dismissed,
        }
    });
    // Replaced by a newer notification of the agent, or closed as stale: not ours to answer.
    if on_screen().lock().unwrap().answered(&key, generation) {
        run(p, action_for(response, p.approve));
    }
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
    let interaction_id = p.notification.interaction_id.clone();
    let answer = |path: String, body: serde_json::Value| {
        let (client, app, machine_id, agent_id, machine_name) = (p.client.clone(), p.app.clone(), p.machine_id.clone(), agent.clone(), p.machine_name.clone());
        tauri::async_runtime::spawn(async move {
            match client.post(&path, body).await {
                Ok(_) => {}
                // The notification was about an older prompt: nothing was sent.
                Err(e) if e.code() == "interaction_changed" => {
                    show_plain(&app, "The agent is now asking something else", &format!("{machine_name} · Open the conversation to see the new prompt."));
                    open_conversation(&app, &machine_id, &agent_id);
                }
                Err(e) if e.code() == "already_resolved" => {}
                Err(e) => {
                    tracing::warn!(error = %e, "could not answer from the notification");
                    open_conversation(&app, &machine_id, &agent_id);
                }
            }
        });
    };
    match action {
        Action::Approve(number) => answer(path("choice"), json!({ "number": number, "interaction_id": interaction_id })),
        Action::Deny => answer(path("deny"), json!({ "interaction_id": interaction_id })),
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
        tracing::warn!(error = %e, "notification failed");
    }
}

/// Notification without actions.
fn show_plain(app: &AppHandle, title: &str, body: &str) {
    if let Err(e) = app.notification().builder().title(title).body(body).show() {
        tracing::warn!(error = %e, "notification failed");
    }
}

/// Approval notification still on screen for an agent.
#[cfg(target_os = "macos")]
struct Shown {
    interaction_id: Option<String>,
    /// Title and text, to find it among the delivered notifications.
    title: String,
    message: String,
}

/// Per agent (`machine/agent`).
#[cfg(target_os = "macos")]
fn shown() -> &'static std::sync::Mutex<std::collections::HashMap<String, Shown>> {
    static SHOWN: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<String, Shown>>> = std::sync::OnceLock::new();
    SHOWN.get_or_init(Default::default)
}

/// Closes the approval notification of an agent once it no longer shows
/// the prompt it was about (answered elsewhere, or another prompt).
#[cfg(target_os = "macos")]
pub fn dismiss_stale(app: &AppHandle, machine_id: &str, agent_id: &str, current: Option<&str>) {
    let key = format!("{machine_id}/{agent_id}");
    let stale = shown().lock().unwrap().get(&key).is_some_and(|s| s.interaction_id.as_deref() != current);
    if stale {
        dismiss(app, machine_id, agent_id);
    }
}

/// Removes the approval notification of an agent from the notification
/// center. Its thread, waiting for an answer, then ends (seen as dismissed).
#[cfg(target_os = "macos")]
#[allow(deprecated)]
pub fn dismiss(app: &AppHandle, machine_id: &str, agent_id: &str) {
    let Some(Shown { title, message, .. }) = shown().lock().unwrap().remove(&format!("{machine_id}/{agent_id}")) else { return };
    let _ = app.run_on_main_thread(move || {
        use objc2_foundation::NSUserNotificationCenter;
        let center = NSUserNotificationCenter::defaultUserNotificationCenter();
        for n in center.deliveredNotifications().iter() {
            let same = n.title().map(|t| t.to_string()) == Some(title.clone()) && n.informativeText().map(|t| t.to_string()) == Some(message.clone());
            if same {
                center.removeDeliveredNotification(&n);
            }
        }
    });
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
    let key = format!("{}/{}", p.machine_id, p.notification.agent_id);
    if p.approve.is_some() {
        n.main_button(MainButton::SingleAction("Approve")).close_button("Deny");
        let entry = Shown { interaction_id: p.notification.interaction_id.clone(), title: p.notification.title.clone(), message: body.clone() };
        shown().lock().unwrap().insert(key.clone(), entry);
    } else {
        n.wait_for_click(true);
    }
    let response = match n.send().map_err(|e| e.to_string())? {
        NotificationResponse::ActionButton(_) => Response::MainButton,
        NotificationResponse::CloseButton(_) => Response::CloseButton,
        NotificationResponse::Click => Response::Click,
        _ => Response::Dismissed,
    };
    if p.approve.is_some() {
        let mut shown = shown().lock().unwrap();
        if shown.get(&key).is_some_and(|s| s.message == body && s.interaction_id == p.notification.interaction_id) {
            shown.remove(&key);
        }
    }
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
            id: "q1".into(),
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
        assert_eq!(approve_option(Some(&agent(BlockedReason::Approval, "Yes")), Some("q1")), Some(1));
        assert_eq!(approve_option(Some(&agent(BlockedReason::Approval, "No, exit")), Some("q1")), None);
        assert_eq!(approve_option(Some(&agent(BlockedReason::Question, "Yes")), Some("q1")), None);
        assert_eq!(approve_option(None, Some("q1")), None);
    }

    #[test]
    fn approve_only_for_the_notified_prompt() {
        assert_eq!(approve_option(Some(&agent(BlockedReason::Approval, "Yes")), Some("q0")), None);
        assert_eq!(approve_option(Some(&agent(BlockedReason::Approval, "Yes")), None), None);
    }

    #[test]
    fn only_the_latest_notification_of_an_agent_acts() {
        let mut screen = OnScreen::default();
        let first = screen.shown("m/a", 7, Some("q1".into()), "t".into(), "b".into());
        assert_eq!(screen.replaces("m/a"), Some(7));
        // Replaced in place (same id): the first thread hears the second one's click.
        let second = screen.shown("m/a", 7, Some("q2".into()), "t".into(), "b".into());
        assert!(!screen.answered("m/a", first));
        assert!(screen.answered("m/a", second));
        assert_eq!(screen.replaces("m/a"), None);
    }

    #[test]
    fn answered_or_changed_prompts_are_stale() {
        let mut screen = OnScreen::default();
        let generation = screen.shown("m/a", 3, Some("q1".into()), "t".into(), "b".into());
        assert!(screen.take_stale("m/a", Some("q1")).is_none());
        assert_eq!(screen.take_stale("m/a", None).map(|s| s.id), Some(3));
        // Closed as stale: its thread must not act on the close.
        assert!(!screen.answered("m/a", generation));
        // Done notifications (no prompt) survive updates of a working agent.
        screen.shown("m/b", 4, None, "t".into(), "b".into());
        assert!(screen.take_stale("m/b", None).is_none());
        assert_eq!(screen.take("m/b").map(|s| s.id), Some(4));
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
