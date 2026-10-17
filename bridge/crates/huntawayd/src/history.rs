//! Past conversations (`GET /v1/history`): transcripts found on disk, with a
//! summary cache keyed by file size and date so a page costs a few reads.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

use huntaway_api::{HistoryEntry, HistoryPage, StoredItem, TimelinePage};
use huntaway_core::history::{self, Found, Summary};

#[derive(Default)]
pub struct HistoryIndex {
    cache: Mutex<HashMap<PathBuf, (u64, u64, Summary)>>,
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
        for found in history::list() {
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

/// Reads a whole transcript and returns items with `n < before`, oldest first.
pub fn timeline(found: &Found, before: Option<u64>, limit: usize) -> std::io::Result<TimelinePage> {
    let mut tail = found.tail();
    let items = tail.poll()?;
    let stored: Vec<StoredItem> = items.into_iter().enumerate().map(|(n, item)| StoredItem { n: n as u64, item }).collect();
    let mut page: Vec<StoredItem> = stored.into_iter().rev().filter(|i| before.is_none_or(|b| i.n < b)).take(limit).collect();
    page.reverse();
    let has_more = page.first().is_some_and(|i| i.n > 0);
    Ok(TimelinePage { items: page, has_more })
}
