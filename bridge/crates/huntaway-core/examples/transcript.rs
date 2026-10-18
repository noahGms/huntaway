//! Prints how a transcript is understood by Huntaway.
//! Usage: cargo run -p huntaway-core --example transcript -- <claude|codex> <file.jsonl>

use huntaway_core::transcript::TranscriptTail;
use huntaway_core::TimelineItem;

fn main() -> std::io::Result<()> {
    let args: Vec<String> = std::env::args().collect();
    let mut tail = match args[1].as_str() {
        "codex" => TranscriptTail::codex(&args[2]),
        _ => TranscriptTail::new(&args[2]),
    };
    let items = tail.poll()?;
    let mut counts = std::collections::BTreeMap::<&str, usize>::new();
    for item in &items {
        let (kind, text) = match item {
            TimelineItem::UserMessage { text, .. } => ("user", text.clone()),
            TimelineItem::AssistantMessage { text, .. } => ("assistant", text.clone()),
            TimelineItem::ToolCall { name, summary, .. } => ("tool_call", format!("{name}: {summary}")),
            TimelineItem::ToolResult { summary, is_error, .. } => ("tool_result", format!("{}{summary}", if *is_error { "✗ " } else { "" })),
            TimelineItem::TurnEnded { .. } => ("turn_ended", String::new()),
            _ => ("other", String::new()),
        };
        *counts.entry(kind).or_default() += 1;
        if kind != "tool_result" {
            println!("{kind:<11} {}", text.lines().next().unwrap_or("").chars().take(90).collect::<String>());
        }
    }
    println!("\n{counts:?} · pending: {}", tail.pending_tool_calls().len());
    Ok(())
}
