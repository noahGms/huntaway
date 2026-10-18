//! Phase 0 spike CLI (PRD §20): watch and drive Herdr agents from outside.
//!
//! Targets are `[session/]<agent name | pane id>`, e.g. `reviewer`,
//! `w3:p1` or `work/w1:p2`. Without a session prefix every live session is searched.

use std::collections::{HashMap, VecDeque};
use std::io::Write as _;
use std::path::PathBuf;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{anyhow, bail, Context, Result};
use clap::{Parser, Subcommand};
use herdr_client::{AgentInfo, Client, ReadSource, Session};
use huntaway_core::attention::{classify, Attention};
use huntaway_core::claude::{self, TranscriptTail};
use huntaway_core::screen::{keys_for_choice, numbered_options, ScreenOption};
use huntaway_core::{TimelineItem, ToolKind};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, BufReader};

#[derive(Parser)]
#[command(name = "huntaway-demo", about = "Huntaway phase 0 spike: watch and drive Herdr agents")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// List live Herdr sessions on this machine.
    Sessions,
    /// List agents across all sessions, sorted by priority.
    Agents,
    /// Follow an agent's conversation live; type to send messages.
    Watch {
        target: String,
        /// Number of past timeline items to show first.
        #[arg(long, default_value_t = 15)]
        history: usize,
    },
    /// Send a message (text + Enter) to an agent.
    Send { target: String, text: String },
    /// Interrupt an agent (Esc).
    Interrupt { target: String },
    /// Pick option N of the menu on screen (approval, question, dialog).
    Choice { target: String, number: u32 },
    /// Send raw keys, e.g. `keys w1:p2 1` or `keys w1:p2 esc`.
    Keys { target: String, keys: Vec<String> },
    /// Print the agent's screen and any numbered options detected on it.
    Screen {
        target: String,
        #[arg(long, default_value = "visible")]
        source: String,
    },
    /// Record every state transition of every agent to a JSONL file (Done vs Blocked study).
    Statelog {
        #[arg(long, default_value = "statelog.jsonl")]
        out: PathBuf,
    },
}

#[tokio::main]
async fn main() -> Result<()> {
    match Cli::parse().command {
        Command::Sessions => cmd_sessions().await,
        Command::Agents => cmd_agents().await,
        Command::Watch { target, history } => cmd_watch(&target, history).await,
        Command::Send { target, text } => {
            let agent = resolve(&target).await?;
            send_message(&agent, &text).await
        }
        Command::Interrupt { target } => {
            let agent = resolve(&target).await?;
            agent.client.agent_send_keys(&agent.info.pane_id, &["esc"]).await?;
            println!("✓ Esc sent");
            Ok(())
        }
        Command::Choice { target, number } => {
            let agent = resolve(&target).await?;
            choose(&agent, number).await
        }
        Command::Keys { target, keys } => {
            let agent = resolve(&target).await?;
            let keys: Vec<&str> = keys.iter().map(String::as_str).collect();
            agent.client.agent_send_keys(&agent.info.pane_id, &keys).await?;
            println!("✓ keys sent");
            Ok(())
        }
        Command::Screen { target, source } => cmd_screen(&target, &source).await,
        Command::Statelog { out } => cmd_statelog(out).await,
    }
}

// ---------------------------------------------------------------- resolution

struct Agent {
    session: Session,
    client: Client,
    info: AgentInfo,
}

impl Agent {
    fn id(&self) -> String {
        format!("{}/{}", self.session.name, self.info.pane_id)
    }

    fn kind(&self) -> &str {
        self.info.agent.as_deref().unwrap_or("?")
    }

    fn transcript(&self) -> Option<PathBuf> {
        if self.info.agent.as_deref() != Some("claude") {
            return None;
        }
        let session = self.info.agent_session.as_ref()?;
        claude::transcript_path(self.info.cwd.as_deref(), &session.value)
    }

    fn project(&self) -> String {
        let cwd = self.info.cwd.as_deref().unwrap_or("?");
        cwd.rsplit('/').next().unwrap_or(cwd).to_string()
    }
}

async fn all_agents() -> Result<Vec<Agent>> {
    let live = herdr_client::discover_live_sessions().await;
    if live.is_empty() {
        bail!("no running Herdr session found in {}", herdr_client::config_dir().display());
    }
    let mut agents = Vec::new();
    for (session, _) in live {
        let client = Client::new(&session.socket);
        for info in client.agent_list().await? {
            agents.push(Agent { session: session.clone(), client: client.clone(), info });
        }
    }
    Ok(agents)
}

async fn resolve(target: &str) -> Result<Agent> {
    let (session, name) = match target.split_once('/') {
        Some((s, n)) => (Some(s), n),
        None => (None, target),
    };
    let mut matches: Vec<Agent> = Vec::new();
    for agent in all_agents().await? {
        if session.is_some_and(|s| s != agent.session.name) {
            continue;
        }
        if agent.info.pane_id == name {
            matches.push(agent);
            continue;
        }
        // Named agents are addressed through agent.get on their session.
        if let Ok(info) = agent.client.agent_get(name).await {
            if info.pane_id == agent.info.pane_id {
                matches.push(agent);
            }
        }
    }
    match matches.len() {
        0 => bail!("agent not found: {target} (see `huntaway-demo agents`)"),
        1 => Ok(matches.remove(0)),
        _ => bail!("ambiguous target: {target}, prefix it with the session (e.g. default/{name})"),
    }
}

// ------------------------------------------------------------------ commands

async fn cmd_sessions() -> Result<()> {
    let live = herdr_client::discover_live_sessions().await;
    for session in herdr_client::discover_sessions() {
        match live.iter().find(|(s, _)| s.socket == session.socket) {
            Some((_, pong)) => println!(
                "● {:<16} herdr {} (protocole {})  {}",
                session.name,
                pong.version,
                pong.protocol,
                session.socket.display()
            ),
            None => println!("○ {:<16} offline  {}", session.name, session.socket.display()),
        }
    }
    Ok(())
}

async fn cmd_agents() -> Result<()> {
    let mut rows = Vec::new();
    for agent in all_agents().await? {
        let (attention, summary) = match agent.transcript() {
            Some(path) => {
                let mut tail = TranscriptTail::new(&path);
                let items = tail.poll().unwrap_or_default();
                let pending = tail.pending_tool_calls().last().map(|p| p.kind);
                let attention = classify(agent.info.agent_status.as_str(), pending, recent(&items, 40));
                (attention, summary_of(&tail, &items))
            }
            None => (
                classify(agent.info.agent_status.as_str(), None, &[]),
                agent.info.terminal_title.clone().unwrap_or_default(),
            ),
        };
        rows.push((attention, agent, summary));
    }
    rows.sort_by_key(|(a, _, _)| a.priority());
    for (attention, agent, summary) in rows {
        println!(
            "{} {:<22} {:<8} {:<26} {:<18} {}",
            badge(attention),
            agent.id(),
            agent.kind(),
            attention.label(),
            truncate(&agent.project(), 18),
            truncate(&summary, 70)
        );
    }
    Ok(())
}

async fn cmd_screen(target: &str, source: &str) -> Result<()> {
    let agent = resolve(target).await?;
    let source = parse_source(source)?;
    let text = agent.client.agent_read(&agent.info.pane_id, source, None).await?;
    println!("{text}");
    let options = numbered_options(&text);
    if !options.is_empty() {
        println!("\n— detected options —");
        print_options(&options, "");
    }
    Ok(())
}

fn print_options(options: &[ScreenOption], prefix: &str) {
    for o in options {
        let cursor = if o.selected { "❯" } else { " " };
        let kind = if o.numbered { "" } else { " (cursor)" };
        println!("{prefix}{cursor} {}. {}{kind}", o.number, o.label);
        if let Some(detail) = &o.detail {
            println!("{prefix}     {}", dim(&truncate(detail, 100)));
        }
    }
}

/// Picks option `number` of the menu currently on screen.
async fn choose(agent: &Agent, number: u32) -> Result<()> {
    // The prompt may have been answered at the desk meanwhile: never send
    // digits into a normal input box (PRD §14, `already_resolved`).
    let current = agent.client.agent_get(&agent.info.pane_id).await?;
    if current.agent_status.as_str() != "blocked" {
        bail!("already_resolved: the agent is no longer waiting for an answer (status {})", current.agent_status.as_str());
    }
    let screen = agent.client.agent_read(&agent.info.pane_id, ReadSource::Visible, None).await?;
    let options = numbered_options(&screen);
    let keys = keys_for_choice(&options, number).ok_or_else(|| anyhow!("option {number} is not on screen"))?;
    let keys: Vec<&str> = keys.iter().map(String::as_str).collect();
    agent.client.agent_send_keys(&agent.info.pane_id, &keys).await?;
    println!("{}", dim(&format!("✓ option {number} choisie ({})", keys.join(" "))));
    Ok(())
}

/// Sends a message. If the agent is blocked on a prompt, Herdr refuses
/// `agent.prompt`; we surface that instead of typing into the prompt.
async fn send_message(agent: &Agent, text: &str) -> Result<()> {
    // Fresh status: never type into a pending prompt.
    let current = agent.client.agent_get(&agent.info.pane_id).await?;
    if current.agent_status.as_str() == "blocked" {
        println!("{}", yellow("⚠ the agent is waiting for an answer: use /choice N, /deny <text> or /screen"));
        return Ok(());
    }
    if current.agent.as_deref() == Some("claude") {
        agent.client.agent_send_keys(&agent.info.pane_id, claude::CLEAR_INPUT_KEYS).await?;
    }
    match agent.client.agent_prompt(&agent.info.pane_id, text).await {
        Ok(_) => {
            println!("{}", dim("✓ message sent"));
            Ok(())
        }
        Err(e) if e.code() == Some("agent_blocked") => {
            println!("{}", yellow("⚠ the agent is waiting for an answer: use /choice N, /deny <text> or /screen"));
            Ok(())
        }
        Err(e) => Err(e.into()),
    }
}

// --------------------------------------------------------------------- watch

async fn cmd_watch(target: &str, history: usize) -> Result<()> {
    let agent = resolve(target).await?;
    let pane = agent.info.pane_id.clone();
    let mut status = agent.info.agent_status.as_str().to_string();

    println!(
        "{} — {} · {} · {}",
        bold(&format!("{} ({})", agent.kind(), agent.id())),
        agent.project(),
        status,
        agent.session.socket.display()
    );

    let mut tail = agent.transcript().map(TranscriptTail::new);
    let mut recent_items: VecDeque<TimelineItem> = VecDeque::new();
    match &mut tail {
        Some(t) => {
            println!("{}", dim(&format!("transcript : {}", t.path().display())));
            let items = t.poll()?;
            let skip = items.len().saturating_sub(history);
            for item in &items[skip..] {
                render(item);
            }
            remember(&mut recent_items, items);
        }
        None => println!("{}", dim("no native transcript: screen mode (status + /screen)")),
    }
    println!(
        "{}",
        dim("— live. Type a message + Enter. Commands: /stop /screen /choice N /deny <text> /keys <keys…> /quit —")
    );
    show_attention(&agent, &status, tail.as_ref(), &recent_items).await;

    let mut subscription = agent
        .client
        .subscribe(watch_subscriptions(&pane))
        .await
        .context("subscribing to Herdr events")?;
    let mut stdin = BufReader::new(tokio::io::stdin()).lines();
    let mut ticker = tokio::time::interval(Duration::from_millis(250));

    loop {
        tokio::select! {
            event = subscription.next() => {
                let event = match event {
                    Ok(event) => event,
                    Err(e) if e.code() == Some("events_lost") => {
                        println!("{}", yellow("⚠ events lost, resyncing"));
                        let (sub, snapshot) = agent.client.resync(watch_subscriptions(&pane)).await?;
                        subscription = sub;
                        let Some(new) = snapshot.pane_status(&pane) else {
                            println!("{}", red("■ the pane no longer exists"));
                            return Ok(());
                        };
                        if new.as_str() != status {
                            println!("{}", dim(&format!("[{} → {}] (resynced)", status, new.as_str())));
                            status = new.as_str().to_string();
                            show_attention(&agent, &status, tail.as_ref(), &recent_items).await;
                        }
                        continue;
                    }
                    Err(e) => bail!("Herdr stream interrupted: {e}"),
                };
                if event.pane_id() != Some(pane.as_str()) {
                    continue;
                }
                match event.kind.as_str() {
                    "pane.agent_status_changed" => {
                        // Flush the transcript first so the state is shown after the messages that caused it.
                        if let Some(t) = &mut tail {
                            let items = t.poll()?;
                            items.iter().for_each(render);
                            remember(&mut recent_items, items);
                        }
                        let new = event.data["agent_status"].as_str().unwrap_or("unknown").to_string();
                        println!("{}", dim(&format!("[{} → {}]", status, new)));
                        status = new;
                        show_attention(&agent, &status, tail.as_ref(), &recent_items).await;
                    }
                    "pane.exited" | "pane.closed" => {
                        println!("{}", red("■ the pane exited"));
                        return Ok(());
                    }
                    _ => {}
                }
            }
            _ = ticker.tick() => {
                if let Some(t) = &mut tail {
                    let items = t.poll()?;
                    items.iter().for_each(render);
                    remember(&mut recent_items, items);
                }
            }
            line = stdin.next_line() => {
                let Some(line) = line? else { return Ok(()) };
                if !handle_input(&agent, line.trim()).await? {
                    return Ok(());
                }
            }
        }
    }
}

fn watch_subscriptions(pane: &str) -> Vec<Value> {
    vec![
        json!({ "type": "pane.agent_status_changed", "pane_id": pane }),
        json!({ "type": "pane.exited" }),
        json!({ "type": "pane.closed" }),
    ]
}

/// Returns false to quit.
async fn handle_input(agent: &Agent, line: &str) -> Result<bool> {
    let pane = agent.info.pane_id.as_str();
    let client = &agent.client;
    let (cmd, arg) = line.split_once(' ').map_or((line, ""), |(c, a)| (c, a.trim()));
    match cmd {
        "" => {}
        "/quit" | "/q" => return Ok(false),
        "/stop" => {
            client.agent_send_keys(pane, &["esc"]).await?;
            println!("{}", dim("✓ Esc sent"));
        }
        "/screen" => {
            let text = client.agent_read(pane, ReadSource::Visible, None).await?;
            println!("{}", dim(&text));
        }
        "/choice" => {
            let n: u32 = arg.parse().map_err(|_| anyhow!("usage : /choice N"))?;
            if let Err(e) = choose(agent, n).await {
                println!("{}", red(&format!("✗ {e}")));
            }
        }
        "/deny" => {
            // Claude Code: Esc rejects the permission prompt, then the text
            // goes in as a normal message.
            client.agent_send_keys(pane, &["esc"]).await?;
            if !arg.is_empty() {
                tokio::time::sleep(Duration::from_millis(400)).await;
                send_message(agent, arg).await?;
            }
            println!("{}", dim("✓ denied"));
        }
        "/keys" => {
            let keys: Vec<&str> = arg.split_whitespace().collect();
            client.agent_send_keys(pane, &keys).await?;
            println!("{}", dim("✓ keys sent"));
        }
        // Anything else, including unknown `/commands`, goes to the agent as-is.
        _ => send_message(agent, line).await?,
    }
    Ok(true)
}

async fn show_attention(agent: &Agent, status: &str, tail: Option<&TranscriptTail>, recent_items: &VecDeque<TimelineItem>) {
    let pending = tail.and_then(|t| t.pending_tool_calls().last().cloned().cloned());
    let items: Vec<TimelineItem> = recent_items.iter().cloned().collect();
    let attention = classify(status, pending.as_ref().map(|p| p.kind), &items);
    let Attention::Blocked(reason) = attention else {
        if attention == Attention::Done {
            println!("{}", green("✓ done"));
        }
        return;
    };
    println!("{}", yellow(&format!("● BLOCKED ({})", attention.label().trim_start_matches("blocked:"))));
    if let Some(p) = &pending {
        println!("{}", yellow(&format!("  en attente : {} {}", p.name, p.summary)));
    }
    if status == "blocked" {
        if let Ok(screen) = agent.client.agent_read(&agent.info.pane_id, ReadSource::Visible, None).await {
            print_options(&numbered_options(&screen), "  ");
        }
        println!("{}", dim(&format!("  → /choice N to answer ({reason:?})")));
    }
}

// ------------------------------------------------------------------ statelog

/// Subscribes to every agent of every session and appends one JSON line per
/// transition, with the transcript context needed to tune the Done/Blocked rule.
async fn cmd_statelog(out: PathBuf) -> Result<()> {
    let mut file = std::fs::OpenOptions::new().create(true).append(true).open(&out)?;
    println!("logging transitions to {} (Ctrl-C to stop)", out.display());

    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<(Session, herdr_client::Event)>();
    let mut last_status: HashMap<String, String> = HashMap::new();
    let mut tasks = Vec::new();

    // One task per session; each resubscribes whenever panes come and go.
    for (session, _) in herdr_client::discover_live_sessions().await {
        let tx = tx.clone();
        tasks.push(tokio::spawn(async move {
            let client = Client::new(&session.socket);
            loop {
                let panes: Vec<String> = match client.agent_list().await {
                    Ok(list) => list.into_iter().map(|a| a.pane_id).collect(),
                    Err(_) => {
                        tokio::time::sleep(Duration::from_secs(2)).await;
                        continue;
                    }
                };
                let mut subs: Vec<Value> = panes
                    .iter()
                    .map(|p| json!({ "type": "pane.agent_status_changed", "pane_id": p }))
                    .collect();
                for kind in ["pane.agent_detected", "pane.created", "pane.closed", "pane.exited"] {
                    subs.push(json!({ "type": kind }));
                }
                let Ok(mut sub) = client.subscribe(subs).await else {
                    tokio::time::sleep(Duration::from_secs(2)).await;
                    continue;
                };
                while let Ok(event) = sub.next().await {
                    let resubscribe = event.kind != "pane.agent_status_changed";
                    let _ = tx.send((session.clone(), event));
                    if resubscribe {
                        break;
                    }
                }
            }
        }));
    }
    drop(tx);

    for agent in all_agents().await? {
        last_status.insert(agent.id(), agent.info.agent_status.as_str().to_string());
    }

    while let Some((session, event)) = rx.recv().await {
        let Some(pane) = event.pane_id().map(str::to_string) else { continue };
        let id = format!("{}/{}", session.name, pane);
        let client = Client::new(&session.socket);
        let entry = match event.kind.as_str() {
            "pane.agent_status_changed" => {
                let new = event.data["agent_status"].as_str().unwrap_or("unknown").to_string();
                let previous = last_status.insert(id.clone(), new.clone());
                let Ok(info) = client.agent_get(&pane).await else { continue };
                let agent = Agent { session: session.clone(), client: client.clone(), info };
                let mut context = json!({});
                let mut attention = classify(&new, None, &[]);
                if let Some(path) = agent.transcript() {
                    let mut tail = TranscriptTail::new(&path);
                    let items = tail.poll().unwrap_or_default();
                    let pending = tail.pending_tool_calls().last().cloned().cloned();
                    attention = classify(&new, pending.as_ref().map(|p| p.kind), recent(&items, 40));
                    context = json!({
                        "pending_tool": pending.map(|p| json!({ "name": p.name, "summary": p.summary })),
                        "last_items": recent(&items, 6),
                    });
                }
                let screen = if new == "blocked" {
                    client.agent_read(&pane, ReadSource::Visible, None).await.ok()
                } else {
                    None
                };
                println!("{} {:<22} {} → {}  [{}]", now_hms(), id, previous.as_deref().unwrap_or("?"), new, attention.label());
                json!({
                    "at": epoch_ms(),
                    "agent": id,
                    "kind": agent.info.agent,
                    "from": previous,
                    "to": new,
                    "attention": attention.label(),
                    "screen_options": screen.as_deref().map(numbered_options),
                    "screen": screen,
                    "context": context,
                })
            }
            other => {
                println!("{} {:<22} {}", now_hms(), id, other);
                json!({ "at": epoch_ms(), "agent": id, "event": other })
            }
        };
        writeln!(file, "{entry}")?;
    }
    Ok(())
}

// --------------------------------------------------------------- rendering

fn render(item: &TimelineItem) {
    let time = |ts: &str| ts.get(11..16).unwrap_or("").to_string();
    match item {
        TimelineItem::UserMessage { text, timestamp, .. } => {
            println!("\n{} {}", cyan(&bold("YOU")), dim(&time(timestamp)));
            println!("{}", indent(text));
        }
        TimelineItem::AssistantMessage { text, timestamp, sidechain, .. } => {
            let who = if *sidechain { "  sub-agent" } else { "CLAUDE" };
            println!("\n{} {}", magenta(&bold(who)), dim(&time(timestamp)));
            println!("{}", indent(text));
        }
        TimelineItem::ToolCall { kind, summary, name, sidechain, .. } => {
            if *sidechain || *kind == ToolKind::Todo || *kind == ToolKind::Question {
                return;
            }
            let verb = match kind {
                ToolKind::FileRead => "Read",
                ToolKind::Search => "Search",
                ToolKind::FileModified => "Modified",
                ToolKind::Command => "Run",
                ToolKind::Plan => "Plan",
                ToolKind::Subagent => "Agent",
                ToolKind::Web => "Web",
                _ => name.as_str(),
            };
            println!("  {} {}", dim(&format!("· {verb:<8}")), truncate(summary, 100));
        }
        TimelineItem::ToolResult { rejected: true, .. } => println!("  {}", yellow("✗ Denied")),
        TimelineItem::ToolResult { is_error: true, summary, .. } => {
            println!("  {} {}", red("✗"), dim(&truncate(summary, 100)));
        }
        TimelineItem::ToolResult { .. } => {}
        TimelineItem::TodosUpdated { todos, .. } => {
            let done = todos.iter().filter(|t| t.status == "completed").count();
            let current = todos.iter().find(|t| t.status == "in_progress").map(|t| t.content.as_str()).unwrap_or("");
            println!("  {} {}/{} {}", dim("· Todo    "), done, todos.len(), truncate(current, 80));
        }
        TimelineItem::QuestionAsked { questions, .. } => {
            for q in questions {
                println!("\n{} {}", yellow(&bold("QUESTION")), q.question);
                for (i, o) in q.options.iter().enumerate() {
                    println!("  {}. {}", i + 1, o.label);
                }
            }
        }
        TimelineItem::TurnEnded { duration_ms, .. } => {
            let secs = duration_ms.map(|ms| format!(" ({}s)", ms / 1000)).unwrap_or_default();
            println!("{}", dim(&format!("  — turn ended{secs}")));
        }
        TimelineItem::AwaySummary { text, .. } => println!("\n{} {}", dim("summary:"), text),
        TimelineItem::Notice { text, .. } => println!("{}", dim(&format!("  ({text})"))),
    }
}

fn remember(buf: &mut VecDeque<TimelineItem>, items: Vec<TimelineItem>) {
    buf.extend(items);
    while buf.len() > 60 {
        buf.pop_front();
    }
}

fn recent(items: &[TimelineItem], n: usize) -> &[TimelineItem] {
    &items[items.len().saturating_sub(n)..]
}

/// Mobile card summary: current todo, else last user message.
fn summary_of(tail: &TranscriptTail, items: &[TimelineItem]) -> String {
    if let Some(todo) = tail.todos().iter().find(|t| t.status == "in_progress") {
        return todo.content.clone();
    }
    items
        .iter()
        .rev()
        .find_map(|i| match i {
            TimelineItem::UserMessage { text, .. } => Some(text.lines().next().unwrap_or("").to_string()),
            _ => None,
        })
        .unwrap_or_default()
}

fn parse_source(s: &str) -> Result<ReadSource> {
    Ok(match s {
        "visible" => ReadSource::Visible,
        "recent" => ReadSource::Recent,
        "recent_unwrapped" | "recent-unwrapped" => ReadSource::RecentUnwrapped,
        "detection" => ReadSource::Detection,
        _ => bail!("unknown source: {s}"),
    })
}

fn badge(a: Attention) -> String {
    match a {
        Attention::Blocked(_) => yellow("●"),
        Attention::Working => green("●"),
        Attention::Done => green("✓"),
        Attention::Idle => dim("○"),
        Attention::Unknown => dim("?"),
    }
}

fn indent(text: &str) -> String {
    text.lines().map(|l| format!("  {l}")).collect::<Vec<_>>().join("\n")
}

fn truncate(s: &str, max: usize) -> String {
    let s = s.lines().next().unwrap_or("");
    if s.chars().count() > max {
        format!("{}…", s.chars().take(max).collect::<String>())
    } else {
        s.to_string()
    }
}

fn epoch_ms() -> u128 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0)
}

fn now_hms() -> String {
    let secs = (epoch_ms() / 1000) as u64;
    format!("{:02}:{:02}:{:02}Z", (secs / 3600) % 24, (secs / 60) % 60, secs % 60)
}

fn paint(code: &str, s: &str) -> String {
    format!("\x1b[{code}m{s}\x1b[0m")
}
fn bold(s: &str) -> String {
    paint("1", s)
}
fn dim(s: &str) -> String {
    paint("2", s)
}
fn red(s: &str) -> String {
    paint("31", s)
}
fn green(s: &str) -> String {
    paint("32", s)
}
fn yellow(s: &str) -> String {
    paint("33", s)
}
fn magenta(s: &str) -> String {
    paint("35", s)
}
fn cyan(s: &str) -> String {
    paint("36", s)
}
