//! Background service installation: launchd on macOS, systemd --user on Linux.

use std::path::PathBuf;
use std::process::Command;

use anyhow::{bail, Context, Result};

const LABEL: &str = "app.huntaway.huntawayd";

fn exe() -> Result<PathBuf> {
    std::env::current_exe().context("chemin du binaire introuvable")
}

fn home() -> PathBuf {
    herdr_client::home_dir()
}

pub fn unit_path() -> PathBuf {
    if cfg!(target_os = "macos") {
        home().join("Library/LaunchAgents").join(format!("{LABEL}.plist"))
    } else {
        home().join(".config/systemd/user/huntawayd.service")
    }
}

/// Service definition for this platform.
pub fn render() -> Result<String> {
    let exe = xml_escape(&exe()?.display().to_string());
    // The daemon talks to Herdr through its sockets; a short standard PATH is enough.
    let path = format!("{}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin", home().display());
    if cfg!(target_os = "macos") {
        let log = home().join("Library/Logs/huntawayd.log");
        Ok(format!(
            r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>{LABEL}</string>
  <key>ProgramArguments</key><array><string>{exe}</string><string>run</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>{path}</string></dict>
  <key>StandardOutPath</key><string>{log}</string>
  <key>StandardErrorPath</key><string>{log}</string>
</dict>
</plist>
"#,
            log = log.display()
        ))
    } else {
        Ok(format!(
            "[Unit]\nDescription=Huntaway bridge (huntawayd)\nAfter=network-online.target\n\n[Service]\nExecStart={exe} run\nRestart=always\nRestartSec=3\nEnvironment=PATH={path}\n\n[Install]\nWantedBy=default.target\n"
        ))
    }
}

fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

pub fn install(start: bool) -> Result<()> {
    let path = unit_path();
    std::fs::create_dir_all(path.parent().unwrap())?;
    std::fs::write(&path, render()?)?;
    println!("service écrit : {}", path.display());
    if !start {
        println!("démarrage : {}", start_hint());
        return Ok(());
    }
    if cfg!(target_os = "macos") {
        let domain = format!("gui/{}", uid());
        let _ = Command::new("launchctl").args(["bootout", &domain, &path.display().to_string()]).status();
        run(Command::new("launchctl").args(["bootstrap", &domain, &path.display().to_string()]))?;
    } else {
        run(Command::new("systemctl").args(["--user", "daemon-reload"]))?;
        run(Command::new("systemctl").args(["--user", "enable", "huntawayd.service"]))?;
        // Restart rather than start: an update must run the new binary.
        run(Command::new("systemctl").args(["--user", "restart", "huntawayd.service"]))?;
        let user = std::env::var("USER").unwrap_or_default();
        let linger = Command::new("loginctl").args(["show-user", &user, "-p", "Linger", "--value"]).output();
        if !linger.is_ok_and(|o| o.stdout.starts_with(b"yes")) {
            println!("astuce : `sudo loginctl enable-linger $USER` garde le service actif sans session ouverte");
        }
    }
    println!("✓ huntawayd démarré en service");
    Ok(())
}

pub fn uninstall() -> Result<()> {
    let path = unit_path();
    if cfg!(target_os = "macos") {
        let _ = Command::new("launchctl").args(["bootout", &format!("gui/{}", uid()), &path.display().to_string()]).status();
    } else {
        let _ = Command::new("systemctl").args(["--user", "disable", "--now", "huntawayd.service"]).status();
    }
    if path.exists() {
        std::fs::remove_file(&path)?;
    }
    println!("✓ service supprimé");
    Ok(())
}

fn start_hint() -> String {
    if cfg!(target_os = "macos") {
        format!("launchctl bootstrap gui/$(id -u) {}", unit_path().display())
    } else {
        "systemctl --user enable --now huntawayd.service".into()
    }
}

fn uid() -> String {
    Command::new("id").arg("-u").output().map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string()).unwrap_or_default()
}

fn run(cmd: &mut Command) -> Result<()> {
    let status = cmd.status()?;
    if !status.success() {
        bail!("commande échouée : {:?}", cmd);
    }
    Ok(())
}
