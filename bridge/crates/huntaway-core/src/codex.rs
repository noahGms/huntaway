//! Codex adapter: locates and parses rollout files
//! (`~/.codex/sessions/YYYY/MM/DD/rollout-<time>-<session id>.jsonl`).
//!
//! Each line is `{"timestamp", "type", "payload"}`. The conversation comes
//! from `event_msg`: `user_message` / `agent_message` up to Codex 0.14x,
//! `item_completed` (`UserMessage`, `AgentMessage`) from 0.16x; tool calls
//! from `response_item` (`function_call`, `custom_tool_call` and their
//! `*_output`); turn ends from `task_complete`.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::model::{FileChange, RateLimits, RateWindow, TimelineItem, ToolKind, Usage};
use crate::transcript::{LineParser, PendingTool};

/// Codex home: `$CODEX_HOME` or `~/.codex`.
pub fn home_dir() -> PathBuf {
    match std::env::var("CODEX_HOME") {
        Ok(dir) if !dir.is_empty() => PathBuf::from(dir),
        _ => PathBuf::from(std::env::var("HOME").unwrap_or_else(|_| ".".into())).join(".codex"),
    }
}

/// Finds the rollout file of a session, newest day directories first.
pub fn transcript_path(session_id: &str) -> Option<PathBuf> {
    find_rollout(&home_dir().join("sessions"), &format!("{session_id}.jsonl"))
}

/// Fallback when the Herdr hook did not report a session id (seen with
/// Codex 0.161): the newest rollout started in `cwd` after `not_before`
/// (seconds since the epoch) that is not already followed by another agent.
pub fn transcript_by_cwd(cwd: &str, not_before: u64, taken: &[PathBuf]) -> Option<PathBuf> {
    let mut best: Option<(String, PathBuf)> = None;
    for dir in recent_day_dirs(&home_dir().join("sessions"), 3) {
        for entry in std::fs::read_dir(&dir).ok()?.flatten() {
            let path = entry.path();
            let fresh = entry
                .metadata()
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .is_some_and(|d| d.as_secs() >= not_before);
            if !fresh || taken.contains(&path) || path.extension().is_none_or(|e| e != "jsonl") {
                continue;
            }
            let Some((meta_cwd, started)) = session_meta(&path) else { continue };
            if meta_cwd != cwd || epoch_of(&started).is_none_or(|t| t + 1 < not_before) {
                continue;
            }
            // Earliest session started after the agent appeared.
            if best.as_ref().is_none_or(|(s, _)| started < *s) {
                best = Some((started, path));
            }
        }
    }
    best.map(|(_, p)| p)
}

/// `(cwd, start timestamp)` from the first `session_meta` line.
fn session_meta(path: &Path) -> Option<(String, String)> {
    use std::io::BufRead;
    let file = std::fs::File::open(path).ok()?;
    let mut line = String::new();
    std::io::BufReader::new(file).read_line(&mut line).ok()?;
    let v: Value = serde_json::from_str(&line).ok()?;
    if v["type"] != "session_meta" {
        return None;
    }
    let p = &v["payload"];
    let started = p["timestamp"].as_str().or(v["timestamp"].as_str())?.to_string();
    Some((p["cwd"].as_str()?.to_string(), started))
}

/// Newest `count` leaf directories of `sessions/YYYY/MM/DD`.
fn recent_day_dirs(root: &Path, count: usize) -> Vec<PathBuf> {
    fn sorted_dirs(dir: &Path) -> Vec<PathBuf> {
        let mut dirs: Vec<PathBuf> = std::fs::read_dir(dir)
            .map(|r| r.flatten().map(|e| e.path()).filter(|p| p.is_dir()).collect())
            .unwrap_or_default();
        dirs.sort_by(|a, b| b.cmp(a));
        dirs
    }
    let mut out = Vec::new();
    for year in sorted_dirs(root) {
        for month in sorted_dirs(&year) {
            for day in sorted_dirs(&month) {
                out.push(day);
                if out.len() == count {
                    return out;
                }
            }
        }
    }
    out
}

/// Seconds since the epoch of an RFC 3339 UTC timestamp (`2026-10-08T07:15:21.283Z`).
pub fn epoch_of(ts: &str) -> Option<u64> {
    let date = ts.get(0..10)?;
    let time = ts.get(11..19)?;
    let mut d = date.split('-').map(|x| x.parse::<i64>());
    let (y, m, day) = (d.next()?.ok()?, d.next()?.ok()?, d.next()?.ok()?);
    let mut t = time.split(':').map(|x| x.parse::<i64>());
    let (h, min, s) = (t.next()?.ok()?, t.next()?.ok()?, t.next()?.ok()?);
    // Days from civil (Howard Hinnant).
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    u64::try_from(days * 86_400 + h * 3600 + min * 60 + s).ok()
}

fn find_rollout(dir: &Path, suffix: &str) -> Option<PathBuf> {
    let mut entries: Vec<PathBuf> = std::fs::read_dir(dir).ok()?.flatten().map(|e| e.path()).collect();
    // Date directories sort lexically: newest first.
    entries.sort_by(|a, b| b.cmp(a));
    for path in &entries {
        if path.is_file() && path.file_name().is_some_and(|n| n.to_string_lossy().ends_with(suffix)) {
            return Some(path.clone());
        }
    }
    entries.iter().filter(|p| p.is_dir()).find_map(|d| find_rollout(d, suffix))
}

/// Codex rollout parser.
pub fn parser() -> Box<dyn LineParser> {
    Box::<Parser>::default()
}

#[derive(Default)]
pub struct Parser {
    pending: BTreeMap<u64, PendingTool>,
    pending_seq: u64,
    line_no: u64,
    /// An agent message was seen since the last user message.
    answered: bool,
    /// Last message text per role, to drop the same message reported twice.
    last_user: String,
    last_agent: String,
    model: Option<String>,
    usage: Option<Usage>,
}

fn rate_window(v: &Value) -> Option<RateWindow> {
    Some(RateWindow {
        used_percent: v["used_percent"].as_f64()?,
        window_minutes: v["window_minutes"].as_u64(),
        resets_at: v["resets_at"].as_u64(),
    })
}

/// `token_count` event → usage. Codex counts cached tokens inside `input_tokens`.
fn token_usage(p: &Value, previous: Option<&Usage>) -> Option<Usage> {
    let info = &p["info"];
    let total = &info["total_token_usage"];
    let mut usage = previous.cloned().unwrap_or_default();
    if total.is_object() {
        let get = |k: &str| total[k].as_u64().unwrap_or(0);
        let cached = get("cached_input_tokens");
        usage.input_tokens = get("input_tokens").saturating_sub(cached);
        usage.cache_read_tokens = cached;
        usage.cache_write_tokens = get("cache_write_input_tokens");
        usage.output_tokens = get("output_tokens");
        usage.context_tokens = info["last_token_usage"]["input_tokens"].as_u64().unwrap_or(0)
            + info["last_token_usage"]["output_tokens"].as_u64().unwrap_or(0);
        usage.context_window = info["model_context_window"].as_u64().or(usage.context_window);
    }
    let limits = &p["rate_limits"];
    if limits.is_object() {
        usage.rate_limits = Some(RateLimits {
            primary: rate_window(&limits["primary"]),
            secondary: rate_window(&limits["secondary"]),
            plan_type: limits["plan_type"].as_str().map(str::to_string),
        });
    }
    (total.is_object() || limits.is_object()).then_some(usage)
}

impl LineParser for Parser {
    fn parse_line(&mut self, line: &str) -> Vec<TimelineItem> {
        self.line_no += 1;
        let Ok(entry) = serde_json::from_str::<Value>(line) else { return Vec::new() };
        let timestamp = entry["timestamp"].as_str().unwrap_or_default().to_string();
        let uuid = format!("codex-{}", self.line_no);
        let p = &entry["payload"];
        match (entry["type"].as_str(), p["type"].as_str()) {
            (Some("event_msg"), Some("user_message")) => {
                self.user_message(p["message"].as_str().unwrap_or_default(), uuid, timestamp)
            }
            (Some("event_msg"), Some("agent_message")) => {
                self.agent_message(p["message"].as_str().unwrap_or_default(), uuid, timestamp)
            }
            (Some("event_msg"), Some("item_completed")) => {
                let item = &p["item"];
                match item["type"].as_str() {
                    Some("UserMessage") => self.user_message(&content_text(&item["content"]), uuid, timestamp),
                    Some("AgentMessage") => self.agent_message(&content_text(&item["content"]), uuid, timestamp),
                    _ => Vec::new(),
                }
            }
            (Some("event_msg"), Some("task_complete")) => {
                let mut items = Vec::new();
                // API errors (unsupported model, quota…) are only shown on screen.
                if !self.answered && p["last_agent_message"].as_str().is_none_or(str::is_empty) {
                    items.push(TimelineItem::Notice {
                        timestamp: timestamp.clone(),
                        text: "Codex n'a pas répondu (erreur ?) — voir le terminal".into(),
                    });
                }
                self.answered = true;
                items.push(TimelineItem::TurnEnded { timestamp, duration_ms: p["duration_ms"].as_u64() });
                items
            }
            (Some("turn_context"), _) => {
                if let Some(model) = p["model"].as_str() {
                    self.model = Some(model.to_string());
                }
                Vec::new()
            }
            (Some("event_msg"), Some("token_count")) => {
                if let Some(usage) = token_usage(p, self.usage.as_ref()) {
                    self.usage = Some(usage);
                }
                Vec::new()
            }
            (Some("event_msg"), Some("turn_aborted")) => {
                vec![TimelineItem::Notice { timestamp, text: "Interrompu par l'utilisateur".into() }]
            }
            (Some("response_item"), Some("function_call" | "custom_tool_call")) => self.tool_call(p, uuid, timestamp),
            (Some("response_item"), Some("function_call_output" | "custom_tool_call_output")) => {
                let call_id = p["call_id"].as_str().unwrap_or_default().to_string();
                self.pending.retain(|_, t| t.tool_use_id != call_id);
                let (text, code) = unwrap_exec_output(&output_text(&p["output"]));
                vec![TimelineItem::ToolResult {
                    timestamp,
                    tool_use_id: call_id,
                    is_error: code.or_else(|| exit_code(&text)).is_some_and(|c| c != 0),
                    rejected: text.contains("rejected by user") || text.contains("declined"),
                    summary: first_meaningful_line(&text),
                }]
            }
            _ => Vec::new(),
        }
    }

    fn pending(&self) -> Vec<&PendingTool> {
        self.pending.values().collect()
    }

    fn usage(&self) -> Option<Usage> {
        if self.model.is_none() && self.usage.is_none() {
            return None;
        }
        let mut usage = self.usage.clone().unwrap_or_default();
        usage.model = self.model.clone();
        usage.cost_usd = crate::pricing::estimate(&usage);
        Some(usage)
    }
}

impl Parser {
    fn user_message(&mut self, text: &str, uuid: String, timestamp: String) -> Vec<TimelineItem> {
        let text = text.trim().to_string();
        if text.is_empty() || text == self.last_user {
            return Vec::new();
        }
        self.last_user = text.clone();
        self.last_agent.clear();
        self.answered = false;
        vec![TimelineItem::UserMessage { uuid, timestamp, text }]
    }

    fn agent_message(&mut self, text: &str, uuid: String, timestamp: String) -> Vec<TimelineItem> {
        let text = text.trim().to_string();
        if text.is_empty() || text == self.last_agent {
            return Vec::new();
        }
        self.last_agent = text.clone();
        self.answered = true;
        vec![TimelineItem::AssistantMessage { uuid, timestamp, text, sidechain: false }]
    }

    fn tool_call(&mut self, p: &Value, uuid: String, timestamp: String) -> Vec<TimelineItem> {
        let name = p["name"].as_str().unwrap_or_default().to_string();
        let call_id = p["call_id"].as_str().unwrap_or_default().to_string();
        // function_call carries JSON `arguments`; custom tools a raw `input`.
        let input = p["arguments"]
            .as_str()
            .and_then(|a| serde_json::from_str::<Value>(a).ok())
            .unwrap_or_else(|| p["input"].clone());
        let raw = p["input"].as_str().unwrap_or_default();

        let (kind, summary, change) = match name.as_str() {
            "exec_command" | "shell" | "local_shell" => (ToolKind::Command, command_of(&input), None),
            "exec" => (ToolKind::Command, embedded_cmd(raw).unwrap_or_else(|| "script".into()), None),
            "apply_patch" => {
                let path = patch_path(raw).unwrap_or_default();
                let change = (!path.is_empty()).then(|| FileChange {
                    path: path.clone(),
                    old: None,
                    new: raw.chars().take(6000).collect(),
                    truncated: raw.chars().count() > 6000,
                });
                (ToolKind::FileModified, path, change)
            }
            "update_plan" => (ToolKind::Todo, "plan".into(), None),
            "web_search" => (ToolKind::Web, input["query"].as_str().unwrap_or_default().to_string(), None),
            _ => (ToolKind::Other, name.clone(), None),
        };
        let summary: String = summary.lines().next().unwrap_or_default().chars().take(120).collect();

        self.pending_seq += 1;
        self.pending.insert(
            self.pending_seq,
            PendingTool {
                tool_use_id: call_id.clone(),
                kind,
                name: name.clone(),
                summary: summary.clone(),
                input: if input.is_null() { Value::String(raw.into()) } else { input },
                timestamp: timestamp.clone(),
            },
        );
        vec![TimelineItem::ToolCall { uuid, timestamp, tool_use_id: call_id, name, kind, summary, sidechain: false, change }]
    }
}

fn command_of(input: &Value) -> String {
    match &input["cmd"] {
        Value::String(s) => s.clone(),
        Value::Array(parts) => parts.iter().filter_map(Value::as_str).collect::<Vec<_>>().join(" "),
        _ => match &input["command"] {
            Value::String(s) => s.clone(),
            Value::Array(parts) => {
                // ["bash", "-lc", "npm test"] → "npm test"
                let parts: Vec<&str> = parts.iter().filter_map(Value::as_str).collect();
                parts.last().filter(|_| parts.len() >= 3 && parts[1] == "-lc").map(|s| s.to_string()).unwrap_or_else(|| parts.join(" "))
            }
            _ => String::new(),
        },
    }
}

/// `tools.exec_command({"cmd":"npm test", …})` or `({cmd:"npm test", …})`
/// → `npm test`.
fn embedded_cmd(raw: &str) -> Option<String> {
    let start = raw.find("\"cmd\"").map(|i| i + 5).or_else(|| raw.find("cmd:").map(|i| i + 3))?;
    let rest = raw[start..].trim_start().strip_prefix(':')?.trim_start();
    // The value is a JSON string literal: let serde handle escapes.
    let mut de = serde_json::Deserializer::from_str(rest).into_iter::<String>();
    de.next()?.ok()
}

/// Text of `[{"type": "text"|"Text", "text": "…"}]` content arrays.
fn content_text(content: &Value) -> String {
    match content {
        Value::String(s) => s.clone(),
        Value::Array(parts) => parts.iter().filter_map(|p| p["text"].as_str()).collect::<Vec<_>>().join(""),
        _ => String::new(),
    }
}

/// First file named in an `apply_patch` body.
fn patch_path(raw: &str) -> Option<String> {
    raw.lines().find_map(|l| {
        ["*** Update File: ", "*** Add File: ", "*** Delete File: "]
            .iter()
            .find_map(|p| l.strip_prefix(p))
            .map(|p| p.trim().to_string())
    })
}

fn output_text(output: &Value) -> String {
    match output {
        Value::String(s) => s.clone(),
        Value::Array(parts) => parts.iter().filter_map(|p| p["text"].as_str()).collect::<Vec<_>>().join("\n"),
        other => other["output"].as_str().unwrap_or_default().to_string(),
    }
}

/// Codex 0.16 wraps command results in a JSON chunk
/// (`{"exit_code": 0, "output": "…"}`) after the runner banner: return the
/// real output and exit code.
fn unwrap_exec_output(text: &str) -> (String, Option<i64>) {
    for line in text.lines() {
        let line = line.trim();
        if line.starts_with('{') {
            if let Ok(chunk) = serde_json::from_str::<Value>(line) {
                if let Some(output) = chunk["output"].as_str() {
                    return (output.replace("\r\n", "\n"), chunk["exit_code"].as_i64());
                }
            }
        }
    }
    (text.to_string(), None)
}

fn exit_code(text: &str) -> Option<i64> {
    let idx = text.find("Exit code: ").or_else(|| text.find("exit code "))?;
    let rest = &text[idx..];
    let digits: String = rest.chars().skip_while(|c| !c.is_ascii_digit() && *c != '-').take_while(|c| c.is_ascii_digit() || *c == '-').collect();
    digits.parse().ok()
}

/// Skips Codex runner boilerplate ("Script completed", "Wall time…").
fn first_meaningful_line(text: &str) -> String {
    let line = text
        .lines()
        .map(str::trim)
        .find(|l| {
            !l.is_empty()
                && !l.starts_with("Script completed")
                && !l.starts_with("Wall time")
                && !l.starts_with("Output:")
                && !l.starts_with("Total output lines")
                && !l.starts_with("Chunk ID")
        })
        .unwrap_or_default();
    line.chars().take(160).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(lines: &[&str]) -> (Parser, Vec<TimelineItem>) {
        let mut p = Parser::default();
        let items = lines.iter().flat_map(|l| p.parse_line(l)).collect();
        (p, items)
    }

    #[test]
    fn parses_conversation_and_tools() {
        let (p, items) = parse(&[
            r#"{"timestamp":"t1","type":"session_meta","payload":{"id":"s"}}"#,
            r#"{"timestamp":"t2","type":"event_msg","payload":{"type":"user_message","message":"Corrige le bug"}}"#,
            r#"{"timestamp":"t3","type":"response_item","payload":{"type":"function_call","name":"exec_command","call_id":"c1","arguments":"{\"cmd\":\"npm test\",\"workdir\":\"/x\"}"}}"#,
            r#"{"timestamp":"t4","type":"response_item","payload":{"type":"function_call_output","call_id":"c1","output":[{"type":"input_text","text":"Script completed\nWall time 0.3 seconds\nOutput:\n"},{"type":"input_text","text":"Exit code: 1\nFAIL 2 tests"}]}}"#,
            r#"{"timestamp":"t5","type":"response_item","payload":{"type":"custom_tool_call","name":"exec","call_id":"c2","input":"const r = await tools.exec_command({\"cmd\":\"ls -la\",\"workdir\":\"/x\"});"}}"#,
            r#"{"timestamp":"t6","type":"response_item","payload":{"type":"custom_tool_call","name":"apply_patch","call_id":"c3","input":"*** Begin Patch\n*** Update File: src/app.ts\n@@\n-a\n+b\n*** End Patch"}}"#,
            r#"{"timestamp":"t7","type":"event_msg","payload":{"type":"agent_message","message":"Corrigé."}}"#,
            r#"{"timestamp":"t8","type":"event_msg","payload":{"type":"task_complete","duration_ms":1200,"last_agent_message":"Corrigé."}}"#,
        ]);
        assert!(matches!(&items[0], TimelineItem::UserMessage { text, .. } if text == "Corrige le bug"));
        assert!(matches!(&items[1], TimelineItem::ToolCall { kind: ToolKind::Command, summary, .. } if summary == "npm test"));
        assert!(matches!(&items[2], TimelineItem::ToolResult { is_error: true, summary, .. } if summary == "Exit code: 1"));
        assert!(matches!(&items[3], TimelineItem::ToolCall { summary, .. } if summary == "ls -la"));
        assert!(matches!(&items[4], TimelineItem::ToolCall { kind: ToolKind::FileModified, summary, change: Some(_), .. } if summary == "src/app.ts"));
        assert!(matches!(&items[5], TimelineItem::AssistantMessage { text, .. } if text == "Corrigé."));
        assert!(matches!(&items[6], TimelineItem::TurnEnded { duration_ms: Some(1200), .. }));
        // c2 and c3 have no output yet.
        let pending: Vec<&str> = p.pending().iter().map(|t| t.tool_use_id.as_str()).collect();
        assert_eq!(pending, ["c2", "c3"]);
    }

    #[test]
    fn turn_without_answer_leaves_a_notice() {
        let (_, items) = parse(&[
            r#"{"timestamp":"t1","type":"event_msg","payload":{"type":"user_message","message":"Salut"}}"#,
            r#"{"timestamp":"t2","type":"event_msg","payload":{"type":"task_complete","last_agent_message":null}}"#,
        ]);
        assert!(matches!(&items[1], TimelineItem::Notice { text, .. } if text.contains("n'a pas répondu")));
        assert!(matches!(&items[2], TimelineItem::TurnEnded { .. }));
    }

    #[test]
    fn codex_016_item_completed_format() {
        let (p, items) = parse(&[
            r#"{"timestamp":"t0","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"<environment_context>x</environment_context>"}]}}"#,
            r#"{"timestamp":"t1","type":"event_msg","payload":{"type":"item_completed","item":{"type":"UserMessage","id":"u","content":[{"type":"text","text":"Exécute ls"}]}}}"#,
            r#"{"timestamp":"t2","type":"event_msg","payload":{"type":"item_completed","item":{"type":"AgentMessage","id":"a","phase":"commentary","content":[{"type":"Text","text":"Je lance ls.\n"}]}}}"#,
            r#"{"timestamp":"t3","type":"response_item","payload":{"type":"custom_tool_call","name":"exec","call_id":"c1","input":"await tools.exec_command({cmd:\"ls -la\",max_output_tokens:1000});\n"}}"#,
            r#"{"timestamp":"t4","type":"response_item","payload":{"type":"custom_tool_call_output","call_id":"c1","output":"Script completed\nWall time 0.1 seconds\nOutput:\n"}}"#,
            r#"{"timestamp":"t5","type":"event_msg","payload":{"type":"item_completed","item":{"type":"CommandExecution","id":"x","command":"ls"}}}"#,
            r#"{"timestamp":"t6","type":"event_msg","payload":{"type":"item_completed","item":{"type":"AgentMessage","id":"b","phase":"final_answer","content":[{"type":"Text","text":"FINI"}]}}}"#,
            r#"{"timestamp":"t7","type":"event_msg","payload":{"type":"task_complete","last_agent_message":"FINI"}}"#,
        ]);
        let kinds: Vec<&str> = items
            .iter()
            .map(|i| match i {
                TimelineItem::UserMessage { .. } => "user",
                TimelineItem::AssistantMessage { .. } => "assistant",
                TimelineItem::ToolCall { .. } => "call",
                TimelineItem::ToolResult { .. } => "result",
                TimelineItem::TurnEnded { .. } => "end",
                _ => "other",
            })
            .collect();
        assert_eq!(kinds, ["user", "assistant", "call", "result", "assistant", "end"]);
        assert!(matches!(&items[2], TimelineItem::ToolCall { summary, .. } if summary == "ls -la"));
        assert!(p.pending().is_empty());
    }

    #[test]
    fn codex_016_exec_output_chunk_is_unwrapped() {
        let (out, code) = unwrap_exec_output("Script completed\nOutput:\n{\"chunk_id\":\"x\",\"exit_code\":2,\"output\":\"HTTP/2 404 \\r\\ndate: x\"}");
        assert_eq!(code, Some(2));
        assert_eq!(first_meaningful_line(&out), "HTTP/2 404");
    }

    #[test]
    fn same_message_reported_twice_is_kept_once() {
        let (_, items) = parse(&[
            r#"{"timestamp":"t1","type":"event_msg","payload":{"type":"user_message","message":"Salut"}}"#,
            r#"{"timestamp":"t1","type":"event_msg","payload":{"type":"item_completed","item":{"type":"UserMessage","content":[{"type":"text","text":"Salut"}]}}}"#,
        ]);
        assert_eq!(items.len(), 1);
    }

    #[test]
    fn reads_model_usage_and_limits() {
        let (p, _) = parse(&[
            r#"{"timestamp":"t0","type":"turn_context","payload":{"model":"gpt-5.4","cwd":"/x"}}"#,
            r#"{"timestamp":"t1","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":15653,"cached_input_tokens":12160,"output_tokens":8},"last_token_usage":{"input_tokens":15653,"output_tokens":8},"model_context_window":258400},"rate_limits":{"primary":{"used_percent":12.5,"window_minutes":300,"resets_at":1791461117},"secondary":{"used_percent":3.0,"window_minutes":10080},"plan_type":"plus"}}}"#,
        ]);
        let u = LineParser::usage(&p).unwrap();
        assert_eq!(u.model.as_deref(), Some("gpt-5.4"));
        assert_eq!(u.input_tokens, 3493);
        assert_eq!(u.cache_read_tokens, 12160);
        assert_eq!(u.context_tokens, 15661);
        assert_eq!(u.context_window, Some(258400));
        let limits = u.rate_limits.unwrap();
        assert_eq!(limits.primary.unwrap().used_percent, 12.5);
        assert_eq!(limits.plan_type.as_deref(), Some("plus"));
    }

    #[test]
    fn epoch_of_rfc3339() {
        assert_eq!(epoch_of("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(epoch_of("2026-10-08T07:15:21.283Z"), Some(1_791_443_721));
        assert_eq!(epoch_of("nope"), None);
    }

    #[test]
    fn command_arrays() {
        assert_eq!(command_of(&serde_json::json!({"command": ["bash", "-lc", "npm test"]})), "npm test");
        assert_eq!(command_of(&serde_json::json!({"cmd": ["git", "status"]})), "git status");
    }
}
