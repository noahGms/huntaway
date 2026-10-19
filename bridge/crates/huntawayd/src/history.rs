//! Past conversations (`GET /v1/history`): transcripts found on disk, with a
//! summary cache keyed by file size and date so a page costs a few reads.
//! The last opened timelines stay parsed: the next page, or the same
//! conversation grown by a few lines, costs no full re-read.

use std::collections::{HashMap, HashSet, VecDeque};
use std::path::PathBuf;
use std::sync::Mutex;

use huntaway_api::{HistoryEntry, HistoryPage, StoredItem, TimelinePage};
use huntaway_core::history::{self, Found, Summary};
use huntaway_core::transcript::TranscriptTail;

/// Parsed timelines kept in memory.
const TIMELINES_KEPT: usize = 4;

#[derive(Default)]
pub struct HistoryIndex {
    cache: Mutex<HashMap<PathBuf, (u64, u64, Summary)>>,
    /// Most recently used last.
    timelines: Mutex<VecDeque<ParsedTimeline>>,
}

struct ParsedTimeline {
    path: PathBuf,
    /// File size when last read.
    size: u64,
    tail: TranscriptTail,
    items: Vec<StoredItem>,
}

#[derive(Debug, Default, Clone)]
pub struct HistoryQuery {
    /// Only conversations last modified before this date (seconds since the epoch).
    pub before: Option<u64>,
    pub limit: usize,
    pub project: Option<String>,
    pub kind: Option<String>,
    /// Case-insensitive search in titles, first messages and directories.
    pub q: Option<String>,
}

impl HistoryIndex {
    fn summary(&self, found: &Found) -> Summary {
        if let Some((size, modified, summary)) = self.cache.lock().unwrap().get(&found.path) {
            if *size == found.size && *modified == found.modified {
                return summary.clone();
            }
        }
        let summary = history::summarize(found);
        self.cache.lock().unwrap().insert(found.path.clone(), (found.size, found.modified, summary.clone()));
        summary
    }

    /// One page, newest first. `live` maps native session ids to running agents.
    pub fn page(&self, query: &HistoryQuery, live: &HashMap<String, String>) -> HistoryPage {
        let q = query.q.as_deref().map(str::to_lowercase).filter(|q| !q.is_empty());
        let mut entries = Vec::new();
        let mut has_more = false;
        let all = history::list();
        {
            // Forget deleted transcripts.
            let mut cache = self.cache.lock().unwrap();
            if cache.len() > all.len() {
                let paths: HashSet<&PathBuf> = all.iter().map(|f| &f.path).collect();
                cache.retain(|p, _| paths.contains(p));
            }
        }
        for found in all {
            if query.before.is_some_and(|b| found.modified >= b) {
                continue;
            }
            if query.kind.as_deref().is_some_and(|k| k != found.kind) {
                continue;
            }
            let summary = self.summary(&found);
            if query.project.as_deref().is_some_and(|p| summary.project() != p && summary.cwd.as_deref() != Some(p)) {
                continue;
            }
            // Empty sessions (opened, nothing said) are noise.
            if summary.first_message.is_none() && summary.title.is_none() {
                continue;
            }
            if let Some(q) = &q {
                let hay = format!(
                    "{} {} {}",
                    summary.display_title(),
                    summary.first_message.as_deref().unwrap_or_default(),
                    summary.cwd.as_deref().unwrap_or_default()
                )
                .to_lowercase();
                if !hay.contains(q.as_str()) {
                    continue;
                }
            }
            if entries.len() == query.limit {
                has_more = true;
                break;
            }
            entries.push(entry(&found, &summary, live));
        }
        HistoryPage { entries, has_more }
    }

    pub fn get(&self, id: &str, live: &HashMap<String, String>) -> Option<(Found, HistoryEntry)> {
        let found = history::find(id)?;
        let summary = self.summary(&found);
        let entry = entry(&found, &summary, live);
        Some((found, entry))
    }
}

fn entry(found: &Found, summary: &Summary, live: &HashMap<String, String>) -> HistoryEntry {
    HistoryEntry {
        id: found.id(),
        kind: found.kind.to_string(),
        session_id: found.session_id.clone(),
        cwd: summary.cwd.clone(),
        project: summary.project(),
        title: summary.display_title(),
        started_at: summary.started_at.clone(),
        last_activity_at: summary.last_activity_at.clone(),
        model: summary.model.clone(),
        size_bytes: found.size,
        modified_at: found.modified,
        live_agent_id: live.get(&found.session_id).cloned(),
    }
}

impl HistoryIndex {
    /// Items of a transcript with `n < before`, oldest first.
    pub fn timeline(&self, found: &Found, before: Option<u64>, limit: usize) -> std::io::Result<TimelinePage> {
        let cached = {
            let mut timelines = self.timelines.lock().unwrap();
            timelines.iter().position(|t| t.path == found.path).and_then(|i| timelines.remove(i))
        };
        // A smaller file was rewritten: parse it again.
        let mut parsed = cached.filter(|t| found.size >= t.size).unwrap_or_else(|| ParsedTimeline {
            path: found.path.clone(),
            size: 0,
            tail: found.tail(),
            items: Vec::new(),
        });
        // Only the lines appended since the last read.
        for item in parsed.tail.poll()? {
            let n = parsed.items.len() as u64;
            parsed.items.push(StoredItem { n, item });
        }
        parsed.size = parsed.tail.offset();
        let mut page: Vec<StoredItem> =
            parsed.items.iter().rev().filter(|i| before.is_none_or(|b| i.n < b)).take(limit).cloned().collect();
        page.reverse();
        let has_more = page.first().is_some_and(|i| i.n > 0);
        let mut timelines = self.timelines.lock().unwrap();
        timelines.push_back(parsed);
        while timelines.len() > TIMELINES_KEPT {
            timelines.pop_front();
        }
        Ok(TimelinePage { items: page, has_more, older_in_history: false })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn timeline_pages_reuse_the_parsed_transcript() {
        let dir = std::env::temp_dir().join(format!("huntaway-history-index-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("s.jsonl");
        let line = |i: usize| format!(r#"{{"type":"user","uuid":"u{i}","timestamp":"t","message":{{"content":"m{i}"}}}}"#);
        std::fs::write(&path, (0..5).map(line).collect::<Vec<_>>().join("\n") + "\n").unwrap();
        let found = |path: &PathBuf| Found {
            kind: "claude",
            session_id: "s".into(),
            size: std::fs::metadata(path).unwrap().len(),
            modified: 0,
            path: path.clone(),
        };
        let index = HistoryIndex::default();
        let page = index.timeline(&found(&path), None, 2).unwrap();
        assert_eq!(page.items.iter().map(|i| i.n).collect::<Vec<_>>(), [3, 4]);
        assert!(page.has_more);
        let page = index.timeline(&found(&path), Some(3), 10).unwrap();
        assert_eq!(page.items.len(), 3);
        assert!(!page.has_more);
        // Appended lines continue the numbering.
        let mut f = std::fs::OpenOptions::new().append(true).open(&path).unwrap();
        writeln!(f, "{}", line(5)).unwrap();
        let page = index.timeline(&found(&path), None, 1).unwrap();
        assert_eq!(page.items[0].n, 5);
        // A rewritten, shorter file starts over.
        std::fs::write(&path, line(9) + "\n").unwrap();
        let page = index.timeline(&found(&path), None, 10).unwrap();
        assert_eq!(page.items.len(), 1);
        assert_eq!(page.items[0].n, 0);
    }
}
