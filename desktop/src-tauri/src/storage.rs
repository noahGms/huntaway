//! Paired machines and app settings, in the app config dir. Tokens go to the
//! system keychain; if it is unavailable they fall back to a private file.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

const KEYRING_SERVICE: &str = "app.huntaway.desktop";

/// A machine known to the app (without its token).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MachineRecord {
    pub machine_id: String,
    pub name: String,
    pub addresses: Vec<String>,
    /// Base64 ed25519 key seen at pairing.
    #[serde(default)]
    pub public_key: Option<String>,
    #[serde(default)]
    pub device_id: Option<String>,
    #[serde(default)]
    pub permissions: Vec<String>,
    /// The daemon of this computer, reached with its local token.
    #[serde(default)]
    pub local: bool,
    #[serde(default)]
    pub added_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Settings {
    /// Closing the window keeps the app in the menu bar.
    pub keep_in_tray: bool,
    pub notify_blocked: bool,
    pub notify_done: bool,
    pub notify_error: bool,
    pub notification_sound: bool,
    /// Enter sends, Shift+Enter adds a line (else the reverse).
    pub enter_to_send: bool,
    /// Show the estimated cost in the usage panel.
    pub show_cost: bool,
    /// Grouping of the sidebar: `date` or `project`.
    pub grouping: String,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            keep_in_tray: true,
            notify_blocked: true,
            notify_done: true,
            notify_error: true,
            notification_sound: true,
            enter_to_send: true,
            show_cost: true,
            grouping: "date".into(),
        }
    }
}

pub struct Storage {
    dir: PathBuf,
}

fn write_private(path: &Path, contents: &str) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, contents)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600))?;
    }
    std::fs::rename(&tmp, path)
}

impl Storage {
    pub fn new(dir: PathBuf) -> Self {
        Self { dir }
    }

    fn read<T: for<'de> Deserialize<'de> + Default>(&self, name: &str) -> T {
        std::fs::read_to_string(self.dir.join(name))
            .ok()
            .and_then(|t| serde_json::from_str(&t).ok())
            .unwrap_or_default()
    }

    fn write<T: Serialize>(&self, name: &str, value: &T) -> Result<(), String> {
        let text = serde_json::to_string_pretty(value).map_err(|e| e.to_string())?;
        write_private(&self.dir.join(name), &text).map_err(|e| e.to_string())
    }

    pub fn machines(&self) -> Vec<MachineRecord> {
        self.read("machines.json")
    }

    pub fn save_machines(&self, machines: &[MachineRecord]) -> Result<(), String> {
        self.write("machines.json", &machines)
    }

    pub fn settings(&self) -> Settings {
        self.read("settings.json")
    }

    pub fn save_settings(&self, settings: &Settings) -> Result<(), String> {
        self.write("settings.json", settings)
    }

    pub fn token(&self, machine_id: &str) -> Option<String> {
        if let Ok(entry) = keyring::Entry::new(KEYRING_SERVICE, machine_id) {
            if let Ok(token) = entry.get_password() {
                return Some(token);
            }
        }
        self.read::<HashMap<String, String>>("tokens.json").remove(machine_id)
    }

    pub fn set_token(&self, machine_id: &str, token: &str) -> Result<(), String> {
        let stored = keyring::Entry::new(KEYRING_SERVICE, machine_id).and_then(|e| e.set_password(token));
        let read_back = keyring::Entry::new(KEYRING_SERVICE, machine_id).and_then(|e| e.get_password()).ok();
        if stored.is_ok() && read_back.as_deref() == Some(token) {
            return Ok(());
        }
        tracing::warn!("keychain unavailable: token stored in a private file");
        let mut tokens: HashMap<String, String> = self.read("tokens.json");
        tokens.insert(machine_id.to_string(), token.to_string());
        self.write("tokens.json", &tokens)
    }

    pub fn delete_token(&self, machine_id: &str) {
        if let Ok(entry) = keyring::Entry::new(KEYRING_SERVICE, machine_id) {
            let _ = entry.delete_credential();
        }
        let mut tokens: HashMap<String, String> = self.read("tokens.json");
        if tokens.remove(machine_id).is_some() {
            let _ = self.write("tokens.json", &tokens);
        }
    }
}
