//! Daemon configuration and state directory (`~/.config/huntaway/`).

use std::net::{IpAddr, SocketAddr};
use std::path::PathBuf;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

pub const DEFAULT_PORT: u16 = 7420;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Config {
    /// Display name of this machine in the app.
    pub machine_name: String,
    pub port: u16,
    /// Explicit listen addresses. Empty = Tailscale addresses + localhost
    /// (+ LAN addresses when `lan` is true).
    pub listen: Vec<SocketAddr>,
    /// Also listen on private LAN addresses.
    pub lan: bool,
    /// Timeline items kept in memory per agent.
    pub items_per_agent: usize,
    /// Events kept for reconnection replay.
    pub journal_size: usize,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            machine_name: default_machine_name(),
            port: DEFAULT_PORT,
            listen: Vec::new(),
            lan: false,
            items_per_agent: 1000,
            journal_size: 20_000,
        }
    }
}

pub fn state_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("HUNTAWAY_HOME") {
        if !dir.is_empty() {
            return PathBuf::from(dir);
        }
    }
    let base = match std::env::var("XDG_CONFIG_HOME") {
        Ok(dir) if !dir.is_empty() => PathBuf::from(dir),
        _ => herdr_client::home_dir().join(".config"),
    };
    base.join("huntaway")
}

impl Config {
    pub fn load() -> Result<Self> {
        let path = state_dir().join("config.toml");
        if !path.exists() {
            return Ok(Self::default());
        }
        let text = std::fs::read_to_string(&path)?;
        toml::from_str(&text).with_context(|| format!("config invalide : {}", path.display()))
    }

    /// Addresses to bind and to advertise in the pairing QR code.
    pub fn listen_addrs(&self) -> Vec<SocketAddr> {
        if !self.listen.is_empty() {
            return self.listen.clone();
        }
        let mut addrs: Vec<SocketAddr> = local_ips()
            .into_iter()
            .filter(|ip| is_tailscale(*ip) || (self.lan && is_private_lan(*ip)))
            .map(|ip| SocketAddr::new(ip, self.port))
            .collect();
        addrs.push(SocketAddr::new(IpAddr::from([127, 0, 0, 1]), self.port));
        addrs
    }
}

fn default_machine_name() -> String {
    // Absolute path: launchd services get a PATH without /usr/sbin.
    std::process::Command::new("/usr/sbin/scutil")
        .args(["--get", "ComputerName"])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .or_else(|| std::fs::read_to_string("/etc/hostname").ok().map(|s| s.trim().to_string()))
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "machine".into())
}

pub fn hostname() -> Option<String> {
    std::process::Command::new("hostname")
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .filter(|s| !s.is_empty())
}

pub fn local_ips() -> Vec<IpAddr> {
    if_addrs::get_if_addrs()
        .map(|ifs| ifs.into_iter().filter(|i| !i.is_loopback()).map(|i| i.ip()).collect())
        .unwrap_or_default()
}

/// Tailscale assigns addresses from the CGNAT range 100.64.0.0/10.
pub fn is_tailscale(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            let o = v4.octets();
            o[0] == 100 && (64..128).contains(&o[1])
        }
        IpAddr::V6(v6) => v6.segments()[0] == 0xfd7a && v6.segments()[1] == 0x115c,
    }
}

fn is_private_lan(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => v4.is_private(),
        IpAddr::V6(_) => false,
    }
}

/// MagicDNS name of this machine, when the Tailscale CLI is available.
pub fn tailscale_dns_name() -> Option<String> {
    let out = std::process::Command::new("tailscale").args(["status", "--json"]).output().ok()?;
    let status: serde_json::Value = serde_json::from_slice(&out.stdout).ok()?;
    let name = status["Self"]["DNSName"].as_str()?.trim_end_matches('.');
    (!name.is_empty()).then(|| name.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_tailscale_range() {
        assert!(is_tailscale("100.97.66.61".parse().unwrap()));
        assert!(!is_tailscale("100.128.0.1".parse().unwrap()));
        assert!(!is_tailscale("192.168.1.20".parse().unwrap()));
        assert!(is_tailscale("fd7a:115c:a1e0::1".parse().unwrap()));
    }

    #[test]
    fn explicit_listen_wins() {
        let config = Config { listen: vec!["127.0.0.1:9000".parse().unwrap()], ..Config::default() };
        assert_eq!(config.listen_addrs(), vec!["127.0.0.1:9000".parse().unwrap()]);
    }
}
