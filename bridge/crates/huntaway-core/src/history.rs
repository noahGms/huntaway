//! Past conversations on disk: Claude Code transcripts
//! (`~/.claude/projects/<dir>/<session>.jsonl`) and Codex rollouts
//! (`~/.codex/sessions/YYYY/MM/DD/rollout-<time>-<session>.jsonl`).
//!
//! Listing only reads file metadata; [`summarize`] reads the beginning and
//! the end of one file to get its directory, title, dates and model.

use std::fs::File;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde_json::Value;

use crate::model::TimelineItem;
use crate::transcript::{LineParser, TranscriptTail};
use crate::{claude, codex};

/// A transcript file found on disk.
#[derive(Debug, Clone, PartialEq)]
pub struct Found {
    /// `claude` or `codex`.
    pub kind: &'static str,
    pub session_id: String,
    pub path: PathBuf,
    pub size: u64,
    /// Seconds since the epoch.
    pub modified: u64,
}

impl Found {
    pub fn id(&self) -> String {
        format!("{}:{}", self.kind, self.session_id)
    }

    pub fn tail(&self) -> TranscriptTail {
        match self.kind {
            "codex" => TranscriptTail::codex(&self.path),
            _ => TranscriptTail::new(&self.path),
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Summary {
    pub cwd: Option<String>,
    pub title: Option<String>,
    pub first_message: Option<String>,
    pub started_at: Option<String>,
    pub last_activity_at: Option<String>,
    pub model: Option<String>,
}

impl Summary {
    pub fn display_title(&self) -> String {
        self.title
            .clone()
            .or_else(|| self.first_message.clone())
            .unwrap_or_else(|| "Conversation sans titre".into())
    }

    pub fn project(&self) -> String {
        self.cwd
            .as_deref()
            .map(|c| c.rsplit('/').find(|s| !s.is_empty()).unwrap_or(c).to_string())
            .unwrap_or_default()
    }
}

fn modified_secs(meta: &std::fs::Metadata) -> u64 {
    meta.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map_or(0, |d| d.as_secs())
}

/// Every transcript of both agents, newest first.
pub fn list() -> Vec<Found> {
    let mut found = list_claude(&claude::config_dir().join("projects"));
    found.extend(list_codex(&codex::home_dir().join("sessions")));
    found.sort_by_key(|f| std::cmp::Reverse(f.modified));
    found
}

fn list_claude(projects: &Path) -> Vec<Found> {
    let mut out = Vec::new();
    for project in std::fs::read_dir(projects).into_iter().flatten().flatten() {
        // Only direct children: sub-agent transcripts live in nested folders.
        for entry in std::fs::read_dir(project.path()).into_iter().flatten().flatten() {
            let path = entry.path();
            if path.extension().is_none_or(|e| e != "jsonl") {
                continue;
            }
            let Ok(meta) = entry.metadata() else { continue };
            if !meta.is_file() || meta.len() == 0 {
                continue;
            }
            let Some(session_id) = path.file_stem().map(|s| s.to_string_lossy().to_string()) else { continue };
            out.push(Found { kind: "claude", session_id, size: meta.len(), modified: modified_secs(&meta), path });
        }
    }
    out
}

fn list_codex(root: &Path) -> Vec<Found> {
    let mut out = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        for entry in std::fs::read_dir(&dir).into_iter().flatten().flatten() {
            let path = entry.path();
            let Ok(meta) = entry.metadata() else { continue };
            if meta.is_dir() {
                stack.push(path);
                continue;
            }
            let name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
            if !name.starts_with("rollout-") || !name.ends_with(".jsonl") || meta.len() == 0 {
                continue;
            }
            // rollout-2026-10-08T09-18-38-<uuid>.jsonl
            let stem = name.trim_end_matches(".jsonl");
            let session_id = if stem.len() >= 36 { stem[stem.len() - 36..].to_string() } else { stem.to_string() };
            out.push(Found { kind: "codex", session_id, size: meta.len(), modified: modified_secs(&meta), path });
        }
    }
    out
}

/// Finds a transcript by its history id (`claude:<id>` / `codex:<id>`).
pub fn find(id: &str) -> Option<Found> {
    let (kind, session) = id.split_once(':')?;
    let path = match kind {
        "claude" => claude::transcript_path(None, session)?,
        "codex" => codex::transcript_path(session)?,
        _ => return None,
    };
    let meta = std::fs::metadata(&path).ok()?;
    Some(Found {
        kind: if kind == "codex" { "codex" } else { "claude" },
        session_id: session.to_string(),
        size: meta.len(),
        modified: modified_secs(&meta),
        path,
    })
}

/// Bytes read from the start of a file to find the directory and the first message.
const HEAD_MAX: u64 = 4 * 1024 * 1024;
/// Bytes read from the end of a file for the latest title, model and date.
const TAIL_BYTES: u64 = 256 * 1024;

/// Lines that are large and useless here (Claude Code request dumps).
fn skippable(line: &str) -> bool {
    line.starts_with(r#"{"type":"api-request"#) || line.starts_with(r#"{"type":"file-history"#)
}

fn first_line(text: &str, max: usize) -> String {
    let line = text.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or_default();
    if line.chars().count() > max {
        format!("{}…", line.chars().take(max).collect::<String>())
    } else {
        line.to_string()
    }
}

pub fn summarize(found: &Found) -> Summary {
    let mut summary = Summary::default();
    let make_parser: fn() -> Box<dyn LineParser> = if found.kind == "codex" { codex::parser } else { claude::parser };

    // Head: directory, start date, first user message.
    let mut head_parser = make_parser();
    if let Ok(file) = File::open(&found.path) {
        let mut reader = BufReader::new(file.take(HEAD_MAX));
        let mut line = String::new();
        while reader.read_line(&mut line).unwrap_or(0) > 0 {
            let text = line.trim();
            if !text.is_empty() && !skippable(text) {
                if summary.cwd.is_none() || summary.started_at.is_none() {
                    if let Ok(v) = serde_json::from_str::<Value>(text) {
                        let payload = &v["payload"];
                        summary.cwd = summary
                            .cwd
                            .take()
                            .or_else(|| v["cwd"].as_str().map(str::to_string))
                            .or_else(|| payload["cwd"].as_str().map(str::to_string));
                        if summary.started_at.is_none() {
                            summary.started_at = v["timestamp"].as_str().or(payload["timestamp"].as_str()).map(str::to_string);
                        }
                    }
                }
                if summary.first_message.is_none() {
                    for item in head_parser.parse_line(text) {
                        match item {
                            // Slash commands (`/clear`, `/model`) say nothing about the conversation.
                            TimelineItem::UserMessage { text, .. } if !text.starts_with('/') => {
                                summary.first_message = Some(first_line(&text, 90));
                                break;
                            }
                            _ => {}
                        }
                    }
                }
            }
            if summary.cwd.is_some() && summary.first_message.is_some() && summary.started_at.is_some() {
                break;
            }
            line.clear();
        }
    }
    summary.title = head_parser.title().map(str::to_string);
    summary.model = head_parser.usage().and_then(|u| u.model);

    // Tail: latest title, model and activity date.
    if let Ok(mut file) = File::open(&found.path) {
        let start = found.size.saturating_sub(TAIL_BYTES);
        if file.seek(SeekFrom::Start(start)).is_ok() {
            let mut buf = Vec::new();
            if file.take(TAIL_BYTES).read_to_end(&mut buf).is_ok() {
                let text = String::from_utf8_lossy(&buf);
                let mut lines = text.lines();
                if start > 0 {
                    lines.next(); // partial line
                }
                let mut tail_parser = make_parser();
                for line in lines {
                    let line = line.trim();
                    if line.is_empty() || skippable(line) {
                        continue;
                    }
                    if let Ok(v) = serde_json::from_str::<Value>(line) {
                        if let Some(ts) = v["timestamp"].as_str() {
                            summary.last_activity_at = Some(ts.to_string());
                        }
                    }
                    tail_parser.parse_line(line);
                }
                if let Some(title) = tail_parser.title() {
                    summary.title = Some(title.to_string());
                }
                if let Some(model) = tail_parser.usage().and_then(|u| u.model) {
                    summary.model = Some(model);
                }
            }
        }
    }
    summary
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn summarizes_a_claude_transcript() {
        let dir = std::env::temp_dir().join(format!("huntaway-history-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("abc.jsonl");
        std::fs::write(
            &path,
            [
                r#"{"type":"mode","mode":"normal"}"#,
                r#"{"type":"user","uuid":"u1","timestamp":"2026-10-17T09:00:00Z","cwd":"/Users/me/api","message":{"content":"Corrige le login\net le reste"}}"#,
                r#"{"type":"assistant","uuid":"a1","timestamp":"2026-10-17T09:01:00Z","message":{"id":"m","model":"claude-sonnet-4-5","content":[{"type":"text","text":"ok"}]}}"#,
                r#"{"type":"ai-title","aiTitle":"fix-login"}"#,
            ]
            .join("\n"),
        )
        .unwrap();
        let found = Found { kind: "claude", session_id: "abc".into(), size: std::fs::metadata(&path).unwrap().len(), modified: 0, path };
        let s = summarize(&found);
        assert_eq!(s.cwd.as_deref(), Some("/Users/me/api"));
        assert_eq!(s.project(), "api");
        assert_eq!(s.first_message.as_deref(), Some("Corrige le login"));
        assert_eq!(s.title.as_deref(), Some("fix-login"));
        assert_eq!(s.model.as_deref(), Some("claude-sonnet-4-5"));
        assert_eq!(s.started_at.as_deref(), Some("2026-10-17T09:00:00Z"));
        assert_eq!(s.last_activity_at.as_deref(), Some("2026-10-17T09:01:00Z"));
    }

    #[test]
    fn codex_session_id_from_file_name() {
        let root = std::env::temp_dir().join(format!("huntaway-codex-{}", std::process::id()));
        let day = root.join("2026/10/08");
        std::fs::create_dir_all(&day).unwrap();
        std::fs::write(day.join("rollout-2026-10-08T09-18-38-01a11a60-dcc3-77d3-a6e3-8be8001fc411.jsonl"), "{}\n").unwrap();
        let found = list_codex(&root);
        assert_eq!(found[0].session_id, "01a11a60-dcc3-77d3-a6e3-8be8001fc411");
        assert_eq!(found[0].id(), "codex:01a11a60-dcc3-77d3-a6e3-8be8001fc411");
    }
}
