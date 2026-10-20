//! Claude Code adapter: locates and incrementally parses session transcripts
//! (`~/.claude/projects/<sanitized cwd>/<session id>.jsonl`).
//!
//! Claude Code appends one JSON object per line. Each assistant content block
//! (`text`, `thinking`, `tool_use`) is written as its own line once complete,
//! so the finest live granularity is one block, not one token.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::model::{FileChange, Question, QuestionOption, TimelineItem, Todo, ToolKind, Usage};
use crate::launch::agent_launch;
use crate::transcript::LineParser;
pub use crate::transcript::{PendingTool, TranscriptTail};

/// Start of the tool result Claude Code writes when the user declines a permission prompt.
const REJECTED_PREFIX: &str = "The user doesn't want to proceed with this tool use";

/// Keys that empty Claude Code's input box. After an interruption Claude puts
/// the interrupted prompt back in the input; without this, the next
/// `agent.prompt` gets appended to it.
pub const CLEAR_INPUT_KEYS: &[&str] = &["ctrl+u"];

/// Claude config dir: `$CLAUDE_CONFIG_DIR` or `~/.claude`.
pub fn config_dir() -> PathBuf {
    match std::env::var("CLAUDE_CONFIG_DIR") {
        Ok(dir) if !dir.is_empty() => PathBuf::from(dir),
        _ => PathBuf::from(std::env::var("HOME").unwrap_or_else(|_| ".".into())).join(".claude"),
    }
}

/// Claude names project dirs after the cwd with every non-alphanumeric
/// character replaced by `-`.
pub fn project_dir_name(cwd: &str) -> String {
    cwd.chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect()
}

/// Finds the transcript of a Claude session. Tries the cwd-derived project
/// dir first, then scans every project dir for `<session_id>.jsonl`.
pub fn transcript_path(cwd: Option<&str>, session_id: &str) -> Option<PathBuf> {
    let projects = config_dir().join("projects");
    let file_name = format!("{session_id}.jsonl");
    if let Some(cwd) = cwd {
        let direct = projects.join(project_dir_name(cwd)).join(&file_name);
        if direct.exists() {
            return Some(direct);
        }
    }
    std::fs::read_dir(&projects)
        .ok()?
        .flatten()
        .map(|e| e.path().join(&file_name))
        .find(|p| p.exists())
}

/// Transcript of the sub-agent started by the `Task` / `Agent` call
/// `tool_use_id`: `<session>/subagents/agent-<id>.jsonl` next to the main
/// transcript, found through its `.meta.json`.
pub fn subagent_transcript(main: &Path, tool_use_id: &str) -> Option<PathBuf> {
    let dir = main.with_extension("").join("subagents");
    std::fs::read_dir(&dir).ok()?.flatten().find_map(|e| {
        let path = e.path();
        let name = path.file_name()?.to_str()?;
        let stem = name.strip_suffix(".meta.json")?;
        let meta: Value = serde_json::from_str(&std::fs::read_to_string(&path).ok()?).ok()?;
        (meta["toolUseId"].as_str() == Some(tool_use_id)).then(|| dir.join(format!("{stem}.jsonl"))).filter(|p| p.exists())
    })
}

#[derive(Default)]
pub struct Parser {
    /// Reading a sub-agent transcript: its lines are all sidechain, and its
    /// pending calls are what the sub-agent asks permission for.
    subagent: bool,
    /// Pending tool calls keyed by insertion order.
    pending: BTreeMap<u64, PendingTool>,
    pending_seq: u64,
    seen_uuids: HashSet<String>,
    todos: Vec<Todo>,
    /// Usage per API message id: Claude writes one line per content block,
    /// each repeating the usage of the whole message.
    usage_by_message: HashMap<String, [u64; 4]>,
    totals: [u64; 4],
    context_tokens: u64,
    model: Option<String>,
    title: Option<String>,
    permission_mode: Option<String>,
    /// Session slug, which names its plan file (`plans/<slug>.md`).
    slug: Option<String>,
    /// Last text written to a plan file: the plan when `ExitPlanMode`
    /// carries none and the file is gone.
    written_plan: Option<String>,
}

/// Claude models have a 200k context, or 1M when enabled.
fn claude_context_window(context: u64) -> u64 {
    if context > 200_000 {
        1_000_000
    } else {
        200_000
    }
}

impl LineParser for Parser {
    fn parse_line(&mut self, line: &str) -> Vec<TimelineItem> {
        Parser::parse_line(self, line)
    }

    fn pending(&self) -> Vec<&PendingTool> {
        self.pending.values().collect()
    }

    fn todos(&self) -> &[Todo] {
        &self.todos
    }

    fn usage(&self) -> Option<Usage> {
        if self.model.is_none() && self.totals == [0; 4] {
            return None;
        }
        let [input_tokens, output_tokens, cache_read_tokens, cache_write_tokens] = self.totals;
        let mut usage = Usage {
            model: self.model.clone(),
            input_tokens,
            output_tokens,
            cache_read_tokens,
            cache_write_tokens,
            context_tokens: self.context_tokens,
            context_window: Some(claude_context_window(self.context_tokens)),
            cost_usd: None,
            rate_limits: None,
        };
        usage.cost_usd = crate::pricing::estimate(&usage);
        Some(usage)
    }

    fn title(&self) -> Option<&str> {
        self.title.as_deref()
    }

    fn permission_mode(&self) -> Option<&str> {
        self.permission_mode.as_deref()
    }
}

/// Claude Code transcript parser.
pub fn parser() -> Box<dyn LineParser> {
    Box::<Parser>::default()
}

/// Parser of a sub-agent transcript ([`subagent_transcript`]).
pub fn subagent_parser() -> Box<dyn LineParser> {
    Box::new(Parser { subagent: true, ..Parser::default() })
}

impl Parser {
    fn parse_line(&mut self, line: &str) -> Vec<TimelineItem> {
        if line.is_empty() {
            return Vec::new();
        }
        let Ok(entry) = serde_json::from_str::<Value>(line) else {
            return Vec::new();
        };
        let uuid = str_field(&entry, "uuid");
        if !uuid.is_empty() && !self.seen_uuids.insert(uuid.clone()) {
            return Vec::new();
        }
        let timestamp = str_field(&entry, "timestamp");
        let sidechain = entry["isSidechain"].as_bool().unwrap_or(false);
        let is_meta = entry["isMeta"].as_bool().unwrap_or(false);
        if let Some(slug) = entry["slug"].as_str().filter(|s| !s.is_empty()) {
            self.slug = Some(slug.to_string());
        }
        // Written on each mode change, and on the user messages typed in it.
        if !sidechain && !self.subagent {
            if let Some(mode) = entry["permissionMode"].as_str().filter(|m| !m.is_empty()) {
                self.permission_mode = Some(mode.to_string());
            }
        }

        match entry["type"].as_str() {
            // After `/compact`, Claude writes the summary of the earlier
            // conversation as a user message: not something the user said.
            Some("user") if entry["isCompactSummary"].as_bool() == Some(true) => {
                vec![TimelineItem::Notice { timestamp, text: "Conversation compacted".into() }]
            }
            Some("user") if !is_meta => self.parse_user(&entry, uuid, timestamp),
            // A message typed while Claude works, read mid-turn: written as an
            // attachment, with no `user` entry.
            Some("attachment") if is_queued_prompt(&entry["attachment"]) => {
                user_text(entry["attachment"]["prompt"].as_str().unwrap_or_default(), uuid, timestamp).into_iter().collect()
            }
            Some("assistant") => {
                self.record_usage(&entry["message"], sidechain);
                self.parse_assistant(&entry, uuid, timestamp, sidechain)
            }
            Some("ai-title") => {
                self.title = entry["aiTitle"].as_str().map(str::to_string).or(self.title.take());
                Vec::new()
            }
            Some("custom-title") => {
                self.title = entry["customTitle"].as_str().map(str::to_string).or(self.title.take());
                Vec::new()
            }
            Some("system") => parse_system(&entry, timestamp),
            _ => Vec::new(),
        }
    }

    fn record_usage(&mut self, message: &Value, sidechain: bool) {
        if let Some(model) = message["model"].as_str().filter(|m| !m.starts_with('<')) {
            if !sidechain {
                self.model = Some(model.to_string());
            }
        }
        let u = &message["usage"];
        if !u.is_object() {
            return;
        }
        let get = |k: &str| u[k].as_u64().unwrap_or(0);
        let counts = [get("input_tokens"), get("output_tokens"), get("cache_read_input_tokens"), get("cache_creation_input_tokens")];
        let id = message["id"].as_str().unwrap_or_default().to_string();
        let previous = self.usage_by_message.insert(id, counts).unwrap_or([0; 4]);
        for i in 0..4 {
            self.totals[i] = (self.totals[i] + counts[i]).saturating_sub(previous[i]);
        }
        if !sidechain {
            self.context_tokens = counts[0] + counts[2] + counts[3];
        }
    }

    fn parse_user(&mut self, entry: &Value, uuid: String, timestamp: String) -> Vec<TimelineItem> {
        let content = &entry["message"]["content"];
        if let Some(text) = content.as_str() {
            return user_text(text, uuid, timestamp).into_iter().collect();
        }
        let mut items = Vec::new();
        for block in content.as_array().into_iter().flatten() {
            match block["type"].as_str() {
                Some("tool_result") => {
                    let tool_use_id = str_field(block, "tool_use_id");
                    self.pending.retain(|_, p| p.tool_use_id != tool_use_id);
                    let text = tool_result_text(&block["content"]);
                    let rejected = text.starts_with(REJECTED_PREFIX);
                    items.push(TimelineItem::ToolResult {
                        timestamp: timestamp.clone(),
                        tool_use_id,
                        is_error: block["is_error"].as_bool().unwrap_or(false),
                        rejected,
                        summary: if rejected { "Denied".into() } else { first_line(&text, 160) },
                    });
                }
                Some("text") => {
                    if let Some(item) = user_text(block["text"].as_str().unwrap_or_default(), uuid.clone(), timestamp.clone()) {
                        items.push(item);
                    }
                }
                _ => {}
            }
        }
        items
    }

    fn parse_assistant(&mut self, entry: &Value, uuid: String, timestamp: String, sidechain: bool) -> Vec<TimelineItem> {
        let mut items = Vec::new();
        for block in entry["message"]["content"].as_array().into_iter().flatten() {
            match block["type"].as_str() {
                Some("text") => {
                    let text = block["text"].as_str().unwrap_or_default().trim();
                    if !text.is_empty() {
                        items.push(TimelineItem::AssistantMessage {
                            uuid: uuid.clone(),
                            timestamp: timestamp.clone(),
                            text: text.to_string(),
                            sidechain,
                        });
                    }
                }
                Some("tool_use") => items.extend(self.tool_use(block, &uuid, &timestamp, sidechain)),
                Some("thinking") => {
                    let text = block["thinking"].as_str().unwrap_or_default().trim();
                    if !text.is_empty() {
                        items.push(TimelineItem::Thinking { timestamp: timestamp.clone(), text: text.to_string(), sidechain });
                    }
                }
                _ => {}
            }
        }
        items
    }

    fn tool_use(&mut self, block: &Value, uuid: &str, timestamp: &str, sidechain: bool) -> Vec<TimelineItem> {
        let name = str_field(block, "name");
        let tool_use_id = str_field(block, "id");
        let mut input = block["input"].clone();
        if name == "Write" && input["file_path"].as_str().is_some_and(|p| p.contains("/plans/") && p.ends_with(".md")) {
            self.written_plan = input["content"].as_str().map(str::to_string);
        }
        let plan = (name == "ExitPlanMode")
            .then(|| plan_text(&input, &config_dir().join("plans"), self.slug.as_deref(), self.written_plan.as_deref()))
            .flatten();
        // Older versions only point at the plan file: show its text anyway.
        if let Some(plan) = &plan {
            input["plan"] = Value::String(plan.clone());
        }
        let input = &input;
        let mut kind = tool_kind(&name);
        let mut summary = tool_summary(&name, input);
        let agent = (kind == ToolKind::Command).then(|| input["command"].as_str().and_then(agent_launch)).flatten();
        if let Some(launch) = &agent {
            kind = ToolKind::Agent;
            summary = launch_summary(launch);
        }

        if !sidechain || self.subagent {
            self.pending_seq += 1;
            self.pending.insert(
                self.pending_seq,
                PendingTool {
                    tool_use_id: tool_use_id.clone(),
                    kind,
                    name: name.clone(),
                    summary: summary.clone(),
                    input: input.clone(),
                    timestamp: timestamp.to_string(),
                },
            );
        }

        let mut items = vec![TimelineItem::ToolCall {
            uuid: uuid.to_string(),
            timestamp: timestamp.to_string(),
            tool_use_id: tool_use_id.clone(),
            name: name.clone(),
            kind,
            summary,
            sidechain,
            change: file_change(&name, input),
            agent: agent.map(Box::new),
            plan,
        }];
        match kind {
            ToolKind::Todo => {
                self.todos = parse_todos(input);
                items.push(TimelineItem::TodosUpdated { timestamp: timestamp.to_string(), todos: self.todos.clone() });
            }
            ToolKind::Question => items.push(TimelineItem::QuestionAsked {
                timestamp: timestamp.to_string(),
                tool_use_id,
                questions: parse_questions(input),
            }),
            _ => {}
        }
        items
    }
}

fn parse_system(entry: &Value, timestamp: String) -> Vec<TimelineItem> {
    match entry["subtype"].as_str() {
        Some("turn_duration") => vec![TimelineItem::TurnEnded {
            timestamp,
            duration_ms: entry["durationMs"].as_u64(),
        }],
        Some("away_summary") => vec![TimelineItem::AwaySummary {
            timestamp,
            text: str_field(entry, "content"),
        }],
        _ => Vec::new(),
    }
}

/// Converts a plain user message. Slash commands are shown as `/name args`;
/// command output and injected reminders are hidden.
/// `queued_command` attachment typed by a human (not a task notification).
fn is_queued_prompt(a: &Value) -> bool {
    a["type"] == "queued_command"
        && a["commandMode"] != "task-notification"
        && (a["origin"]["kind"] == "human" || a["humanTurn"].as_bool() == Some(true))
        && a["prompt"].is_string()
}

fn user_text(text: &str, uuid: String, timestamp: String) -> Option<TimelineItem> {
    let text = text.trim();
    // Text injected by Claude Code itself (background task results, shell
    // escapes, reminders): not something the user typed.
    const INJECTED: [&str; 5] = ["<local-command-", "<system-reminder>", "<task-notification>", "<bash-", "<user-memory-input>"];
    if text.is_empty() || INJECTED.iter().any(|p| text.starts_with(p)) {
        return None;
    }
    if let Some(name) = between(text, "<command-name>", "</command-name>") {
        let args = between(text, "<command-args>", "</command-args>").unwrap_or_default();
        let shown = format!("{} {}", name.trim(), args.trim()).trim().to_string();
        return Some(TimelineItem::UserMessage { uuid, timestamp, text: shown });
    }
    if text.starts_with("[Request interrupted") {
        return Some(TimelineItem::Notice { timestamp, text: "Interrupted by the user".into() });
    }
    Some(TimelineItem::UserMessage { uuid, timestamp, text: text.to_string() })
}

pub fn tool_kind(name: &str) -> ToolKind {
    match name {
        "Read" | "NotebookRead" => ToolKind::FileRead,
        "Grep" | "Glob" | "LS" | "ToolSearch" => ToolKind::Search,
        "Edit" | "MultiEdit" | "Write" | "NotebookEdit" => ToolKind::FileModified,
        "Bash" | "BashOutput" | "KillShell" | "Monitor" => ToolKind::Command,
        "TodoWrite" => ToolKind::Todo,
        "AskUserQuestion" => ToolKind::Question,
        "ExitPlanMode" => ToolKind::Plan,
        "Task" | "Agent" => ToolKind::Subagent,
        "WebFetch" | "WebSearch" => ToolKind::Web,
        _ => ToolKind::Other,
    }
}

fn tool_summary(name: &str, input: &Value) -> String {
    let pick = |keys: &[&str]| keys.iter().find_map(|k| input[*k].as_str()).map(str::to_string);
    let summary = match tool_kind(name) {
        ToolKind::FileRead | ToolKind::FileModified => pick(&["file_path", "notebook_path", "path"]).map(|p| shorten_path(&p)),
        ToolKind::Search => pick(&["pattern", "query", "path"]),
        ToolKind::Command => pick(&["command", "description"]),
        ToolKind::Web => pick(&["url", "query"]),
        ToolKind::Subagent => pick(&["description", "prompt"]),
        ToolKind::Question => input["questions"][0]["question"].as_str().map(str::to_string),
        ToolKind::Plan => Some("Plan proposed".into()),
        ToolKind::Todo => {
            let n = input["todos"].as_array().map_or(0, Vec::len);
            Some(format!("{n} task{}", if n == 1 { "" } else { "s" }))
        }
        ToolKind::Other | ToolKind::Agent => pick(&["description", "command", "file_path", "url", "query"]),
    };
    first_line(&summary.unwrap_or_default(), 120)
}

/// `reviewer: Review the diff…`, for an agent launch.
pub fn launch_summary(launch: &crate::model::AgentLaunch) -> String {
    let name = launch.name.as_deref().unwrap_or("agent");
    match &launch.prompt {
        Some(p) => first_line(&format!("{name}: {p}"), 120),
        None => name.to_string(),
    }
}

/// Max characters kept of a proposed plan.
const PLAN_MAX: usize = 20_000;

/// Plan of an `ExitPlanMode` call: its `plan` input; else the plan file (from
/// `planFilePath` or the session `slug`, only read inside `plans`); else the
/// last text the agent wrote to a plan file. Some versions send no input.
fn plan_text(input: &Value, plans: &Path, slug: Option<&str>, written: Option<&str>) -> Option<String> {
    let non_empty = |t: &str| Some(t.trim().to_string()).filter(|t| !t.is_empty());
    let read = |path: PathBuf| {
        let plans = plans.canonicalize().ok()?;
        let path = path.canonicalize().ok().filter(|p| p.starts_with(&plans) && p.extension().is_some_and(|e| e == "md"))?;
        non_empty(&std::fs::read_to_string(path).ok()?)
    };
    let text = input["plan"]
        .as_str()
        .and_then(non_empty)
        .or_else(|| read(PathBuf::from(input["planFilePath"].as_str()?)))
        .or_else(|| read(plans.join(format!("{}.md", slug?))))
        .or_else(|| written.and_then(non_empty))?;
    Some(if text.chars().count() > PLAN_MAX { format!("{}\n\n…", text.chars().take(PLAN_MAX).collect::<String>()) } else { text })
}

/// Permission mode shown in Claude Code's footer (`⏸ plan mode on (shift+tab
/// to cycle)`), `default` when the footer shows none. Only the bottom lines
/// are read: the conversation above may quote these words.
pub fn screen_permission_mode(screen: &str) -> Option<&'static str> {
    const INDICATORS: [(&str, &str); 6] = [
        ("plan mode on", "plan"),
        ("accept edits on", "acceptEdits"),
        ("auto mode on", "auto"),
        ("bypass permissions on", "bypassPermissions"),
        ("don't ask on", "dontAsk"),
        ("manual mode on", "default"),
    ];
    let bottom: Vec<&str> = screen.lines().rev().map(str::trim).filter(|l| !l.is_empty()).take(4).collect();
    if bottom.is_empty() {
        return None;
    }
    for line in &bottom {
        let line = line.to_lowercase();
        if let Some((_, mode)) = INDICATORS.iter().find(|(text, _)| line.contains(text)) {
            return Some(mode);
        }
    }
    // The input box is there but no mode is shown: the default one.
    bottom.iter().any(|l| l.starts_with('❯') || l.starts_with('─')).then_some("default")
}

/// Max characters kept per side of a file change.
const CHANGE_MAX: usize = 6000;

fn file_change(name: &str, input: &Value) -> Option<FileChange> {
    let path = input["file_path"].as_str()?.to_string();
    let cut = |s: &str| -> (String, bool) {
        if s.chars().count() > CHANGE_MAX {
            (s.chars().take(CHANGE_MAX).collect(), true)
        } else {
            (s.to_string(), false)
        }
    };
    let (old, new, truncated) = match name {
        "Edit" => {
            let (old, t1) = cut(input["old_string"].as_str()?);
            let (new, t2) = cut(input["new_string"].as_str()?);
            (Some(old), new, t1 || t2)
        }
        "MultiEdit" => {
            let edits = input["edits"].as_array()?;
            let join = |key: &str| {
                edits.iter().filter_map(|e| e[key].as_str()).collect::<Vec<_>>().join("\n⋯\n")
            };
            let (old, t1) = cut(&join("old_string"));
            let (new, t2) = cut(&join("new_string"));
            (Some(old), new, t1 || t2)
        }
        "Write" => {
            let (new, t) = cut(input["content"].as_str()?);
            (None, new, t)
        }
        _ => return None,
    };
    Some(FileChange { path, old, new, truncated })
}

fn parse_todos(input: &Value) -> Vec<Todo> {
    input["todos"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|t| Todo {
            content: str_field(t, "content"),
            status: str_field(t, "status"),
        })
        .collect()
}

fn parse_questions(input: &Value) -> Vec<Question> {
    input["questions"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|q| Question {
            header: q["header"].as_str().map(str::to_string),
            question: str_field(q, "question"),
            multi_select: q["multiSelect"].as_bool().unwrap_or(false),
            options: q["options"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|o| QuestionOption {
                    label: str_field(o, "label"),
                    description: o["description"].as_str().map(str::to_string),
                })
                .collect(),
        })
        .collect()
}

fn tool_result_text(content: &Value) -> String {
    if let Some(s) = content.as_str() {
        return s.to_string();
    }
    content
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|b| b["text"].as_str())
        .collect::<Vec<_>>()
        .join("\n")
}

fn str_field(v: &Value, key: &str) -> String {
    v[key].as_str().unwrap_or_default().to_string()
}

fn between<'a>(text: &'a str, start: &str, end: &str) -> Option<&'a str> {
    let from = text.find(start)? + start.len();
    let to = text[from..].find(end)? + from;
    Some(&text[from..to])
}

fn first_line(text: &str, max: usize) -> String {
    let line = text.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or_default();
    if line.chars().count() > max {
        format!("{}…", line.chars().take(max).collect::<String>())
    } else {
        line.to_string()
    }
}

/// Keeps the last three path components: mobile UI never shows absolute paths.
fn shorten_path(path: &str) -> String {
    let parts: Vec<&str> = path.split('/').filter(|p| !p.is_empty()).collect();
    if parts.len() <= 3 {
        return path.to_string();
    }
    format!("…/{}", parts[parts.len() - 3..].join("/"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::File;
    use std::io::Write;

    fn tail_with(lines: &[&str]) -> (TranscriptTail, Vec<TimelineItem>) {
        static N: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let n = N.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("huntaway-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(format!("{n}.jsonl"));
        let mut f = File::create(&path).unwrap();
        for l in lines {
            writeln!(f, "{l}").unwrap();
        }
        let mut tail = TranscriptTail::new(&path);
        let items = tail.poll().unwrap();
        (tail, items)
    }

    #[test]
    fn usage_is_counted_once_per_message_and_title_is_read() {
        let (tail, _) = tail_with(&[
            r#"{"type":"assistant","uuid":"a1","timestamp":"t","message":{"id":"m1","model":"claude-sonnet-4-5","usage":{"input_tokens":10,"output_tokens":5,"cache_read_input_tokens":100,"cache_creation_input_tokens":20},"content":[{"type":"text","text":"a"}]}}"#,
            r#"{"type":"assistant","uuid":"a2","timestamp":"t","message":{"id":"m1","model":"claude-sonnet-4-5","usage":{"input_tokens":10,"output_tokens":7,"cache_read_input_tokens":100,"cache_creation_input_tokens":20},"content":[{"type":"text","text":"b"}]}}"#,
            r#"{"type":"assistant","uuid":"a3","timestamp":"t","message":{"id":"m2","model":"claude-sonnet-4-5","usage":{"input_tokens":1,"output_tokens":1,"cache_read_input_tokens":130,"cache_creation_input_tokens":0},"content":[{"type":"text","text":"c"}]}}"#,
            r#"{"type":"ai-title","aiTitle":"fix-login","sessionId":"s"}"#,
        ]);
        let usage = tail.usage().unwrap();
        assert_eq!(usage.model.as_deref(), Some("claude-sonnet-4-5"));
        assert_eq!(usage.input_tokens, 11);
        assert_eq!(usage.output_tokens, 8);
        assert_eq!(usage.cache_read_tokens, 230);
        assert_eq!(usage.context_tokens, 131);
        assert_eq!(usage.context_window, Some(200_000));
        assert!(usage.cost_usd.unwrap() > 0.0);
        assert_eq!(tail.title(), Some("fix-login"));
    }

    #[test]
    fn messages_typed_while_working_are_user_messages() {
        let (_, items) = tail_with(&[
            r#"{"type":"queue-operation","operation":"enqueue","timestamp":"t0","content":"also run the tests"}"#,
            r#"{"type":"attachment","uuid":"q1","timestamp":"t1","attachment":{"type":"queued_command","prompt":"also run the tests","commandMode":"prompt","origin":{"kind":"human"},"humanTurn":true}}"#,
            r#"{"type":"attachment","uuid":"q2","timestamp":"t2","attachment":{"type":"queued_command","prompt":"<task-notification>done</task-notification>","commandMode":"task-notification"}}"#,
        ]);
        let users: Vec<&str> = items
            .iter()
            .filter_map(|i| match i {
                TimelineItem::UserMessage { text, .. } => Some(text.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(users, ["also run the tests"]);
    }

    #[test]
    fn project_dir_name_matches_claude() {
        assert_eq!(project_dir_name("/Users/me/Developer/apii-dashboard"), "-Users-me-Developer-apii-dashboard");
        assert_eq!(project_dir_name("/tmp/a.b_c"), "-tmp-a-b-c");
    }

    #[test]
    fn parses_conversation_and_tracks_pending_tools() {
        let (tail, items) = tail_with(&[
            r#"{"type":"user","uuid":"u1","timestamp":"t1","message":{"role":"user","content":"Refactor auth"}}"#,
            r#"{"type":"assistant","uuid":"a1","timestamp":"t2","message":{"content":[{"type":"text","text":"Je regarde."}]}}"#,
            r#"{"type":"assistant","uuid":"a2","timestamp":"t3","message":{"content":[{"type":"tool_use","id":"tu1","name":"Bash","input":{"command":"npm test"}}]}}"#,
            r#"{"type":"assistant","uuid":"a3","timestamp":"t4","message":{"content":[{"type":"tool_use","id":"tu2","name":"Edit","input":{"file_path":"/a/b/src/auth/session.ts"}}]}}"#,
            r#"{"type":"user","uuid":"u2","timestamp":"t5","message":{"content":[{"type":"tool_result","tool_use_id":"tu1","content":"\nPASS 87 tests\n"}]}}"#,
            r#"{"type":"system","uuid":"s1","timestamp":"t6","subtype":"turn_duration","durationMs":1200}"#,
        ]);
        assert!(matches!(&items[0], TimelineItem::UserMessage { text, .. } if text == "Refactor auth"));
        assert!(matches!(&items[1], TimelineItem::AssistantMessage { text, .. } if text == "Je regarde."));
        assert!(matches!(&items[2], TimelineItem::ToolCall { kind: ToolKind::Command, summary, .. } if summary == "npm test"));
        assert!(matches!(&items[3], TimelineItem::ToolCall { summary, .. } if summary == "…/src/auth/session.ts"));
        assert!(matches!(&items[4], TimelineItem::ToolResult { summary, .. } if summary == "PASS 87 tests"));
        assert!(matches!(&items[5], TimelineItem::TurnEnded { duration_ms: Some(1200), .. }));
        let pending = tail.pending_tool_calls();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].tool_use_id, "tu2");
    }

    #[test]
    fn edit_calls_carry_the_change() {
        let (_, items) = tail_with(&[
            r#"{"type":"assistant","uuid":"e","timestamp":"t","message":{"content":[{"type":"tool_use","id":"te","name":"Edit","input":{"file_path":"/a/b.ts","old_string":"let x = 1","new_string":"let x = 2"}}]}}"#,
            r#"{"type":"assistant","uuid":"w","timestamp":"t","message":{"content":[{"type":"tool_use","id":"tw","name":"Write","input":{"file_path":"/a/c.ts","content":"hello"}}]}}"#,
            r#"{"type":"assistant","uuid":"b","timestamp":"t","message":{"content":[{"type":"tool_use","id":"tb","name":"Bash","input":{"command":"ls"}}]}}"#,
        ]);
        let changes: Vec<Option<&FileChange>> = items
            .iter()
            .map(|i| match i {
                TimelineItem::ToolCall { change, .. } => change.as_ref(),
                _ => None,
            })
            .collect();
        assert_eq!(changes[0].unwrap().old.as_deref(), Some("let x = 1"));
        assert_eq!(changes[0].unwrap().new, "let x = 2");
        assert!(changes[1].unwrap().old.is_none());
        assert!(changes[2].is_none());
    }

    #[test]
    fn proposed_plan_carries_its_text() {
        let (tail, items) = tail_with(&[
            r#"{"type":"permission-mode","permissionMode":"plan","sessionId":"s"}"#,
            r##"{"type":"assistant","uuid":"p","timestamp":"t","message":{"content":[{"type":"tool_use","id":"tp","name":"ExitPlanMode","input":{"plan":"# Fix login\n\n1. Patch","planFilePath":"/x.md"}}]}}"##,
        ]);
        assert!(matches!(&items[0], TimelineItem::ToolCall { kind: ToolKind::Plan, plan: Some(p), .. } if p == "# Fix login\n\n1. Patch"));
        assert_eq!(tail.pending_tool_calls()[0].input["plan"], "# Fix login\n\n1. Patch");
        assert_eq!(tail.permission_mode(), Some("plan"));
    }

    #[test]
    fn plan_falls_back_to_its_file_inside_the_plans_dir() {
        let dir = std::env::temp_dir().join(format!("huntaway-plans-{}", std::process::id()));
        let plans = dir.join("plans");
        std::fs::create_dir_all(&plans).unwrap();
        std::fs::write(plans.join("swan.md"), "# From file\n").unwrap();
        std::fs::write(dir.join("outside.md"), "secret").unwrap();
        let input = |path: &Path| serde_json::json!({ "plan": "", "planFilePath": path.to_str().unwrap() });
        assert_eq!(plan_text(&input(&plans.join("swan.md")), &plans, None, None).as_deref(), Some("# From file"));
        assert_eq!(plan_text(&input(&dir.join("outside.md")), &plans, None, None), None);
        assert_eq!(plan_text(&input(&plans.join("../outside.md")), &plans, None, None), None);
        // No input at all: the session's plan file, then what was written.
        let empty = serde_json::json!({});
        assert_eq!(plan_text(&empty, &plans, Some("swan"), Some("old")).as_deref(), Some("# From file"));
        assert_eq!(plan_text(&empty, &plans, Some("gone"), Some("# Written")).as_deref(), Some("# Written"));
        assert_eq!(plan_text(&empty, &plans, Some("../outside"), None), None);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn permission_mode_follows_the_latest_entry() {
        let (tail, _) = tail_with(&[
            r#"{"type":"user","uuid":"u","timestamp":"t","permissionMode":"default","message":{"content":"hi"}}"#,
            r#"{"type":"user","uuid":"s","timestamp":"t","isSidechain":true,"permissionMode":"bypassPermissions","message":{"content":"sub"}}"#,
            r#"{"type":"permission-mode","permissionMode":"auto","sessionId":"s"}"#,
        ]);
        assert_eq!(tail.permission_mode(), Some("auto"));
    }

    #[test]
    fn reads_the_permission_mode_from_the_footer() {
        let screen = "● Done, plan mode on now.\n\n────────\n❯ \n────────\n  ⏸ plan mode on (shift+tab to cycle)\n";
        assert_eq!(screen_permission_mode(screen), Some("plan"));
        assert_eq!(screen_permission_mode("x\n────\n❯ \n────\n  ⏵⏵ auto mode on (shift+tab to cycle)"), Some("auto"));
        assert_eq!(screen_permission_mode("● plan mode on\n────\n❯ \n────\n  ? for shortcuts"), Some("default"));
        assert_eq!(screen_permission_mode(""), None);
    }

    #[test]
    fn rejected_permission_clears_pending_and_is_flagged() {
        let (tail, items) = tail_with(&[
            r#"{"type":"assistant","uuid":"a","timestamp":"t","message":{"content":[{"type":"tool_use","id":"tr","name":"Bash","input":{"command":"rm hello.txt"}}]}}"#,
            r#"{"type":"user","uuid":"u","timestamp":"t","message":{"content":[{"type":"tool_result","tool_use_id":"tr","is_error":true,"content":"The user doesn't want to proceed with this tool use. The tool use was rejected"}]}}"#,
            r#"{"type":"user","uuid":"i","timestamp":"t","message":{"content":[{"type":"text","text":"[Request interrupted by user for tool use]"}]}}"#,
        ]);
        assert!(matches!(&items[1], TimelineItem::ToolResult { rejected: true, summary, .. } if summary == "Denied"));
        assert!(matches!(&items[2], TimelineItem::Notice { .. }));
        assert!(tail.pending_tool_calls().is_empty());
    }

    #[test]
    fn hides_meta_and_formats_commands() {
        let (_, items) = tail_with(&[
            r#"{"type":"user","uuid":"m","isMeta":true,"timestamp":"t","message":{"content":"Caveat"}}"#,
            r#"{"type":"user","uuid":"c","timestamp":"t","message":{"content":"<command-name>/goal</command-name><command-args>faire la phase 0</command-args>"}}"#,
            r#"{"type":"user","uuid":"o","timestamp":"t","message":{"content":"<local-command-stdout>ok</local-command-stdout>"}}"#,
        ]);
        assert_eq!(items.len(), 1);
        assert!(matches!(&items[0], TimelineItem::UserMessage { text, .. } if text == "/goal faire la phase 0"));
    }

    #[test]
    fn compact_summary_is_a_notice() {
        let (_, items) = tail_with(&[
            r#"{"type":"user","uuid":"c","timestamp":"t","isCompactSummary":true,"isVisibleInTranscriptOnly":true,"message":{"role":"user","content":"This session is being continued from a previous conversation. Summary: …"}}"#,
        ]);
        assert_eq!(items.len(), 1);
        assert!(matches!(&items[0], TimelineItem::Notice { text, .. } if text == "Conversation compacted"));
    }

    #[test]
    fn subagent_transcript_tracks_its_pending_call() {
        let dir = std::env::temp_dir().join(format!("huntaway-sub-{}", std::process::id()));
        let subagents = dir.join("main-session").join("subagents");
        std::fs::create_dir_all(&subagents).unwrap();
        let main = dir.join("main-session.jsonl");
        std::fs::write(&main, "").unwrap();
        std::fs::write(subagents.join("agent-a1.meta.json"), r#"{"agentType":"general-purpose","toolUseId":"task1"}"#).unwrap();
        std::fs::write(
            subagents.join("agent-a1.jsonl"),
            r#"{"type":"assistant","uuid":"s1","isSidechain":true,"timestamp":"t","message":{"content":[{"type":"tool_use","id":"tb","name":"Bash","input":{"command":"rm -rf build"}}]}}"#.to_string() + "\n",
        )
        .unwrap();
        assert!(subagent_transcript(&main, "other").is_none());
        let path = subagent_transcript(&main, "task1").unwrap();
        let mut tail = TranscriptTail::with_parser(&path, subagent_parser);
        tail.poll().unwrap();
        let pending = tail.pending_tool_calls();
        assert_eq!(pending[0].summary, "rm -rf build");
    }

    #[test]
    fn hides_injected_task_notifications() {
        let (_, items) = tail_with(&[
            r#"{"type":"user","uuid":"n","timestamp":"t","message":{"content":"<task-notification>
<task-id>x</task-id></task-notification>"}}"#,
        ]);
        assert!(items.is_empty());
    }

    #[test]
    fn parses_questions_and_todos() {
        let (tail, items) = tail_with(&[
            r#"{"type":"assistant","uuid":"q","timestamp":"t","message":{"content":[{"type":"tool_use","id":"tq","name":"AskUserQuestion","input":{"questions":[{"question":"Stockage ?","header":"Token","multiSelect":false,"options":[{"label":"Secure storage","description":"sûr"},{"label":"Mémoire"}]}]}}]}}"#,
            r#"{"type":"assistant","uuid":"td","timestamp":"t","message":{"content":[{"type":"tool_use","id":"tt","name":"TodoWrite","input":{"todos":[{"content":"Refactor","status":"in_progress"}]}}]}}"#,
        ]);
        let question = items.iter().find_map(|i| match i {
            TimelineItem::QuestionAsked { questions, .. } => Some(questions),
            _ => None,
        });
        assert_eq!(question.unwrap()[0].options.len(), 2);
        assert_eq!(tail.todos()[0].status, "in_progress");
    }

    #[test]
    fn incremental_poll_handles_partial_lines() {
        let dir = std::env::temp_dir().join(format!("huntaway-partial-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("s.jsonl");
        let line = r#"{"type":"user","uuid":"u1","timestamp":"t","message":{"content":"hello"}}"#;
        std::fs::write(&path, &line[..20]).unwrap();
        let mut tail = TranscriptTail::new(&path);
        assert!(tail.poll().unwrap().is_empty());
        let mut f = std::fs::OpenOptions::new().append(true).open(&path).unwrap();
        writeln!(f, "{}", &line[20..]).unwrap();
        assert_eq!(tail.poll().unwrap().len(), 1);
        assert!(tail.poll().unwrap().is_empty());
    }
}
