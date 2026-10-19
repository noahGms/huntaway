//! Types of the `huntawayd` API (`docs/api.md`), shared by the daemon, the
//! Rust client and — through generated TypeScript — the desktop front end.
//!
//! JSON is `snake_case`. Clients must ignore unknown fields and event types,
//! so every addition here has to stay optional for older clients.

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[cfg(feature = "ts")]
use ts_rs::TS;

/// Every permission a device can hold.
pub const ALL_PERMISSIONS: &[&str] = &[
    "projects.read",
    "agents.read",
    "agents.message",
    "agents.approve",
    "agents.interrupt",
    "agents.input",
    "agents.create",
    "agents.resume",
    "terminal.read",
    "history.read",
    "files.read",
    "scripts.read",
    "scripts.run",
    "scripts.edit",
    "terminal.open",
    "skills.read",
    "skills.edit",
    "daemon.update",
];

// ------------------------------------------------------------------ timeline

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS), ts(export))]
#[serde(rename_all = "snake_case")]
pub enum ToolKind {
    FileRead,
    Search,
    FileModified,
    Command,
    Todo,
    Question,
    Plan,
    Subagent,
    Web,
    /// Starts or prompts another Herdr agent (`herdr agent start/prompt`, `huntawayd dispatch`).
    Agent,
    #[serde(other)]
    Other,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS), ts(export))]
pub struct Todo {
    pub content: String,
    pub status: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS), ts(export))]
pub struct QuestionOption {
    pub label: String,
    pub description: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS), ts(export))]
pub struct Question {
    pub header: Option<String>,
    pub question: String,
    pub options: Vec<QuestionOption>,
    pub multi_select: bool,
}

/// Herdr agent started or prompted by a command of the agent (see
/// [`ToolKind::Agent`]). Fields are what the command line names.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS), ts(export))]
pub struct AgentLaunch {
    /// Herdr agent name (`herdr agent start <name>`).
    pub name: Option<String>,
    /// Pane the agent was started in (`--pane`).
    pub pane_id: Option<String>,
    /// Agent kind (`--kind codex`).
    pub kind: Option<String>,
    /// Task sent to it (`herdr agent prompt <name> "…"`).
    pub prompt: Option<String>,
    /// Whether the command starts the agent (else it only prompts one).
    pub start: bool,
}

/// File change carried by an edit tool call, for the diff preview.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS), ts(export))]
pub struct FileChange {
    pub path: String,
    /// Replaced text; `None` for a whole-file write.
    pub old: Option<String>,
    pub new: String,
    /// Texts were cut to keep events small.
    pub truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS), ts(export))]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum TimelineItem {
    UserMessage {
        uuid: String,
        timestamp: String,
        text: String,
    },
    AssistantMessage {
        uuid: String,
        timestamp: String,
        text: String,
        sidechain: bool,
    },
    ToolCall {
        uuid: String,
        timestamp: String,
        tool_use_id: String,
        name: String,
        kind: ToolKind,
        /// Short human summary: file path, command, pattern…
        summary: String,
        sidechain: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[cfg_attr(feature = "ts", ts(optional))]
        change: Option<FileChange>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[cfg_attr(feature = "ts", ts(optional))]
        agent: Option<Box<AgentLaunch>>,
    },
    /// Reasoning the agent shows (Claude thinking, Codex reasoning summary).
    Thinking {
        timestamp: String,
        text: String,
        sidechain: bool,
    },
    ToolResult {
        timestamp: String,
        tool_use_id: String,
        is_error: bool,
        /// The user declined the permission prompt for this call.
        rejected: bool,
        /// First meaningful line of the output.
        summary: String,
    },
    TodosUpdated {
        timestamp: String,
        todos: Vec<Todo>,
    },
    QuestionAsked {
        timestamp: String,
        tool_use_id: String,
        questions: Vec<Question>,
    },
    /// The agent finished a turn and is waiting for the user.
    TurnEnded {
        timestamp: String,
        duration_ms: Option<u64>,
    },
    /// Agent-written recap of what happened while the user was away.
    AwaySummary {
        timestamp: String,
        text: String,
    },
    /// Interruptions, local command output and other notices.
    Notice {
        timestamp: String,
        text: String,
    },
}

impl TimelineItem {
    pub fn timestamp(&self) -> &str {
        match self {
            TimelineItem::UserMessage { timestamp, .. }
            | TimelineItem::AssistantMessage { timestamp, .. }
            | TimelineItem::ToolCall { timestamp, .. }
            | TimelineItem::Thinking { timestamp, .. }
            | TimelineItem::ToolResult { timestamp, .. }
            | TimelineItem::TodosUpdated { timestamp, .. }
            | TimelineItem::QuestionAsked { timestamp, .. }
            | TimelineItem::TurnEnded { timestamp, .. }
            | TimelineItem::AwaySummary { timestamp, .. }
            | TimelineItem::Notice { timestamp, .. } => timestamp,
        }
    }
}

/// Timeline item with its position in the transcript.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS), ts(export))]
pub struct StoredItem {
    /// Position in the transcript, stable across daemon restarts.
    pub n: u64,
    #[serde(flatten)]
    pub item: TimelineItem,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS), ts(export))]
pub struct TimelinePage {
    pub items: Vec<StoredItem>,
    pub has_more: bool,
}

// ----------------------------------------------------------------- attention

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS), ts(export))]
#[serde(rename_all = "snake_case")]
pub enum BlockedReason {
    /// Tool permission prompt.
    Approval,
    /// Structured question with options.
    Question,
    /// Plan waiting for validation.
    Plan,
    /// Turn ended on a plain-text question.
    ExplicitQuestion,
    /// Blocked on a dialog that is not tied to a tool call (trust prompt,
    /// login…), or an agent without a transcript.
    Prompt,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS), ts(export))]
#[serde(tag = "status", content = "reason", rename_all = "snake_case")]
pub enum Attention {
    Blocked(BlockedReason),
    Working,
    Done,
    Idle,
    Unknown,
}

impl Attention {
    /// Sort key for the Inbox: lower comes first.
    pub fn priority(self) -> u8 {
        match self {
            Attention::Blocked(_) => 0,
            Attention::Working => 2,
            Attention::Done => 3,
            Attention::Idle => 4,
            Attention::Unknown => 5,
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Attention::Blocked(BlockedReason::Approval) => "blocked:approval",
            Attention::Blocked(BlockedReason::Question) => "blocked:question",
            Attention::Blocked(BlockedReason::Plan) => "blocked:plan",
            Attention::Blocked(BlockedReason::ExplicitQuestion) => "blocked:explicit_question",
            Attention::Blocked(BlockedReason::Prompt) => "blocked:prompt",
            Attention::Working => "working",
            Attention::Done => "done",
            Attention::Idle => "idle",
            Attention::Unknown => "unknown",
        }
    }

    pub fn is_blocked(self) -> bool {
        matches!(self, Attention::Blocked(_))
    }
}

/// A menu choice visible on screen.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS), ts(export))]
pub struct ScreenOption {
    /// 1-based position in the menu.
    pub number: u32,
    /// First line of the option.
    pub label: String,
    /// Wrapped continuation or description lines, joined.
    pub detail: Option<String>,
    /// Option under the selection cursor.
    pub selected: bool,
    /// True for `1. Yes` style menus (answered by typing the digit);
    /// false for cursor-only menus (answered with arrows + Enter).
    pub numbered: bool,
}

// --------------------------------------------------------------------- agents

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS), ts(export))]
pub struct PendingToolView {
    pub tool_use_id: String,
    pub name: String,
    pub summary: String,
    pub input: Value,
}

/// What the agent is waiting for, shown as an approval/question card.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS), ts(export))]
pub struct Interaction {
    /// Identifies this prompt: answers carrying another id are refused.
    #[serde(default)]
    pub id: String,
    pub reason: BlockedReason,
    pub tool: Option<PendingToolView>,
    /// Structured questions from the transcript (AskUserQuestion).
    pub questions: Vec<Question>,
    /// Menu read from the screen; answer with `choice`.
    pub options: Vec<ScreenOption>,
}

/// One window of a plan rate limit (Codex `rate_limits`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS), ts(export))]
pub struct RateWindow {
    pub used_percent: f64,
    pub window_minutes: Option<u64>,
    /// Seconds since the epoch.
    pub resets_at: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS), ts(export))]
pub struct RateLimits {
    /// Short window (5 h for Codex).
    pub primary: Option<RateWindow>,
    /// Long window (one week for Codex).
    pub secondary: Option<RateWindow>,
    pub plan_type: Option<String>,
}

/// Token usage of one conversation, read from its transcript.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS), ts(export))]
pub struct Usage {
    pub model: Option<String>,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_write_tokens: u64,
    /// Tokens in the context window at the last model call.
    pub context_tokens: u64,
    pub context_window: Option<u64>,
    /// Estimate at API prices; subscriptions are billed differently.
    pub cost_usd: Option<f64>,
    pub rate_limits: Option<RateLimits>,
}

impl Usage {
    pub fn total_tokens(&self) -> u64 {
        self.input_tokens + self.output_tokens + self.cache_read_tokens + self.cache_write_tokens
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS), ts(export))]
pub struct AgentView {
    /// `<session>:<pane id>`, unique on this machine.
    pub id: String,
    /// Changes when another agent takes over the same pane.
    pub instance_id: String,
    pub session: String,
    pub pane_id: String,
    pub workspace_id: String,
    pub workspace_label: Option<String>,
    /// Herdr tab label (the number shown in Herdr unless renamed).
    pub tab_label: Option<String>,
    /// Last component of the working directory.
    pub project: String,
    #[serde(default)]
    pub cwd: Option<String>,
    pub kind: String,
    pub name: Option<String>,
    pub herdr_status: String,
    pub attention: Attention,
    pub summary: String,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub started_at: Option<String>,
    pub last_activity_at: Option<String>,
    pub interaction: Option<Interaction>,
    pub has_transcript: bool,
    pub item_count: u64,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub usage: Option<Usage>,
    /// Native session id (Claude session, Codex rollout), when known.
    #[serde(default)]
    pub native_session: Option<String>,
    pub warnings: Vec<String>,
    /// Agent that started this one (same machine), when known.
    #[serde(default)]
    pub parent_id: Option<String>,
    /// Live agents this one started.
    #[serde(default)]
    pub children: Vec<String>,
    /// Messages sent from Huntaway that the transcript does not show yet
    /// (the agent was busy, or has not written them yet), oldest first.
    #[serde(default)]
    pub queued: Vec<QueuedMessage>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS), ts(export))]
pub struct QueuedMessage {
    #[serde(default)]
    pub id: String,
    pub text: String,
    /// Seconds since the epoch.
    pub at: u64,
    /// `waiting`: held by the daemon until the agent is free (can be removed
    /// or sent now). `sent`: typed into the agent, not in its transcript yet.
    #[serde(default = "sent")]
    pub state: String,
}

fn sent() -> String {
    "sent".into()
}

// ------------------------------------------------------------------- machine

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS), ts(export))]
pub struct SessionView {
    pub name: String,
    pub herdr_version: String,
    pub protocol: u32,
    /// e.g. `herdr_protocol_untested` when the protocol differs from the tested one.
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS), ts(export))]
pub struct WorkspaceView {
    pub session: String,
    pub workspace_id: String,
    pub label: Option<String>,
    /// Working directory, when one of its agents reports it.
    #[serde(default)]
    pub cwd: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS), ts(export))]
pub struct MachineInfo {
    pub machine_id: String,
    pub machine_name: String,
    pub bridge_version: String,
    pub epoch: String,
    #[serde(default)]
    pub os: Option<String>,
    #[serde(default)]
    pub hostname: Option<String>,
    #[serde(default)]
    pub started_at: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS), ts(export))]
pub struct DeviceInfo {
    pub id: String,
    pub name: String,
    pub permissions: Vec<String>,
}

/// `GET /v1/machine`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS), ts(export))]
pub struct MachineResponse {
    pub machine: MachineInfo,
    pub seq: u64,
    pub device: DeviceInfo,
    #[serde(default)]
    pub uptime_secs: Option<u64>,
    #[serde(default)]
    pub sessions: Vec<SessionView>,
    /// Addresses the daemon listens on right now (`ip:port`).
    #[serde(default)]
    pub addresses: Vec<String>,
}

/// `GET /v1/state`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS), ts(export))]
pub struct StateSnapshot {
    pub machine: MachineInfo,
    pub seq: u64,
    pub sessions: Vec<SessionView>,
    #[serde(default)]
    pub workspaces: Vec<WorkspaceView>,
    pub agents: Vec<AgentView>,
}

// -------------------------------------------------------------------- events

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS), ts(export))]
pub struct Notification {
    pub id: String,
    pub agent_id: String,
    /// `blocked`, `done` or `error`.
    pub kind: String,
    pub title: String,
    pub body: String,
    /// Prompt a `blocked` notification is about, to answer it from the notification.
    #[serde(default)]
    pub interaction_id: Option<String>,
}

/// Event of the `/v1/stream` WebSocket.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS), ts(export))]
pub struct Envelope {
    pub seq: u64,
    pub at: u64,
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub agent_id: Option<String>,
    pub data: Value,
}

/// First message of the stream, and resync requests.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS), ts(export))]
pub struct Hello {
    pub epoch: String,
    pub seq: u64,
    pub resync_required: bool,
}

/// Any message of the stream: `hello` or an [`Envelope`].
#[derive(Debug, Clone)]
pub enum StreamMessage {
    Hello(Hello),
    Event(Envelope),
}

impl StreamMessage {
    pub fn parse(text: &str) -> Option<Self> {
        let value: Value = serde_json::from_str(text).ok()?;
        if value["type"] == "hello" {
            serde_json::from_value(value).ok().map(StreamMessage::Hello)
        } else {
            serde_json::from_value(value).ok().map(StreamMessage::Event)
        }
    }
}

// ------------------------------------------------------------------- history

/// A past conversation found on disk (`GET /v1/history`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS), ts(export))]
pub struct HistoryEntry {
    /// `claude:<session id>` or `codex:<session id>`.
    pub id: String,
    pub kind: String,
    pub session_id: String,
    pub cwd: Option<String>,
    pub project: String,
    pub title: String,
    pub started_at: Option<String>,
    pub last_activity_at: Option<String>,
    pub model: Option<String>,
    pub size_bytes: u64,
    /// File modification date (seconds since the epoch): `before` cursor of the next page.
    #[serde(default)]
    pub modified_at: u64,
    /// Agent currently running this conversation, if any.
    pub live_agent_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS), ts(export))]
pub struct HistoryPage {
    pub entries: Vec<HistoryEntry>,
    pub has_more: bool,
}

// -------------------------------------------------------------------- files

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS), ts(export))]
pub struct FileMatch {
    /// Relative to the project directory.
    pub path: String,
    pub is_dir: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS), ts(export))]
pub struct GitFileStatus {
    pub path: String,
    /// Two-letter porcelain status (`M `, `??`…).
    pub status: String,
    pub additions: Option<u64>,
    pub deletions: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS), ts(export))]
pub struct GitStatus {
    pub branch: Option<String>,
    pub files: Vec<GitFileStatus>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS), ts(export))]
pub struct UploadResponse {
    /// Absolute path on the machine, to put in a message.
    pub path: String,
}

// ------------------------------------------------------------------- skills

/// One file of a skill folder; `content` is base64.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS), ts(export))]
pub struct SkillFile {
    /// Relative path inside the skill folder, `/`-separated (`SKILL.md`, `scripts/run.sh`).
    pub path: String,
    pub content: String,
}

/// `PUT /v1/skills/{name}`: the whole folder, replacing the previous one.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS), ts(export))]
pub struct SkillPut {
    pub files: Vec<SkillFile>,
}

/// Where a skill is linked for one agent.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS), ts(export))]
pub struct SkillLink {
    /// `claude`, `codex`…
    pub agent: String,
    pub path: String,
    /// `linked`, or `conflict` when a skill of the same name not installed
    /// by Huntaway is already there (left untouched).
    pub state: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS), ts(export))]
pub struct SkillView {
    pub name: String,
    /// `description` of the `SKILL.md` front matter.
    pub description: Option<String>,
    /// [`skill_hash`] of the files: equal hashes, same skill.
    pub hash: String,
    pub files: u32,
    pub links: Vec<SkillLink>,
    /// Seconds since the epoch.
    pub updated_at: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS), ts(export))]
pub struct SkillsResponse {
    pub skills: Vec<SkillView>,
}

/// Content hash of a skill folder, independent of file order:
/// sha256 of `path\n<sha256 of content>\n` for each file sorted by path.
pub fn skill_hash<'a>(files: impl IntoIterator<Item = (&'a str, &'a [u8])>) -> String {
    use sha2::{Digest, Sha256};
    let mut files: Vec<(&str, &[u8])> = files.into_iter().collect();
    files.sort_by(|a, b| a.0.cmp(b.0));
    let mut outer = Sha256::new();
    for (path, content) in files {
        outer.update(path.as_bytes());
        outer.update(b"\n");
        outer.update(format!("{:x}", Sha256::digest(content)).as_bytes());
        outer.update(b"\n");
    }
    format!("{:x}", outer.finalize())
}

/// `description:` of a `SKILL.md` front matter.
pub fn skill_description(skill_md: &str) -> Option<String> {
    let body = skill_md.strip_prefix("---")?;
    let end = body.find("\n---")?;
    body[..end].lines().find_map(|l| {
        let v = l.strip_prefix("description:")?.trim().trim_matches('"').trim_matches('\'');
        (!v.is_empty()).then(|| v.to_string())
    })
}

/// Valid skill folder name: `[a-z0-9][a-z0-9._-]{0,63}`.
pub fn valid_skill_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name.starts_with(|c: char| c.is_ascii_lowercase() || c.is_ascii_digit())
        && name.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '.' | '_' | '-'))
}

/// `GET /v1/daemon/update`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS), ts(export))]
pub struct DaemonUpdateCheck {
    pub current: String,
    pub latest: String,
    pub available: bool,
}

// ------------------------------------------------------------------ scripts

/// A project script (`GET /v1/scripts`): defined in the project's
/// `.huntaway.toml` or added from the app, run in its own Herdr tab.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS), ts(export))]
pub struct ScriptView {
    pub name: String,
    pub cmd: String,
    /// Directory relative to the project (or absolute); `None` = the project root.
    pub cwd: Option<String>,
    /// `file` (`.huntaway.toml`, wins on name conflicts), `app` (stored by
    /// the daemon) or `removed` (no longer defined but still has its tab:
    /// listed so it can be stopped).
    pub source: String,
    /// `running`, `exited` (its tab is still open, the command ended) or `stopped` (no tab).
    pub status: String,
    /// `<session>:<pane id>` of its tab while it has one: target of
    /// `/v1/panes/{pane}/terminal`.
    pub pane: Option<String>,
}

/// A script found in the project files that can be added in one click.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS), ts(export))]
pub struct ScriptSuggestion {
    pub name: String,
    pub cmd: String,
    pub cwd: Option<String>,
    /// Where it was found: `package.json`, `Makefile`, `docker-compose`, `Cargo.toml`.
    pub origin: String,
}

/// `GET /v1/scripts?path=` and the `scripts.updated` event.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS), ts(export))]
pub struct ProjectScripts {
    /// Canonical project directory: compare event paths with this one.
    pub path: String,
    pub scripts: Vec<ScriptView>,
    /// Only in `GET` answers (empty in events).
    #[serde(default)]
    pub suggestions: Vec<ScriptSuggestion>,
    /// `.huntaway.toml` exists but could not be read.
    #[serde(default)]
    pub file_error: Option<String>,
}

/// A shell opened in a project from the app (`/v1/shells`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS), ts(export))]
pub struct ShellView {
    /// `<session>:<pane id>`: target of `/v1/panes/{pane}/terminal`.
    pub pane: String,
    pub path: String,
    /// Seconds since the epoch.
    pub opened_at: u64,
    /// A command runs in it (else the shell waits at its prompt).
    pub busy: bool,
}

/// `GET /v1/shells?path=` and the `shells.updated` event.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS), ts(export))]
pub struct ProjectShells {
    pub path: String,
    pub shells: Vec<ShellView>,
}

// ------------------------------------------------------------------- pairing

/// Contents of the pairing QR code and of `huntaway://pair/<base64url>` links.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS), ts(export))]
pub struct PairingPayload {
    pub v: u32,
    pub machine_id: String,
    pub machine_name: String,
    pub addresses: Vec<String>,
    pub pairing_code: String,
    pub fingerprint: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PairRequest {
    pub code: String,
    pub device_name: String,
    pub nonce: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PairResponse {
    pub device_id: String,
    pub token: String,
    pub permissions: Vec<String>,
    pub machine_id: String,
    pub machine_name: String,
    pub public_key: String,
    pub signature: String,
}

/// Prefix of pairing links.
pub const PAIR_LINK_PREFIX: &str = "huntaway://pair/";

/// Message signed by the bridge at pairing.
pub fn pair_signed_message(nonce: &str, machine_id: &str, device_id: &str) -> String {
    format!("huntaway-pair-v1|{nonce}|{machine_id}|{device_id}")
}

// -------------------------------------------------------------------- errors

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ErrorDetail {
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ErrorBody {
    pub error: ErrorDetail,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn attention_round_trips() {
        let a = Attention::Blocked(BlockedReason::Approval);
        let json = serde_json::to_value(a).unwrap();
        assert_eq!(json, serde_json::json!({"status": "blocked", "reason": "approval"}));
        assert_eq!(serde_json::from_value::<Attention>(json).unwrap(), a);
        let w: Attention = serde_json::from_value(serde_json::json!({"status": "working"})).unwrap();
        assert_eq!(w, Attention::Working);
    }

    #[test]
    fn stored_item_is_flat() {
        let item = StoredItem { n: 3, item: TimelineItem::Notice { timestamp: "t".into(), text: "x".into() } };
        let json = serde_json::to_value(&item).unwrap();
        assert_eq!(json["n"], 3);
        assert_eq!(json["type"], "notice");
        assert_eq!(serde_json::from_value::<StoredItem>(json).unwrap(), item);
    }

    #[test]
    fn old_agent_payloads_still_parse() {
        let json = serde_json::json!({
            "id": "default:w1:p2", "instance_id": "x", "session": "default", "pane_id": "w1:p2",
            "workspace_id": "w1", "workspace_label": null, "tab_label": null, "project": "api",
            "kind": "claude", "name": null, "herdr_status": "idle", "attention": {"status": "idle"},
            "summary": "", "last_activity_at": null, "interaction": null, "has_transcript": false,
            "item_count": 0, "warnings": []
        });
        let agent: AgentView = serde_json::from_value(json).unwrap();
        assert!(agent.usage.is_none());
    }

    #[test]
    fn stream_messages() {
        assert!(matches!(
            StreamMessage::parse(r#"{"type":"hello","epoch":"e1","seq":4,"resync_required":true}"#),
            Some(StreamMessage::Hello(Hello { seq: 4, resync_required: true, .. }))
        ));
        assert!(matches!(
            StreamMessage::parse(r#"{"seq":5,"at":1,"type":"agent.removed","agent_id":"a","data":{}}"#),
            Some(StreamMessage::Event(Envelope { seq: 5, .. }))
        ));
    }
}
