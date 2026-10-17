//! Bridge identity, paired devices and pairing codes (PRD §8).
//!
//! Files in the state dir:
//! - `identity.json`: machine id + ed25519 signing key (created once);
//! - `devices.json`: paired devices, tokens stored as SHA-256 hashes;
//! - `pairing.json`: pending one-time pairing codes written by `huntawayd pair`.
//!
//! The CLI and the running daemon share these files; the daemon re-reads
//! them when they change, so `pair` and `devices revoke` need no IPC.

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{bail, Context, Result};
use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use base64::Engine as _;
use ed25519_dalek::{Signer, SigningKey};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::config::state_dir;

pub use huntaway_api::ALL_PERMISSIONS;

/// Granted at pairing unless `--full` is passed (PRD §8.5).
pub const DEFAULT_PERMISSIONS: &[&str] = &[
    "projects.read",
    "agents.read",
    "agents.message",
    "agents.approve",
    "agents.interrupt",
    "terminal.read",
    "history.read",
    "files.read",
];

/// Observer device: sees everything, acts on nothing (`huntawayd pair --read-only`).
pub const READ_ONLY_PERMISSIONS: &[&str] = &["projects.read", "agents.read", "terminal.read", "history.read"];

/// Name of the device created for desktop apps on this machine.
pub const LOCAL_DEVICE_NAME: &str = "Desktop local";

pub const PAIRING_TTL_SECS: u64 = 300;

pub fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn random_token(bytes: usize) -> String {
    let mut buf = vec![0u8; bytes];
    rand::thread_rng().fill_bytes(&mut buf);
    URL_SAFE_NO_PAD.encode(buf)
}

pub fn sha256_b64(data: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(data))
}

fn write_private(path: &Path, contents: &str) -> Result<()> {
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
    std::fs::rename(&tmp, path)?;
    Ok(())
}

fn read_json<T: for<'de> Deserialize<'de> + Default>(path: &Path) -> Result<T> {
    match std::fs::read_to_string(path) {
        Ok(text) => serde_json::from_str(&text).with_context(|| format!("fichier invalide : {}", path.display())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(T::default()),
        Err(e) => Err(e.into()),
    }
}

// ------------------------------------------------------------------ identity

#[derive(Serialize, Deserialize)]
struct IdentityFile {
    machine_id: String,
    signing_key: String,
}

pub struct Identity {
    pub machine_id: String,
    key: SigningKey,
}

impl Identity {
    pub fn load_or_create(dir: &Path) -> Result<Self> {
        let path = dir.join("identity.json");
        if path.exists() {
            let file: IdentityFile = serde_json::from_str(&std::fs::read_to_string(&path)?)?;
            let bytes: [u8; 32] = STANDARD
                .decode(&file.signing_key)?
                .try_into()
                .map_err(|_| anyhow::anyhow!("clé invalide dans {}", path.display()))?;
            return Ok(Self { machine_id: file.machine_id, key: SigningKey::from_bytes(&bytes) });
        }
        let key = SigningKey::generate(&mut rand::rngs::OsRng);
        let machine_id = format!("m_{}", random_token(9));
        let file = IdentityFile { machine_id: machine_id.clone(), signing_key: STANDARD.encode(key.to_bytes()) };
        write_private(&path, &serde_json::to_string_pretty(&file)?)?;
        Ok(Self { machine_id, key })
    }

    pub fn public_key_b64(&self) -> String {
        STANDARD.encode(self.key.verifying_key().to_bytes())
    }

    /// `sha256:<base64url>` of the raw public key, shown in the QR code.
    pub fn fingerprint(&self) -> String {
        format!("sha256:{}", sha256_b64(&self.key.verifying_key().to_bytes()))
    }

    pub fn sign_b64(&self, message: &[u8]) -> String {
        STANDARD.encode(self.key.sign(message).to_bytes())
    }
}

// ------------------------------------------------------------------- devices

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Device {
    pub id: String,
    pub name: String,
    pub token_sha256: String,
    pub permissions: Vec<String>,
    pub created_at: u64,
    #[serde(default)]
    pub last_seen: Option<u64>,
    /// UnifiedPush endpoint registered by the app.
    #[serde(default)]
    pub push_endpoint: Option<String>,
    /// Token readable from `local.token`, only accepted from 127.0.0.1.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub local_only: bool,
}

impl Device {
    pub fn can(&self, permission: &str) -> bool {
        self.permissions.iter().any(|p| p == permission)
    }
}

#[derive(Debug, Default, Serialize, Deserialize)]
pub struct Devices {
    pub devices: Vec<Device>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PendingPairing {
    pub code_sha256: String,
    pub expires_at: u64,
    pub permissions: Vec<String>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
pub struct Pairings {
    pub pending: Vec<PendingPairing>,
}

/// File-backed store shared by the CLI and the daemon.
pub struct Store {
    dir: PathBuf,
}

impl Store {
    pub fn new(dir: PathBuf) -> Self {
        Self { dir }
    }

    pub fn open_default() -> Self {
        Self::new(state_dir())
    }

    #[cfg(test)]
    pub fn dir(&self) -> &Path {
        &self.dir
    }

    fn devices_path(&self) -> PathBuf {
        self.dir.join("devices.json")
    }

    fn pairing_path(&self) -> PathBuf {
        self.dir.join("pairing.json")
    }

    pub fn local_token_path(&self) -> PathBuf {
        self.dir.join("local.token")
    }

    /// Makes sure `local.token` holds a valid token of the local device (all
    /// permissions, loopback only), so a desktop app on this machine can
    /// connect without pairing. Any process of the user can already drive
    /// Herdr through its socket: this adds no new access.
    pub fn ensure_local_token(&self) -> Result<()> {
        let path = self.local_token_path();
        let all: Vec<String> = ALL_PERMISSIONS.iter().map(|s| s.to_string()).collect();
        let mut devices = self.devices()?;
        if let Ok(token) = std::fs::read_to_string(&path) {
            let hash = sha256_b64(token.trim().as_bytes());
            if let Some(device) = devices.devices.iter_mut().find(|d| d.local_only && d.token_sha256 == hash) {
                if device.permissions != all {
                    device.permissions = all;
                    self.save_devices(&devices)?;
                }
                return Ok(());
            }
        }
        devices.devices.retain(|d| !d.local_only);
        let token = random_token(32);
        devices.devices.push(Device {
            id: format!("d_{}", random_token(6)),
            name: LOCAL_DEVICE_NAME.into(),
            token_sha256: sha256_b64(token.as_bytes()),
            permissions: all,
            created_at: now_secs(),
            last_seen: None,
            push_endpoint: None,
            local_only: true,
        });
        self.save_devices(&devices)?;
        write_private(&path, &token)
    }

    pub fn devices(&self) -> Result<Devices> {
        read_json(&self.devices_path())
    }

    pub fn save_devices(&self, devices: &Devices) -> Result<()> {
        write_private(&self.devices_path(), &serde_json::to_string_pretty(devices)?)
    }

    /// Finds the device owning `token` and records it as seen.
    pub fn authenticate(&self, token: &str) -> Result<Option<Device>> {
        let hash = sha256_b64(token.as_bytes());
        let mut devices = self.devices()?;
        let Some(device) = devices.devices.iter_mut().find(|d| d.token_sha256 == hash) else {
            return Ok(None);
        };
        let now = now_secs();
        // Throttle writes: one per minute is enough for "last seen".
        if device.last_seen.is_none_or(|t| now.saturating_sub(t) > 60) {
            device.last_seen = Some(now);
            let found = device.clone();
            self.save_devices(&devices)?;
            return Ok(Some(found));
        }
        Ok(Some(device.clone()))
    }

    pub fn set_push_endpoint(&self, device_id: &str, endpoint: Option<String>) -> Result<()> {
        let mut devices = self.devices()?;
        let Some(device) = devices.devices.iter_mut().find(|d| d.id == device_id) else {
            bail!("appareil inconnu");
        };
        device.push_endpoint = endpoint;
        self.save_devices(&devices)
    }

    pub fn revoke(&self, device_id: &str) -> Result<bool> {
        let mut devices = self.devices()?;
        let before = devices.devices.len();
        devices.devices.retain(|d| d.id != device_id);
        let removed = devices.devices.len() != before;
        if removed {
            self.save_devices(&devices)?;
        }
        Ok(removed)
    }

    /// Creates a one-time pairing code (returned in clear, stored hashed).
    pub fn create_pairing(&self, permissions: Vec<String>) -> Result<String> {
        let code = random_token(18);
        let mut pairings: Pairings = read_json(&self.pairing_path())?;
        let now = now_secs();
        pairings.pending.retain(|p| p.expires_at > now);
        pairings.pending.push(PendingPairing {
            code_sha256: sha256_b64(code.as_bytes()),
            expires_at: now + PAIRING_TTL_SECS,
            permissions,
        });
        write_private(&self.pairing_path(), &serde_json::to_string_pretty(&pairings)?)?;
        Ok(code)
    }

    /// Consumes a pairing code and registers a new device. Returns the device and its token.
    pub fn redeem_pairing(&self, code: &str, device_name: &str) -> Result<Option<(Device, String)>> {
        let mut pairings: Pairings = read_json(&self.pairing_path())?;
        let now = now_secs();
        let hash = sha256_b64(code.as_bytes());
        let Some(pos) = pairings.pending.iter().position(|p| p.code_sha256 == hash && p.expires_at > now) else {
            return Ok(None);
        };
        let pending = pairings.pending.remove(pos);
        pairings.pending.retain(|p| p.expires_at > now);
        write_private(&self.pairing_path(), &serde_json::to_string_pretty(&pairings)?)?;

        let token = random_token(32);
        let device = Device {
            id: format!("d_{}", random_token(6)),
            name: device_name.chars().take(64).collect(),
            token_sha256: sha256_b64(token.as_bytes()),
            permissions: pending.permissions,
            created_at: now,
            last_seen: Some(now),
            push_endpoint: None,
            local_only: false,
        };
        let mut devices = self.devices()?;
        devices.devices.push(device.clone());
        self.save_devices(&devices)?;
        Ok(Some((device, token)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_store() -> Store {
        let dir = std::env::temp_dir().join(format!("huntaway-auth-{}-{}", std::process::id(), random_token(4)));
        Store::new(dir)
    }

    #[test]
    fn pairing_is_single_use_and_token_authenticates() {
        let store = temp_store();
        let code = store.create_pairing(DEFAULT_PERMISSIONS.iter().map(|s| s.to_string()).collect()).unwrap();
        let (device, token) = store.redeem_pairing(&code, "Pixel").unwrap().unwrap();
        assert!(store.redeem_pairing(&code, "Pixel").unwrap().is_none());
        let found = store.authenticate(&token).unwrap().unwrap();
        assert_eq!(found.id, device.id);
        assert!(found.can("agents.approve"));
        assert!(!found.can("agents.input"));
        assert!(store.authenticate("wrong").unwrap().is_none());
        assert!(store.revoke(&device.id).unwrap());
        assert!(store.authenticate(&token).unwrap().is_none());
    }

    #[test]
    fn local_token_is_stable_and_full() {
        let store = temp_store();
        store.ensure_local_token().unwrap();
        let token = std::fs::read_to_string(store.local_token_path()).unwrap();
        store.ensure_local_token().unwrap();
        assert_eq!(std::fs::read_to_string(store.local_token_path()).unwrap(), token);
        let device = store.authenticate(&token).unwrap().unwrap();
        assert!(device.local_only);
        assert!(device.can("agents.create"));
        assert_eq!(store.devices().unwrap().devices.len(), 1);
        // A deleted token file gets a new device, the old one is removed.
        std::fs::remove_file(store.local_token_path()).unwrap();
        store.ensure_local_token().unwrap();
        assert!(store.authenticate(&token).unwrap().is_none());
        assert_eq!(store.devices().unwrap().devices.len(), 1);
    }

    #[test]
    fn identity_is_stable_and_signs() {
        let store = temp_store();
        let a = Identity::load_or_create(store.dir()).unwrap();
        let b = Identity::load_or_create(store.dir()).unwrap();
        assert_eq!(a.machine_id, b.machine_id);
        assert_eq!(a.fingerprint(), b.fingerprint());
        assert!(a.fingerprint().starts_with("sha256:"));
        assert_eq!(a.sign_b64(b"x"), b.sign_b64(b"x"));
    }
}
