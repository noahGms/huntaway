//! Plan limits of the agents on this machine (`GET /v1/limits`, pushed as
//! `limits.updated`): Claude from its usage endpoint with the local Claude
//! login, Codex from its latest session file.
//!
//! The Claude token is only sent to api.anthropic.com and never refreshed
//! here (that would rotate it under Claude Code): an expired one keeps the
//! last values, marked with an error, until Claude Code refreshes it.

use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use huntaway_api::{LimitWindow, MachineLimits, ProviderLimits, RateWindow};
use serde_json::Value;
use tracing::debug;

use crate::engine::Engine;

/// Codex session files are checked this often (cheap: mtime first).
const TICK: Duration = Duration::from_secs(15);
/// Claude's usage endpoint at most this often.
const CLAUDE_EVERY: Duration = Duration::from_secs(300);
/// After a refused keychain read: the user said no, don't ask again soon.
const KEYCHAIN_BACKOFF: Duration = Duration::from_secs(6 * 3600);
const USAGE_URL: &str = "https://api.anthropic.com/api/oauth/usage";
/// Tail of a Codex session file read for its latest `rate_limits`.
const CODEX_TAIL: u64 = 1 << 20;

#[derive(Default)]
struct State {
    claude: Option<ProviderLimits>,
    codex: Option<ProviderLimits>,
    /// Newest Codex session file and its mtime at the last read.
    codex_seen: Option<(PathBuf, SystemTime)>,
    /// No Claude fetch before this.
    claude_next: Option<Instant>,
}

pub struct Limits {
    state: Mutex<State>,
    claude_api: bool,
    /// One Claude fetch at a time.
    fetching: tokio::sync::Mutex<()>,
    http: reqwest::Client,
}

impl Limits {
    pub fn new(claude_api: bool) -> Arc<Self> {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(10))
            .user_agent(concat!("huntawayd/", env!("CARGO_PKG_VERSION")))
            .build()
            .unwrap_or_default();
        Arc::new(Self { state: Mutex::new(State::default()), claude_api, fetching: Default::default(), http })
    }

    /// Current values; windows whose reset time passed are back to 0 %.
    pub fn current(&self) -> MachineLimits {
        let state = self.state.lock().unwrap();
        let now = now_secs();
        let providers = [&state.claude, &state.codex]
            .into_iter()
            .flatten()
            .map(|p| {
                let mut p = p.clone();
                for w in &mut p.windows {
                    if w.resets_at.is_some_and(|t| t <= now) {
                        w.used_percent = 0.0;
                        w.resets_at = None;
                    }
                }
                p
            })
            .collect();
        MachineLimits { providers }
    }

    /// Fresh values for a client asking now: Claude is fetched if it never was.
    pub async fn ensure_loaded(&self) {
        let never = self.state.lock().unwrap().claude_next.is_none();
        if never {
            self.refresh_claude().await;
        }
        self.refresh_codex().await;
    }

    pub fn start(self: &Arc<Self>, engine: Arc<Engine>) {
        let limits = self.clone();
        tokio::spawn(async move {
            let mut last = MachineLimits::default();
            loop {
                limits.refresh_codex().await;
                // Claude only while someone looks: no calls for nobody.
                if engine.has_listeners() {
                    limits.refresh_claude().await;
                }
                let now = limits.current();
                if now != last {
                    engine.emit("limits.updated", None, serde_json::to_value(&now).unwrap_or_default());
                    last = now;
                }
                tokio::time::sleep(TICK).await;
            }
        });
    }

    async fn refresh_codex(&self) {
        let root = huntaway_core::codex::home_dir().join("sessions");
        let seen = self.state.lock().unwrap().codex_seen.clone();
        let found = tokio::task::spawn_blocking(move || {
            let files = recent_codex_files(&root);
            let newest = files.first().cloned();
            if newest.is_none() || newest == seen {
                return (newest, None);
            }
            (newest, files.iter().take(5).find_map(|(path, mtime)| codex_limits(path, *mtime)))
        })
        .await;
        let Ok((newest, limits)) = found else { return };
        let mut state = self.state.lock().unwrap();
        if newest.is_some() && newest != state.codex_seen {
            state.codex_seen = newest;
            if limits.is_some() {
                state.codex = limits;
            }
        }
    }

    async fn refresh_claude(&self) {
        if !self.claude_api {
            return;
        }
        let Ok(_guard) = self.fetching.try_lock() else { return };
        if self.state.lock().unwrap().claude_next.is_some_and(|t| Instant::now() < t) {
            return;
        }
        let (result, wait) = match tokio::task::spawn_blocking(claude_credentials).await {
            Ok(Ok(creds)) => (self.fetch_claude(&creds).await, CLAUDE_EVERY),
            Ok(Err(CredsError::Missing)) => {
                // Not logged in to Claude here: nothing to show.
                self.state.lock().unwrap().claude_next = Some(Instant::now() + CLAUDE_EVERY);
                return;
            }
            Ok(Err(CredsError::Refused(e))) => (Err(e), KEYCHAIN_BACKOFF),
            Ok(Err(CredsError::Expired(plan))) => (Err((plan, "Claude login expired: use Claude Code once to refresh it".into())), CLAUDE_EVERY),
            Err(e) => (Err((None, e.to_string())), CLAUDE_EVERY),
        };
        let mut state = self.state.lock().unwrap();
        state.claude_next = Some(Instant::now() + wait);
        match result {
            Ok(limits) => state.claude = Some(limits),
            Err((plan, error)) => {
                debug!(%error, "claude limits not refreshed");
                let previous = state.claude.take();
                state.claude = Some(match previous {
                    Some(p) => ProviderLimits { error: Some(error), ..p },
                    None => ProviderLimits { kind: "claude".into(), plan, windows: Vec::new(), updated_at: None, source: "api".into(), error: Some(error) },
                });
            }
        }
    }

    async fn fetch_claude(&self, creds: &Creds) -> Result<ProviderLimits, (Option<String>, String)> {
        let fail = |e: String| (creds.plan.clone(), e);
        let response = self
            .http
            .get(USAGE_URL)
            .bearer_auth(&creds.token)
            .header("anthropic-beta", "oauth-2025-04-20")
            .send()
            .await
            .map_err(|e| fail(format!("Claude usage unreachable: {e}")))?;
        let status = response.status();
        if status.as_u16() == 401 || status.as_u16() == 403 {
            return Err(fail("Claude login expired: use Claude Code once to refresh it".into()));
        }
        if !status.is_success() {
            return Err(fail(format!("Claude usage: HTTP {}", status.as_u16())));
        }
        let body: Value = response.json().await.map_err(|e| fail(format!("Claude usage: {e}")))?;
        Ok(ProviderLimits {
            kind: "claude".into(),
            plan: creds.plan.clone(),
            windows: claude_windows(&body),
            updated_at: Some(now_secs()),
            source: "api".into(),
            error: None,
        })
    }
}

// ------------------------------------------------------------------ claude

struct Creds {
    token: String,
    plan: Option<String>,
}

enum CredsError {
    /// No Claude login on this machine.
    Missing,
    /// The keychain read was refused.
    Refused((Option<String>, String)),
    /// Expired token (plan kept).
    Expired(Option<String>),
}

fn claude_dir() -> PathBuf {
    match std::env::var("CLAUDE_CONFIG_DIR") {
        Ok(dir) if !dir.is_empty() => PathBuf::from(dir),
        _ => herdr_client::home_dir().join(".claude"),
    }
}

/// The Claude Code login: `.credentials.json`, else the macOS keychain.
fn claude_credentials() -> Result<Creds, CredsError> {
    let text = match std::fs::read_to_string(claude_dir().join(".credentials.json")) {
        Ok(text) => text,
        Err(_) if cfg!(target_os = "macos") => keychain_credentials()?,
        Err(_) => return Err(CredsError::Missing),
    };
    parse_credentials(&text, now_secs() * 1000)
}

fn keychain_credentials() -> Result<String, CredsError> {
    let output = std::process::Command::new("/usr/bin/security")
        .args(["find-generic-password", "-s", "Claude Code-credentials", "-w"])
        .output()
        .map_err(|e| CredsError::Refused((None, format!("keychain: {e}"))))?;
    match output.status.code() {
        Some(0) => Ok(String::from_utf8_lossy(&output.stdout).trim().to_string()),
        // errSecItemNotFound.
        Some(44) => Err(CredsError::Missing),
        _ => Err(CredsError::Refused((None, "Claude login not readable from the keychain".into()))),
    }
}

fn parse_credentials(text: &str, now_ms: u64) -> Result<Creds, CredsError> {
    let v: Value = serde_json::from_str(text).map_err(|_| CredsError::Missing)?;
    let oauth = &v["claudeAiOauth"];
    let token = oauth["accessToken"].as_str().filter(|t| !t.is_empty()).ok_or(CredsError::Missing)?;
    let plan = oauth["subscriptionType"].as_str().map(str::to_string);
    // A minute of margin: the call must not race the expiry.
    if oauth["expiresAt"].as_u64().is_some_and(|t| t <= now_ms + 60_000) {
        return Err(CredsError::Expired(plan));
    }
    Ok(Creds { token: token.to_string(), plan })
}

/// `{ five_hour: { utilization, resets_at }, seven_day: …, seven_day_opus: … }`.
fn claude_windows(body: &Value) -> Vec<LimitWindow> {
    [
        ("five_hour", "five_hour", "5h", 300),
        ("seven_day", "week", "Week", 10_080),
        ("seven_day_opus", "week_opus", "Week (Opus)", 10_080),
        ("seven_day_sonnet", "week_sonnet", "Week (Sonnet)", 10_080),
    ]
    .into_iter()
    .filter_map(|(key, id, label, minutes)| {
        let w = &body[key];
        Some(LimitWindow {
            id: id.into(),
            label: label.into(),
            used_percent: w["utilization"].as_f64()?,
            window_minutes: Some(minutes),
            resets_at: time_value(&w["resets_at"]),
        })
    })
    .collect()
}

// ------------------------------------------------------------------- codex

/// Codex session files of the last days, newest first (a session started
/// yesterday may still be writing).
fn recent_codex_files(root: &Path) -> Vec<(PathBuf, SystemTime)> {
    let dirs_desc = |dir: &Path, n: usize| -> Vec<PathBuf> {
        let mut dirs: Vec<PathBuf> =
            std::fs::read_dir(dir).into_iter().flatten().flatten().map(|e| e.path()).filter(|p| p.is_dir()).collect();
        dirs.sort();
        dirs.into_iter().rev().take(n).collect()
    };
    let mut days = Vec::new();
    for year in dirs_desc(root, 2) {
        for month in dirs_desc(&year, 2) {
            days.extend(dirs_desc(&month, 3));
        }
    }
    days.sort();
    let mut files: Vec<(PathBuf, SystemTime)> = days
        .iter()
        .rev()
        .take(3)
        .flat_map(|day| std::fs::read_dir(day).into_iter().flatten().flatten())
        .filter(|e| e.file_name().to_string_lossy().starts_with("rollout-"))
        .filter_map(|e| Some((e.path(), e.metadata().ok()?.modified().ok()?)))
        .collect();
    files.sort_by_key(|f| std::cmp::Reverse(f.1));
    files
}

/// Latest `rate_limits` of a Codex session file.
fn codex_limits(path: &Path, mtime: SystemTime) -> Option<ProviderLimits> {
    let mut file = std::fs::File::open(path).ok()?;
    let len = file.metadata().ok()?.len();
    file.seek(SeekFrom::Start(len.saturating_sub(CODEX_TAIL))).ok()?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes).ok()?;
    let text = String::from_utf8_lossy(&bytes);
    let fallback = mtime.duration_since(UNIX_EPOCH).ok()?.as_secs();
    text.lines().rev().filter(|l| l.contains("\"rate_limits\":{")).find_map(|line| codex_line_limits(line, fallback))
}

fn codex_line_limits(line: &str, fallback_time: u64) -> Option<ProviderLimits> {
    let entry: Value = serde_json::from_str(line).ok()?;
    let limits = huntaway_core::codex::rate_limits(&entry["payload"])?;
    let windows: Vec<LimitWindow> = [limits.primary, limits.secondary].into_iter().flatten().map(codex_window).collect();
    if windows.is_empty() {
        return None;
    }
    Some(ProviderLimits {
        kind: "codex".into(),
        plan: limits.plan_type,
        windows,
        updated_at: Some(time_value(&entry["timestamp"]).unwrap_or(fallback_time)),
        source: "session".into(),
        error: None,
    })
}

fn codex_window(w: RateWindow) -> LimitWindow {
    let (id, label) = match w.window_minutes {
        Some(300) => ("five_hour".to_string(), "5h".to_string()),
        Some(10_080) => ("week".to_string(), "Week".to_string()),
        Some(m) if m % 1440 == 0 => (format!("{m}m"), format!("{}d", m / 1440)),
        Some(m) if m % 60 == 0 => (format!("{m}m"), format!("{}h", m / 60)),
        Some(m) => (format!("{m}m"), format!("{m}m")),
        None => ("window".to_string(), "Window".to_string()),
    };
    LimitWindow { id, label, used_percent: w.used_percent, window_minutes: w.window_minutes, resets_at: w.resets_at }
}

// -------------------------------------------------------------------- time

fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// Seconds since the epoch, from a number or an RFC 3339 string.
fn time_value(v: &Value) -> Option<u64> {
    v.as_u64().or_else(|| v.as_f64().map(|f| f as u64)).or_else(|| v.as_str().and_then(parse_rfc3339))
}

/// `2026-10-19T14:05:00.123456+00:00` / `…Z` → seconds since the epoch.
fn parse_rfc3339(s: &str) -> Option<u64> {
    let num = |r: std::ops::Range<usize>| s.get(r)?.parse::<i64>().ok();
    let (y, mo, d) = (num(0..4)?, num(5..7)?, num(8..10)?);
    let (h, mi, sec) = (num(11..13)?, num(14..16)?, num(17..19)?);
    if !matches!(s.as_bytes().get(10), Some(b'T' | b't' | b' ')) {
        return None;
    }
    // Offset: after the seconds and their fraction.
    let rest = &s[19..];
    let rest = rest.trim_start_matches(|c: char| c == '.' || c.is_ascii_digit());
    let offset = match rest.as_bytes().first() {
        None | Some(b'Z' | b'z') => 0,
        Some(sign @ (b'+' | b'-')) => {
            let oh = rest.get(1..3)?.parse::<i64>().ok()?;
            let om = rest.get(4..6).and_then(|m| m.parse::<i64>().ok()).unwrap_or(0);
            let o = oh * 3600 + om * 60;
            if *sign == b'+' {
                o
            } else {
                -o
            }
        }
        _ => return None,
    };
    // Days from civil (Howard Hinnant).
    let y = if mo <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (mo + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    u64::try_from(days * 86_400 + h * 3600 + mi * 60 + sec - offset).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rfc3339_times() {
        assert_eq!(parse_rfc3339("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(parse_rfc3339("2026-10-19T14:05:00.123456+00:00"), Some(1_792_418_700));
        assert_eq!(parse_rfc3339("2026-10-19T16:05:00+02:00"), Some(1_792_418_700));
        assert_eq!(parse_rfc3339("2024-02-29T00:00:00Z"), Some(1_709_164_800));
        assert_eq!(parse_rfc3339("nope"), None);
    }

    #[test]
    fn claude_usage_response() {
        let body: Value = serde_json::from_str(
            r#"{"five_hour":{"utilization":62.0,"resets_at":"2026-10-19T16:00:00.000000+00:00"},
                "seven_day":{"utilization":35,"resets_at":"2026-10-26T09:00:00Z"},
                "seven_day_opus":{"utilization":null,"resets_at":null},
                "seven_day_oauth_apps":null}"#,
        )
        .unwrap();
        let w = claude_windows(&body);
        assert_eq!(w.len(), 2);
        assert_eq!((w[0].id.as_str(), w[0].label.as_str(), w[0].used_percent), ("five_hour", "5h", 62.0));
        assert_eq!(w[0].resets_at, parse_rfc3339("2026-10-19T16:00:00Z"));
        assert_eq!((w[1].id.as_str(), w[1].used_percent), ("week", 35.0));
    }

    #[test]
    fn claude_credentials_file() {
        let now = 1_000_000_000;
        let ok = r#"{"claudeAiOauth":{"accessToken":"t","expiresAt":2000000000,"subscriptionType":"max"}}"#;
        let creds = parse_credentials(ok, now).ok().unwrap();
        assert_eq!((creds.token.as_str(), creds.plan.as_deref()), ("t", Some("max")));
        let expired = r#"{"claudeAiOauth":{"accessToken":"t","expiresAt":1000030000,"subscriptionType":"pro"}}"#;
        assert!(matches!(parse_credentials(expired, now), Err(CredsError::Expired(Some(p))) if p == "pro"));
        assert!(matches!(parse_credentials("{}", now), Err(CredsError::Missing)));
    }

    #[test]
    fn codex_session_limits() {
        let dir = std::env::temp_dir().join(format!("hw-limits-{}", std::process::id()));
        let day = dir.join("2026/10/19");
        std::fs::create_dir_all(&day).unwrap();
        let file = day.join("rollout-2026-10-19T10-00-00-abc.jsonl");
        std::fs::write(
            &file,
            [
                r#"{"timestamp":"2026-10-19T10:00:00Z","type":"event_msg","payload":{"type":"token_count","rate_limits":{"primary":{"used_percent":10.0,"window_minutes":300,"resets_at":1792430000},"secondary":{"used_percent":2.0,"window_minutes":10080,"resets_at":1792900000},"plan_type":"plus"}}}"#,
                r#"{"timestamp":"2026-10-19T10:05:00Z","type":"event_msg","payload":{"type":"token_count","rate_limits":{"primary":{"used_percent":12.5,"window_minutes":300,"resets_at":1792430000},"secondary":{"used_percent":3.0,"window_minutes":10080,"resets_at":1792900000},"plan_type":"plus"}}}"#,
                r#"{"timestamp":"2026-10-19T10:06:00Z","type":"event_msg","payload":{"type":"agent_message","message":"hi"}}"#,
            ]
            .join("\n"),
        )
        .unwrap();
        let files = recent_codex_files(&dir);
        assert_eq!(files.len(), 1);
        let limits = codex_limits(&files[0].0, files[0].1).unwrap();
        assert_eq!(limits.plan.as_deref(), Some("plus"));
        assert_eq!(limits.updated_at, parse_rfc3339("2026-10-19T10:05:00Z"));
        let w: Vec<_> = limits.windows.iter().map(|w| (w.id.as_str(), w.label.as_str(), w.used_percent)).collect();
        assert_eq!(w, [("five_hour", "5h", 12.5), ("week", "Week", 3.0)]);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn past_resets_read_as_zero() {
        let limits = Limits::new(false);
        let window = |resets_at| LimitWindow { id: "five_hour".into(), label: "5h".into(), used_percent: 80.0, window_minutes: Some(300), resets_at };
        limits.state.lock().unwrap().codex = Some(ProviderLimits {
            kind: "codex".into(),
            plan: None,
            windows: vec![window(Some(1)), window(Some(now_secs() + 600))],
            updated_at: None,
            source: "session".into(),
            error: None,
        });
        let w = &limits.current().providers[0].windows;
        assert_eq!((w[0].used_percent, w[0].resets_at), (0.0, None));
        assert_eq!(w[1].used_percent, 80.0);
    }
}
