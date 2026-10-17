//! Mobile-facing agent state (PRD §11): maps Herdr's screen-detected status
//! plus transcript context to Blocked / Working / Done / Idle / Unknown.

pub use huntaway_api::{Attention, BlockedReason};

use crate::model::{TimelineItem, ToolKind};

/// Classifies an agent.
///
/// * `herdr_status`: Herdr's status string (`idle|working|blocked|done|unknown`).
/// * `pending_tool`: kind of the latest tool call without a result, if any.
/// * `recent`: recent transcript items, oldest first.
pub fn classify(herdr_status: &str, pending_tool: Option<ToolKind>, recent: &[TimelineItem]) -> Attention {
    match herdr_status {
        "working" => Attention::Working,
        "blocked" => Attention::Blocked(match pending_tool {
            Some(ToolKind::Question) => BlockedReason::Question,
            Some(ToolKind::Plan) => BlockedReason::Plan,
            Some(_) => BlockedReason::Approval,
            None => BlockedReason::Prompt,
        }),
        "done" | "idle" => {
            if ends_on_question(recent) {
                Attention::Blocked(BlockedReason::ExplicitQuestion)
            } else if herdr_status == "done" {
                Attention::Done
            } else {
                Attention::Idle
            }
        }
        _ => Attention::Unknown,
    }
}

/// True when the agent's last message of the latest turn asks the user something.
fn ends_on_question(recent: &[TimelineItem]) -> bool {
    for item in recent.iter().rev() {
        match item {
            TimelineItem::UserMessage { .. } => return false,
            TimelineItem::AssistantMessage { text, sidechain: false, .. } => return is_question(text),
            _ => {}
        }
    }
    false
}

fn is_question(text: &str) -> bool {
    let tail = text.trim_end_matches(|c: char| c.is_whitespace() || "*_`)".contains(c));
    if tail.ends_with('?') {
        return true;
    }
    // A question in the final paragraph also counts ("Tu préfères A ou B ?\n\nSinon je…").
    text.trim()
        .rsplit("\n\n")
        .next()
        .is_some_and(|last| last.lines().any(|l| l.trim_end().ends_with('?')))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn assistant(text: &str) -> TimelineItem {
        TimelineItem::AssistantMessage { uuid: String::new(), timestamp: String::new(), text: text.into(), sidechain: false }
    }

    fn user(text: &str) -> TimelineItem {
        TimelineItem::UserMessage { uuid: String::new(), timestamp: String::new(), text: text.into() }
    }

    #[test]
    fn blocked_reason_from_pending_tool() {
        assert_eq!(classify("blocked", Some(ToolKind::Command), &[]), Attention::Blocked(BlockedReason::Approval));
        assert_eq!(classify("blocked", Some(ToolKind::Question), &[]), Attention::Blocked(BlockedReason::Question));
        assert_eq!(classify("blocked", Some(ToolKind::Plan), &[]), Attention::Blocked(BlockedReason::Plan));
        assert_eq!(classify("blocked", None, &[]), Attention::Blocked(BlockedReason::Prompt));
    }

    #[test]
    fn done_turn_ending_on_question_is_blocked() {
        let items = [user("go"), assistant("J'ai deux options. Secure storage ou mémoire ?")];
        assert_eq!(classify("done", None, &items), Attention::Blocked(BlockedReason::ExplicitQuestion));
    }

    #[test]
    fn done_turn_with_conclusion_is_done() {
        let items = [user("go"), assistant("Terminé, 87 tests passent.")];
        assert_eq!(classify("done", None, &items), Attention::Done);
        assert_eq!(classify("idle", None, &items), Attention::Idle);
    }

    #[test]
    fn question_before_last_user_message_does_not_count() {
        let items = [assistant("Tu veux A ou B ?"), user("A")];
        assert_eq!(classify("done", None, &items), Attention::Done);
    }
}
