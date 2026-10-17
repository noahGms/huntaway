//! Incremental transcript reader shared by agent adapters. Each agent
//! format provides a [`LineParser`]; the tail handles offsets, partial lines
//! and truncation.

use std::fs::File;
use std::io::{self, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::model::{TimelineItem, Todo, ToolKind, Usage};

/// Tool call without a result yet. While the agent is `blocked`, the last one
/// is the action waiting for approval.
#[derive(Debug, Clone)]
pub struct PendingTool {
    pub tool_use_id: String,
    pub kind: ToolKind,
    pub name: String,
    pub summary: String,
    pub input: Value,
    pub timestamp: String,
}

/// Turns transcript lines of one agent format into timeline items.
pub trait LineParser: Send {
    fn parse_line(&mut self, line: &str) -> Vec<TimelineItem>;
    fn pending(&self) -> Vec<&PendingTool>;
    fn todos(&self) -> &[Todo] {
        &[]
    }
    /// Token usage so far, with the model and an estimated cost.
    fn usage(&self) -> Option<Usage> {
        None
    }
    /// Title given to the conversation by the agent, if any.
    fn title(&self) -> Option<&str> {
        None
    }
}

/// Incremental reader: remembers the byte offset and buffers partial lines.
pub struct TranscriptTail {
    path: PathBuf,
    offset: u64,
    partial: String,
    make_parser: fn() -> Box<dyn LineParser>,
    parser: Box<dyn LineParser>,
}

impl TranscriptTail {
    /// Claude Code transcript (the historical default).
    pub fn new(path: impl AsRef<Path>) -> Self {
        Self::with_parser(path, crate::claude::parser)
    }

    pub fn codex(path: impl AsRef<Path>) -> Self {
        Self::with_parser(path, crate::codex::parser)
    }

    pub fn with_parser(path: impl AsRef<Path>, make_parser: fn() -> Box<dyn LineParser>) -> Self {
        Self { path: path.as_ref().to_path_buf(), offset: 0, partial: String::new(), make_parser, parser: make_parser() }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Returns the items appended since the previous call.
    pub fn poll(&mut self) -> io::Result<Vec<TimelineItem>> {
        let mut file = File::open(&self.path)?;
        let len = file.metadata()?.len();
        if len < self.offset {
            // Truncated or rewritten: start over.
            self.offset = 0;
            self.partial.clear();
            self.parser = (self.make_parser)();
        }
        if len == self.offset {
            return Ok(Vec::new());
        }
        file.seek(SeekFrom::Start(self.offset))?;
        let mut buf = Vec::with_capacity((len - self.offset) as usize);
        file.take(len - self.offset).read_to_end(&mut buf)?;
        self.offset = len;
        self.partial.push_str(&String::from_utf8_lossy(&buf));

        let mut items = Vec::new();
        while let Some(pos) = self.partial.find('\n') {
            let line: String = self.partial.drain(..=pos).collect();
            items.extend(self.parser.parse_line(line.trim()));
        }
        Ok(items)
    }

    pub fn pending_tool_calls(&self) -> Vec<&PendingTool> {
        self.parser.pending()
    }

    /// Latest todo list written by the agent.
    pub fn todos(&self) -> &[Todo] {
        self.parser.todos()
    }

    pub fn usage(&self) -> Option<Usage> {
        self.parser.usage()
    }

    pub fn title(&self) -> Option<&str> {
        self.parser.title()
    }

    /// Bytes read so far.
    pub fn offset(&self) -> u64 {
        self.offset
    }
}
