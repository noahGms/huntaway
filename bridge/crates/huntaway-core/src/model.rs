//! Agent-agnostic timeline items shown in the conversation. The types live in
//! `huntaway-api` so the daemon and its clients share them.

pub use huntaway_api::{FileChange, Question, QuestionOption, TimelineItem, Todo, ToolKind, Usage, RateLimits, RateWindow};
