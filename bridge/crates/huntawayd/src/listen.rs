//! Listening sockets. Interfaces come and go (Tailscale started after the
//! service, a new LAN address): the listen addresses are re-scanned
//! periodically and servers started or stopped to match.

use std::collections::{BTreeMap, HashSet};
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::{bail, Result};
use axum::extract::connect_info::IntoMakeServiceWithConnectInfo;
use axum::Router;
use tokio::task::JoinHandle;
use tracing::{debug, info, warn};

use crate::config::Config;

const RESCAN_EVERY: Duration = Duration::from_secs(15);

type App = IntoMakeServiceWithConnectInfo<Router, SocketAddr>;

/// Addresses currently served, shared with the API (`GET /v1/machine`).
#[derive(Default)]
pub struct Listeners {
    active: Mutex<BTreeMap<SocketAddr, JoinHandle<()>>>,
    /// Addresses that failed to bind, logged once.
    failed: Mutex<HashSet<SocketAddr>>,
}

impl Listeners {
    /// `ip:port` the daemon listens on right now, loopback last.
    pub fn addresses(&self) -> Vec<String> {
        let mut addrs: Vec<SocketAddr> = self.active.lock().unwrap().keys().copied().collect();
        addrs.sort_by_key(|a| a.ip().is_loopback());
        addrs.iter().map(SocketAddr::to_string).collect()
    }

    /// Starts servers on new addresses and stops those no longer wanted.
    async fn sync(self: &Arc<Self>, wanted: &[SocketAddr], app: &App) {
        let gone: Vec<SocketAddr> = {
            let mut active = self.active.lock().unwrap();
            // Servers that stopped on their own are restarted below.
            active.retain(|_, task| !task.is_finished());
            active.keys().filter(|a| !wanted.contains(a)).copied().collect()
        };
        for addr in gone {
            if let Some(task) = self.active.lock().unwrap().remove(&addr) {
                task.abort();
                info!(%addr, "address gone, stopped listening");
            }
        }
        for &addr in wanted {
            if self.active.lock().unwrap().contains_key(&addr) {
                continue;
            }
            match tokio::net::TcpListener::bind(addr).await {
                Ok(listener) => {
                    info!(%addr, "listening");
                    self.failed.lock().unwrap().remove(&addr);
                    let app = app.clone();
                    let task = tokio::spawn(async move {
                        if let Err(e) = axum::serve(listener, app).await {
                            warn!(%addr, error = %e, "server stopped");
                        }
                    });
                    self.active.lock().unwrap().insert(addr, task);
                }
                Err(e) => {
                    if self.failed.lock().unwrap().insert(addr) {
                        warn!(%addr, error = %e, "cannot listen on this address");
                    } else {
                        debug!(%addr, error = %e, "still cannot listen on this address");
                    }
                }
            }
        }
    }
}

/// Serves `app` on the configured addresses forever, following interface changes.
pub async fn run(listeners: Arc<Listeners>, config: Config, app: App) -> Result<()> {
    listeners.sync(&config.listen_addrs(), &app).await;
    if listeners.active.lock().unwrap().is_empty() {
        bail!("no listen address available");
    }
    let mut interval = tokio::time::interval(RESCAN_EVERY);
    interval.tick().await;
    loop {
        interval.tick().await;
        listeners.sync(&config.listen_addrs(), &app).await;
    }
}
