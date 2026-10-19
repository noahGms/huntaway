//! Self-update from the GitHub releases: `huntawayd update` and
//! `POST /v1/daemon/update`. The binary is checked against `SHA256SUMS`,
//! tried (`--version`), then swapped atomically; the previous one is kept as
//! `huntawayd.old`. If the new binary keeps failing to start, the next start
//! puts the old one back ([`startup_check`]).

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tracing::{info, warn};

use crate::config::state_dir;

const REPO: &str = "noahGms/huntaway";
const MARKER: &str = "update.json";
/// Starts of a freshly updated binary before the previous one is restored.
const MAX_ATTEMPTS: u32 = 3;
/// A start that lasts this long counts as successful.
const HEALTHY_AFTER: Duration = Duration::from_secs(60);

static RUNNING: AtomicBool = AtomicBool::new(false);

pub fn current() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

/// `1.2.3` → (1, 2, 3); pre-release suffixes are ignored.
fn parse(v: &str) -> (u64, u64, u64) {
    let mut it = v.trim_start_matches('v').split(['.', '-']).map(|p| p.parse::<u64>().unwrap_or(0));
    (it.next().unwrap_or(0), it.next().unwrap_or(0), it.next().unwrap_or(0))
}

pub fn newer(latest: &str, current: &str) -> bool {
    parse(latest) > parse(current)
}

fn asset_name() -> Result<String> {
    let os = match std::env::consts::OS {
        "macos" => "macos",
        "linux" => "linux",
        other => bail!("no release binary for {other}"),
    };
    let arch = match std::env::consts::ARCH {
        "x86_64" => "x86_64",
        "aarch64" => "arm64",
        other => bail!("no release binary for {other}"),
    };
    Ok(format!("huntawayd-{os}-{arch}"))
}

fn http() -> Result<reqwest::Client> {
    Ok(reqwest::Client::builder()
        .user_agent(concat!("huntawayd/", env!("CARGO_PKG_VERSION")))
        .timeout(Duration::from_secs(120))
        .build()?)
}

pub use huntaway_api::DaemonUpdateCheck as Check;

/// Latest release tag, without the `v`.
pub async fn latest() -> Result<String> {
    #[derive(Deserialize)]
    struct Release {
        tag_name: String,
    }
    let release: Release = http()?
        .get(format!("https://api.github.com/repos/{REPO}/releases/latest"))
        .send()
        .await?
        .error_for_status()
        .context("cannot read the latest release")?
        .json()
        .await?;
    Ok(release.tag_name.trim_start_matches('v').to_string())
}

pub async fn check() -> Result<Check> {
    let latest = latest().await?;
    Ok(Check { available: newer(&latest, current()), current: current().to_string(), latest })
}

fn exe_path() -> Result<PathBuf> {
    let exe = std::env::current_exe().context("cannot find the binary path")?;
    Ok(exe.canonicalize().unwrap_or(exe))
}

fn old_path(exe: &Path) -> PathBuf {
    exe.with_file_name("huntawayd.old")
}

#[derive(Serialize, Deserialize)]
struct Marker {
    from: String,
    to: String,
    attempts: u32,
}

/// Downloads `version`, verifies it and swaps it in place of the running
/// binary. Does not restart.
pub async fn install(version: &str) -> Result<()> {
    if RUNNING.swap(true, Ordering::SeqCst) {
        bail!("an update is already running");
    }
    let result = install_inner(version).await;
    RUNNING.store(false, Ordering::SeqCst);
    result
}

async fn install_inner(version: &str) -> Result<()> {
    let asset = asset_name()?;
    let base = std::env::var("HUNTAWAY_BASE_URL")
        .ok()
        .filter(|b| !b.is_empty())
        .unwrap_or_else(|| format!("https://github.com/{REPO}/releases/download/v{version}"));
    let client = http()?;
    let sums = client.get(format!("{base}/SHA256SUMS")).send().await?.error_for_status().context("cannot download SHA256SUMS")?.text().await?;
    let expected = sums
        .lines()
        .find_map(|l| {
            let mut parts = l.split_whitespace();
            let (hash, name) = (parts.next()?, parts.next()?);
            (name.trim_start_matches('*') == asset).then(|| hash.to_lowercase())
        })
        .with_context(|| format!("{asset} is missing from SHA256SUMS"))?;
    let bytes = client.get(format!("{base}/{asset}")).send().await?.error_for_status().with_context(|| format!("cannot download {asset}"))?.bytes().await?;
    let actual = format!("{:x}", Sha256::digest(&bytes));
    if actual != expected {
        bail!("checksum mismatch for {asset}");
    }

    let exe = exe_path()?;
    let new = exe.with_file_name("huntawayd.new");
    std::fs::write(&new, &bytes).with_context(|| format!("cannot write {}", new.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&new, std::fs::Permissions::from_mode(0o755))?;
    }
    // The new binary must run on this machine before it replaces the old one.
    let out = std::process::Command::new(&new).arg("--version").output();
    let reported = out.as_ref().ok().filter(|o| o.status.success()).map(|o| String::from_utf8_lossy(&o.stdout).to_string());
    if reported.as_deref().is_none_or(|r| !r.contains(version)) {
        let _ = std::fs::remove_file(&new);
        bail!("the downloaded binary does not run on this machine");
    }
    std::fs::copy(&exe, old_path(&exe)).context("cannot keep the previous binary")?;
    std::fs::rename(&new, &exe).context("cannot replace the binary")?;
    let marker = Marker { from: current().to_string(), to: version.to_string(), attempts: 0 };
    std::fs::write(state_dir().join(MARKER), serde_json::to_string(&marker)?)?;
    info!(from = current(), to = version, "huntawayd updated");
    Ok(())
}

/// Replaces the running process with the binary now on disk (same pid, so
/// launchd/systemd keep tracking it).
pub fn restart_in_place() -> ! {
    let exe = exe_path().unwrap_or_else(|_| PathBuf::from("huntawayd"));
    let args: Vec<String> = std::env::args().skip(1).collect();
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        let err = std::process::Command::new(&exe).args(&args).exec();
        warn!(error = %err, "cannot restart in place");
    }
    // Let the service manager start the new binary.
    std::process::exit(75)
}

/// Called when the daemon starts. After an update, counts the starts of the
/// new binary; past [`MAX_ATTEMPTS`] it restores the previous one and runs
/// it. A start that stays up [`HEALTHY_AFTER`] clears the marker.
pub fn startup_check() {
    let path = state_dir().join(MARKER);
    let Ok(text) = std::fs::read_to_string(&path) else { return };
    let Ok(mut marker) = serde_json::from_str::<Marker>(&text) else {
        let _ = std::fs::remove_file(&path);
        return;
    };
    marker.attempts += 1;
    let exe = exe_path().ok();
    if marker.attempts > MAX_ATTEMPTS {
        if let Some(exe) = exe.filter(|e| old_path(e).exists()) {
            warn!(version = %marker.to, previous = %marker.from, "the updated binary keeps failing: restoring the previous one");
            let _ = std::fs::remove_file(&path);
            if std::fs::rename(old_path(&exe), &exe).is_ok() {
                restart_in_place();
            }
        }
        let _ = std::fs::remove_file(&path);
        return;
    }
    let _ = std::fs::write(&path, serde_json::to_string(&marker).unwrap_or_default());
    tokio::spawn(async move {
        tokio::time::sleep(HEALTHY_AFTER).await;
        let _ = std::fs::remove_file(&path);
    });
}

/// `huntawayd update [--check]`.
pub async fn cli(check_only: bool) -> Result<()> {
    let c = check().await?;
    if !c.available {
        println!("huntawayd {} is up to date", c.current);
        return Ok(());
    }
    if check_only {
        println!("huntawayd {} available (installed: {})", c.latest, c.current);
        return Ok(());
    }
    println!("→ updating huntawayd {} → {}", c.current, c.latest);
    install(&c.latest).await?;
    println!("✓ huntawayd {} installed", c.latest);
    if crate::service::unit_path().exists() {
        crate::service::restart()?;
        println!("✓ service restarted");
    } else {
        println!("restart huntawayd to run the new version");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn versions_compare_numerically() {
        assert!(newer("0.1.10", "0.1.9"));
        assert!(newer("v1.0.0", "0.9.9"));
        assert!(!newer("0.1.2", "0.1.2"));
        assert!(!newer("0.1.2-rc1", "0.1.2"));
    }
}
