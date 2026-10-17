//! The daemon of this computer: found through its state dir
//! (`~/.config/huntaway/`, or `HUNTAWAY_HOME`), reached on 127.0.0.1 with
//! the token it writes to `local.token`.

use std::path::PathBuf;
use std::process::Command;

use serde::Serialize;

fn home() -> PathBuf {
    PathBuf::from(std::env::var("HOME").unwrap_or_else(|_| ".".into()))
}

/// Same rules as `huntawayd`'s `state_dir()`.
pub fn state_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("HUNTAWAY_HOME") {
        if !dir.is_empty() {
            return PathBuf::from(dir);
        }
    }
    let base = match std::env::var("XDG_CONFIG_HOME") {
        Ok(dir) if !dir.is_empty() => PathBuf::from(dir),
        _ => home().join(".config"),
    };
    base.join("huntaway")
}

#[derive(serde::Deserialize, Default)]
#[serde(default)]
struct DaemonConfig {
    port: Option<u16>,
}

pub struct LocalDaemon {
    pub address: String,
    pub token: String,
}

/// Local token and address, when the daemon has written its token.
pub fn detect() -> Option<LocalDaemon> {
    let dir = state_dir();
    let token = std::fs::read_to_string(dir.join("local.token")).ok()?.trim().to_string();
    if token.is_empty() {
        return None;
    }
    let config: DaemonConfig = std::fs::read_to_string(dir.join("config.toml"))
        .ok()
        .and_then(|t| toml::from_str(&t).ok())
        .unwrap_or_default();
    let port = config.port.unwrap_or(7420);
    Some(LocalDaemon { address: format!("127.0.0.1:{port}"), token })
}

/// `huntawayd` binary, if installed.
pub fn daemon_binary() -> Option<PathBuf> {
    let candidates = [home().join(".local/bin/huntawayd"), PathBuf::from("/opt/homebrew/bin/huntawayd"), PathBuf::from("/usr/local/bin/huntawayd")];
    candidates.into_iter().find(|p| p.exists())
}

#[derive(Debug, Clone, Serialize)]
pub struct LocalStatus {
    /// `huntawayd` is installed on this computer.
    pub installed: bool,
    /// The daemon wrote its local token (version with desktop support).
    pub has_token: bool,
    pub binary: Option<String>,
    pub install_command: String,
}

pub const INSTALL_COMMAND: &str =
    "curl -fsSL https://github.com/noahGms/huntaway/releases/latest/download/install.sh | sh";

pub fn status() -> LocalStatus {
    let binary = daemon_binary();
    LocalStatus {
        installed: binary.is_some(),
        has_token: detect().is_some(),
        binary: binary.map(|b| b.to_string_lossy().to_string()),
        install_command: INSTALL_COMMAND.into(),
    }
}

/// Installs (if needed) and starts the background service.
pub fn start_service() -> Result<(), String> {
    let binary = daemon_binary().ok_or("huntawayd n'est pas installé")?;
    let out = Command::new(&binary).args(["service", "install", "--start"]).output().map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

/// Name shown in the daemon's device list.
pub fn device_name() -> String {
    let host = Command::new("/usr/sbin/scutil")
        .args(["--get", "ComputerName"])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .filter(|s| !s.is_empty())
        .or_else(|| Command::new("hostname").output().ok().map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string()))
        .unwrap_or_else(|| "ordinateur".into());
    format!("Huntaway Desktop ({host})")
}
