//! Non-regression tests on real transcripts (PRD §23):
//! - `claude_spike.jsonl`: the phase 0 test agent session (approvals, refusals,
//!   questions, interruptions), with machine-specific metadata removed;
//! - `codex_anonymized.jsonl`: a real Codex session whose texts were replaced
//!   by placeholders, structure kept.

use huntaway_core::transcript::TranscriptTail;
use huntaway_core::{TimelineItem, ToolKind};

fn fixture(name: &str) -> String {
    format!("{}/tests/fixtures/{name}", env!("CARGO_MANIFEST_DIR"))
}

#[derive(Default, Debug, PartialEq)]
struct Counts {
    user: usize,
    assistant: usize,
    tool_calls: usize,
    tool_results: usize,
    rejected: usize,
    questions: usize,
    turns: usize,
}

fn count(items: &[TimelineItem]) -> Counts {
    let mut c = Counts::default();
    for item in items {
        match item {
            TimelineItem::UserMessage { .. } => c.user += 1,
            TimelineItem::AssistantMessage { .. } => c.assistant += 1,
            TimelineItem::ToolCall { .. } => c.tool_calls += 1,
            TimelineItem::ToolResult { rejected, .. } => {
                c.tool_results += 1;
                c.rejected += usize::from(*rejected);
            }
            TimelineItem::QuestionAsked { .. } => c.questions += 1,
            TimelineItem::TurnEnded { .. } => c.turns += 1,
            _ => {}
        }
    }
    c
}

#[test]
fn claude_spike_session() {
    let mut tail = TranscriptTail::new(fixture("claude_spike.jsonl"));
    let items = tail.poll().unwrap();
    assert_eq!(
        count(&items),
        Counts { user: 27, assistant: 22, tool_calls: 15, tool_results: 15, rejected: 3, questions: 3, turns: 17 }
    );
    assert!(tail.pending_tool_calls().is_empty());
    // Every Bash call is a command; the first user message is the first prompt of the spike.
    assert!(items.iter().all(|i| !matches!(i, TimelineItem::ToolCall { name, kind, .. } if name == "Bash" && *kind != ToolKind::Command)));
    assert!(matches!(items.iter().find(|i| matches!(i, TimelineItem::UserMessage { .. })),
        Some(TimelineItem::UserMessage { text, .. }) if text.starts_with("Crée le fichier hello.txt")));
}

#[test]
fn codex_anonymized_session() {
    let mut tail = TranscriptTail::codex(fixture("codex_anonymized.jsonl"));
    let items = tail.poll().unwrap();
    assert_eq!(
        count(&items),
        Counts { user: 5, assistant: 14, tool_calls: 47, tool_results: 47, rejected: 0, questions: 0, turns: 4 }
    );
    assert!(tail.pending_tool_calls().is_empty());
    // Commands are extracted from both function calls and `exec` scripts.
    assert!(items.iter().any(|i| matches!(i, TimelineItem::ToolCall { name, summary, .. } if name == "exec" && summary.starts_with("cmd "))));
}

#[test]
fn incremental_reading_matches_full_reading() {
    // Feeding the file in small chunks must give the same items as one read.
    let content = std::fs::read_to_string(fixture("claude_spike.jsonl")).unwrap();
    let path = std::env::temp_dir().join(format!("huntaway-incremental-{}.jsonl", std::process::id()));
    std::fs::write(&path, "").unwrap();
    let mut tail = TranscriptTail::new(&path);
    let mut items = Vec::new();
    let bytes = content.as_bytes();
    for chunk in bytes.chunks(997) {
        use std::io::Write;
        std::fs::OpenOptions::new().append(true).open(&path).unwrap().write_all(chunk).unwrap();
        items.extend(tail.poll().unwrap());
    }
    let full = TranscriptTail::new(fixture("claude_spike.jsonl")).poll().unwrap();
    assert_eq!(count(&items), count(&full));
    let _ = std::fs::remove_file(path);
}
