//! `huntawayd`: the Huntaway bridge daemon (PRD §7–§9).
//!
//! One daemon per machine. It follows every local Herdr session and exposes
//! an authenticated HTTP + WebSocket API to the Huntaway mobile app.

mod api;
mod auth;
mod config;
mod engine;
mod files;
mod history;
mod presence;
mod push;
mod service;

use std::net::{SocketAddr, TcpStream};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{bail, Context, Result};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use clap::{Parser, Subcommand};
use serde_json::json;
use tracing::{info, warn};

use crate::auth::{Identity, Store, ALL_PERMISSIONS, DEFAULT_PERMISSIONS, READ_ONLY_PERMISSIONS};
use crate::config::{state_dir, Config};

#[derive(Parser)]
#[command(name = "huntawayd", version, about = "Huntaway bridge: pilote tes agents Herdr depuis ton téléphone")]
struct Cli {
    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Subcommand)]
enum Command {
    /// Run the daemon (default).
    Run,
    /// Show a QR code to pair a phone (code valid 5 minutes).
    Pair {
        /// Also grant raw input and agent creation.
        #[arg(long, conflicts_with = "read_only")]
        full: bool,
        /// Observer device: read only, no messages or approvals.
        #[arg(long)]
        read_only: bool,
        /// Print the pairing payload as JSON instead of a QR code.
        #[arg(long, conflicts_with = "link")]
        json: bool,
        /// Print a `huntaway://pair/…` link to paste in the desktop app.
        #[arg(long)]
        link: bool,
    },
    /// Manage paired devices.
    Devices {
        #[command(subcommand)]
        action: DevicesAction,
    },
    /// Install or remove the background service (launchd / systemd --user).
    Service {
        #[command(subcommand)]
        action: ServiceAction,
    },
    /// Check Herdr sessions, agents and whether the daemon is reachable.
    Status,
}

#[derive(Subcommand)]
enum DevicesAction {
    List,
    Revoke { id: String },
}

#[derive(Subcommand)]
enum ServiceAction {
    /// Write the service file; `--start` also starts it.
    Install {
        #[arg(long)]
        start: bool,
    },
    Uninstall,
    /// Print the service file without writing it.
    Print,
}

#[tokio::main]
async fn main() -> Result<()> {
    match Cli::parse().command.unwrap_or(Command::Run) {
        Command::Run => run().await,
        Command::Pair { full, read_only, json, link } => pair(full, read_only, json, link),
        Command::Devices { action } => devices(action),
        Command::Service { action } => match action {
            ServiceAction::Install { start } => service::install(start),
            ServiceAction::Uninstall => service::uninstall(),
            ServiceAction::Print => {
                print!("{}", service::render()?);
                Ok(())
            }
        },
        Command::Status => status().await,
    }
}

async fn run() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "huntawayd=info".into()))
        .init();

    let config = Config::load()?;
    let dir = state_dir();
    let identity = Identity::load_or_create(&dir)?;
    let addrs = config.listen_addrs();
    let (engine, notifications) = engine::Engine::new(config, identity.machine_id.clone());
    engine.start();
    let presence = Arc::new(presence::Presence::default());
    // One store for the whole daemon: device writes are serialized in memory.
    let store = Store::new(dir);
    tokio::spawn(push::run(notifications, store.clone(), identity.machine_id.clone(), presence.clone()));

    info!(machine = %engine.machine.machine_name, id = %engine.machine.machine_id, "huntawayd {} démarré", env!("CARGO_PKG_VERSION"));
    if let Err(e) = store.ensure_local_token() {
        warn!(error = %e, "token local non créé : l'app desktop devra être appairée");
    }
    let state = Arc::new(api::AppState { engine, store, identity, history: Default::default(), presence });
    let app = api::router(state).into_make_service_with_connect_info::<SocketAddr>();

    let mut servers = Vec::new();
    for addr in addrs {
        match tokio::net::TcpListener::bind(addr).await {
            Ok(listener) => {
                info!(%addr, "écoute");
                let app = app.clone();
                servers.push(tokio::spawn(async move { axum::serve(listener, app).await }));
            }
            Err(e) => warn!(%addr, error = %e, "impossible d'écouter sur cette adresse"),
        }
    }
    if servers.is_empty() {
        bail!("aucune adresse d'écoute disponible");
    }
    for server in servers {
        server.await??;
    }
    Ok(())
}

fn daemon_reachable(port: u16) -> bool {
    let addr: SocketAddr = ([127, 0, 0, 1], port).into();
    TcpStream::connect_timeout(&addr, Duration::from_millis(500)).is_ok()
}

fn pair(full: bool, read_only: bool, as_json: bool, as_link: bool) -> Result<()> {
    let config = Config::load()?;
    let dir = state_dir();
    let identity = Identity::load_or_create(&dir)?;
    let store = Store::new(dir);
    let permissions = if full {
        ALL_PERMISSIONS
    } else if read_only {
        READ_ONLY_PERMISSIONS
    } else {
        DEFAULT_PERMISSIONS
    };
    let code = store.create_pairing(permissions.iter().map(|s| s.to_string()).collect())?;

    let mut addresses: Vec<String> =
        config.listen_addrs().into_iter().filter(|a| !a.ip().is_loopback()).map(|a| a.to_string()).collect();
    if let Some(dns) = config::tailscale_dns_name() {
        addresses.insert(1.min(addresses.len()), format!("{dns}:{}", config.port));
    }
    if addresses.is_empty() {
        eprintln!("⚠ aucune adresse Tailscale ou LAN trouvée : active Tailscale ou mets `lan = true` dans la config");
    }
    let payload = json!({
        "v": 1,
        "machine_id": identity.machine_id,
        "machine_name": config.machine_name,
        "addresses": addresses,
        "pairing_code": code,
        "fingerprint": identity.fingerprint(),
    });
    let text = payload.to_string();
    if as_json {
        println!("{text}");
        return Ok(());
    }
    let link = format!("{}{}", huntaway_api::PAIR_LINK_PREFIX, URL_SAFE_NO_PAD.encode(text.as_bytes()));
    if as_link {
        println!("{link}");
        eprintln!("Colle ce lien dans Huntaway Desktop → Ajouter une machine (valable 5 minutes).");
        if !daemon_reachable(config.port) {
            eprintln!("⚠ huntawayd ne tourne pas : lance `huntawayd run` ou `huntawayd service install --start`");
        }
        return Ok(());
    }
    let qr = qrcode::QrCode::new(text.as_bytes()).context("génération du QR code")?;
    let image = qr
        .render::<qrcode::render::unicode::Dense1x2>()
        .dark_color(qrcode::render::unicode::Dense1x2::Light)
        .light_color(qrcode::render::unicode::Dense1x2::Dark)
        .quiet_zone(true)
        .build();
    println!("{image}");
    println!("Scanne ce QR code avec Huntaway (valable 5 minutes).");
    println!("Machine : {}  ·  adresses : {}", config.machine_name, addresses.join(", "));
    println!("Empreinte : {}", identity.fingerprint());
    println!("\nSaisie manuelle :\n{text}");
    println!("\nLien pour l'app desktop :\n{link}");
    if !daemon_reachable(config.port) {
        eprintln!("\n⚠ huntawayd ne tourne pas : lance `huntawayd run` ou `huntawayd service install --start`");
    }
    Ok(())
}

fn devices(action: DevicesAction) -> Result<()> {
    let store = Store::open_default();
    match action {
        DevicesAction::List => {
            let devices = store.devices()?.devices;
            if devices.is_empty() {
                println!("aucun appareil appairé (`huntawayd pair`)");
            }
            for d in devices {
                let seen = d.last_seen.map(|t| format!("vu il y a {}", ago(t))).unwrap_or_else(|| "jamais vu".into());
                let push = if d.push_endpoint.is_some() { " · push ✓" } else { "" };
                let push = if d.local_only { " · local (127.0.0.1)" } else { push };
                println!("{}  {:<20} {}{}  [{}]", d.id, d.name, seen, push, d.permissions.join(", "));
            }
        }
        DevicesAction::Revoke { id } => {
            if store.revoke(&id)? {
                println!("✓ appareil {id} révoqué");
            } else {
                bail!("appareil inconnu : {id}");
            }
        }
    }
    Ok(())
}

fn ago(t: u64) -> String {
    let s = auth::now_secs().saturating_sub(t);
    match s {
        0..=59 => format!("{s} s"),
        60..=3599 => format!("{} min", s / 60),
        3600..=86399 => format!("{} h", s / 3600),
        _ => format!("{} j", s / 86400),
    }
}

async fn status() -> Result<()> {
    let config = Config::load()?;
    println!(
        "huntawayd : {}",
        if daemon_reachable(config.port) { format!("en marche (port {})", config.port) } else { "arrêté".into() }
    );
    println!("adresses : {}", config.listen_addrs().iter().map(|a| a.to_string()).collect::<Vec<_>>().join(", "));
    let sessions = herdr_client::discover_live_sessions().await;
    if sessions.is_empty() {
        println!("herdr : aucune session active");
    }
    for (session, pong) in sessions {
        let client = herdr_client::Client::new(&session.socket);
        let agents = client.agent_list().await.unwrap_or_default();
        println!("herdr : session {} (v{}, protocole {}) · {} agents", session.name, pong.version, pong.protocol, agents.len());
        if pong.protocol != engine::TESTED_HERDR_PROTOCOL {
            println!("  ⚠ protocole Herdr {} non testé (testé : {})", pong.protocol, engine::TESTED_HERDR_PROTOCOL);
        }
        let missing = agents.iter().filter(|a| a.agent.as_deref() == Some("claude") && a.agent_session.is_none()).count();
        if missing > 0 {
            println!("  ⚠ {missing} agent(s) Claude sans identifiant de session : lance `herdr integration install claude` puis redémarre-les");
        }
    }
    // API contract: every Herdr method Huntaway uses must exist in this Herdr.
    // Herdr installs itself in ~/.local/bin, often missing from a non-interactive SSH PATH.
    let local = herdr_client::home_dir().join(".local/bin/herdr");
    let herdr = if local.exists() { local } else { std::path::PathBuf::from("herdr") };
    match std::process::Command::new(herdr).args(["api", "schema", "--json"]).output() {
        Ok(out) if out.status.success() => match serde_json::from_slice::<serde_json::Value>(&out.stdout) {
            Ok(schema) => {
                let missing = herdr_client::missing_methods(&schema);
                if missing.is_empty() {
                    println!("api herdr : compatible ({} méthodes utilisées présentes)", herdr_client::USED_METHODS.len());
                } else {
                    println!("  ⚠ api herdr : méthodes absentes : {}", missing.join(", "));
                }
            }
            Err(_) => println!("  ⚠ api herdr : schéma illisible"),
        },
        _ => println!("api herdr : `herdr` introuvable dans le PATH, contrôle du schéma ignoré"),
    }
    println!("appareils appairés : {}", Store::open_default().devices()?.devices.len());
    Ok(())
}
