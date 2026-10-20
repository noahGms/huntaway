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
    /// Permission mode the agent runs in (Claude), if known.
    fn permission_mode(&self) -> Option<&str> {
        None
    }
}

/// Incremental reader: remembers the byte offset and buffers partial lines.
pub struct TranscriptTail {
    path: PathBuf,
    offset: u64,
    /// Bytes of the last, incomplete line. Kept as bytes: a read can end in
    /// the middle of a multi-byte character.
    partial: Vec<u8>,
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
        Self { path: path.as_ref().to_path_buf(), offset: 0, partial: Vec::new(), make_parser, parser: make_parser() }
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
        self.partial.extend_from_slice(&buf);

        let mut items = Vec::new();
        let mut start = 0;
        while let Some(pos) = self.partial[start..].iter().position(|&b| b == b'\n') {
            let line = String::from_utf8_lossy(&self.partial[start..start + pos]);
            items.extend(self.parser.parse_line(line.trim()));
            start += pos + 1;
        }
        self.partial.drain(..start);
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

    pub fn permission_mode(&self) -> Option<&str> {
        self.parser.permission_mode()
    }

    /// Bytes read so far.
    pub fn offset(&self) -> u64 {
        self.offset
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn multibyte_character_split_between_reads_is_kept() {
        let dir = std::env::temp_dir().join(format!("huntaway-utf8-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("s.jsonl");
        let line = r#"{"type":"user","uuid":"u1","timestamp":"t","message":{"content":"café 🐕"}}"#;
        let cut = line.find('é').unwrap() + 1; // inside the two bytes of `é`
        std::fs::write(&path, &line.as_bytes()[..cut]).unwrap();
        let mut tail = TranscriptTail::new(&path);
        assert!(tail.poll().unwrap().is_empty());
        let mut f = std::fs::OpenOptions::new().append(true).open(&path).unwrap();
        f.write_all(&line.as_bytes()[cut..]).unwrap();
        f.write_all(b"\n").unwrap();
        let items = tail.poll().unwrap();
        assert!(matches!(&items[0], TimelineItem::UserMessage { text, .. } if text == "café 🐕"));
    }
}
