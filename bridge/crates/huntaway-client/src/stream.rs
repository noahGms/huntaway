//! `/v1/stream` follower: connects, replays missed events with `since` /
//! `epoch`, reloads the state when the daemon asks for a resync, measures the
//! latency and reconnects with backoff.

use std::sync::Arc;
use std::time::{Duration, Instant};

use futures_util::{SinkExt, StreamExt};
use huntaway_api::{Envelope, StateSnapshot, StreamMessage};
use tokio::sync::{mpsc, Notify};
use tokio::task::JoinHandle;
use tokio_tungstenite::tungstenite::Message;

use crate::Client;

#[derive(Debug, Clone)]
pub enum StreamEvent {
    /// Connected through `address`, with the state loaded: sent after the
    /// daemon's hello was handled (and the snapshot, when one was needed).
    Connected { address: String },
    /// Full state (first connection, daemon restart, events lost).
    Snapshot(Box<StateSnapshot>),
    Event(Box<Envelope>),
    /// Round trip of a WebSocket ping, in milliseconds.
    Latency(u64),
    /// Connection lost; a new attempt follows after `retry_in`.
    Disconnected { error: String, retry_in: Duration },
}

/// Stops the follower when dropped.
pub struct StreamHandle {
    task: JoinHandle<()>,
    kick: Arc<Notify>,
}

impl StreamHandle {
    /// Checks the connection now instead of waiting for the next ping or
    /// retry. Disconnected: retries at once with the backoff reset.
    /// Connected: sends a ping and reconnects if nothing answers within
    /// 3 s (a socket that died during sleep). Call it when the app comes
    /// back to the foreground (window focus, wake-up). Cheap on a healthy
    /// connection.
    pub fn kick(&self) {
        self.kick.notify_one();
    }
}

impl Drop for StreamHandle {
    fn drop(&mut self) {
        self.task.abort();
    }
}

const PING_EVERY: Duration = Duration::from_secs(10);
/// No message (not even a pong) for this long: the connection is dead.
const SILENCE_MAX: Duration = Duration::from_secs(45);
/// After a kick, the connection must answer within this delay.
const KICK_PROBE: Duration = Duration::from_secs(3);
const BACKOFF_MIN: Duration = Duration::from_millis(500);
const BACKOFF_MAX: Duration = Duration::from_secs(15);

pub fn spawn(client: Client) -> (StreamHandle, mpsc::UnboundedReceiver<StreamEvent>) {
    let (tx, rx) = mpsc::unbounded_channel();
    let kick = Arc::new(Notify::new());
    let task = tokio::spawn(run(client, tx, kick.clone()));
    (StreamHandle { task, kick }, rx)
}

struct Cursor {
    epoch: Option<String>,
    seq: u64,
}

async fn run(client: Client, tx: mpsc::UnboundedSender<StreamEvent>, kick: Arc<Notify>) {
    let mut cursor = Cursor { epoch: None, seq: 0 };
    let mut backoff = BACKOFF_MIN;
    loop {
        let started = Instant::now();
        let error = match follow(&client, &tx, &mut cursor, &kick).await {
            Ok(()) => "connection closed".to_string(),
            Err(e) => e,
        };
        if tx.is_closed() {
            return;
        }
        // A connection that lived a while resets the backoff.
        if started.elapsed() > Duration::from_secs(30) {
            backoff = BACKOFF_MIN;
        }
        let _ = tx.send(StreamEvent::Disconnected { error, retry_in: backoff });
        tokio::select! {
            _ = tokio::time::sleep(backoff) => backoff = (backoff * 2).min(BACKOFF_MAX),
            _ = kick.notified() => backoff = BACKOFF_MIN,
        }
    }
}

async fn follow(client: &Client, tx: &mpsc::UnboundedSender<StreamEvent>, cursor: &mut Cursor, kick: &Notify) -> Result<(), String> {
    let path = match &cursor.epoch {
        Some(epoch) => format!("/v1/stream?since={}&epoch={}", cursor.seq, urlencoding::encode(epoch)),
        None => "/v1/stream".to_string(),
    };
    let mut socket = None;
    let mut last_error = String::from("no address");
    for (index, url) in client.ws_candidates(&path) {
        match tokio::time::timeout(Duration::from_secs(4), tokio_tungstenite::connect_async(&url)).await {
            Ok(Ok((ws, _))) => {
                client.mark_active(index);
                socket = Some(ws);
                break;
            }
            Ok(Err(e)) => last_error = e.to_string(),
            Err(_) => last_error = "timed out".into(),
        }
    }
    let ws = socket.ok_or(last_error)?;
    let (mut sink, mut source) = ws.split();
    let mut ping = tokio::time::interval(PING_EVERY);
    let mut ping_sent: Option<Instant> = None;
    let mut last_seen = Instant::now();
    // Set by a kick: the connection must answer before this instant.
    let mut probe: Option<tokio::time::Instant> = None;
    let mut connected = false;

    loop {
        tokio::select! {
            _ = ping.tick() => {
                if last_seen.elapsed() > SILENCE_MAX {
                    return Err("no answer from the machine".into());
                }
                ping_sent = Some(Instant::now());
                sink.send(Message::Ping(Vec::new().into())).await.map_err(|e| e.to_string())?;
            }
            _ = kick.notified(), if probe.is_none() => {
                probe = Some(tokio::time::Instant::now() + KICK_PROBE);
                ping_sent = Some(Instant::now());
                sink.send(Message::Ping(Vec::new().into())).await.map_err(|e| e.to_string())?;
            }
            _ = tokio::time::sleep_until(probe.unwrap_or_else(tokio::time::Instant::now)), if probe.is_some() => {
                return Err("no answer from the machine".into());
            }
            msg = source.next() => {
                let Some(msg) = msg else { return Ok(()) };
                let msg = msg.map_err(|e| e.to_string())?;
                last_seen = Instant::now();
                probe = None;
                match msg {
                    Message::Text(text) => {
                        // The machine counts as connected once its hello is handled.
                        if handle_text(client, tx, cursor, &text).await? && !connected {
                            connected = true;
                            let _ = tx.send(StreamEvent::Connected { address: client.active_address().unwrap_or_default() });
                        }
                    }
                    Message::Pong(_) => {
                        if let Some(at) = ping_sent.take() {
                            let _ = tx.send(StreamEvent::Latency(at.elapsed().as_millis() as u64));
                        }
                    }
                    Message::Close(_) => return Ok(()),
                    _ => {}
                }
            }
        }
        if tx.is_closed() {
            return Ok(());
        }
    }
}

/// Returns true for a hello handled (state reloaded when needed).
async fn handle_text(client: &Client, tx: &mpsc::UnboundedSender<StreamEvent>, cursor: &mut Cursor, text: &str) -> Result<bool, String> {
    match StreamMessage::parse(text) {
        Some(StreamMessage::Hello(hello)) => {
            if hello.resync_required || cursor.epoch.as_deref() != Some(hello.epoch.as_str()) {
                let snapshot = client.state().await.map_err(|e| e.to_string())?;
                cursor.epoch = Some(snapshot.machine.epoch.clone());
                cursor.seq = snapshot.seq;
                let _ = tx.send(StreamEvent::Snapshot(Box::new(snapshot)));
            }
            Ok(true)
        }
        Some(StreamMessage::Event(event)) => {
            // Already part of the snapshot.
            if event.seq > cursor.seq {
                cursor.seq = event.seq;
                let _ = tx.send(StreamEvent::Event(Box::new(event)));
            }
            Ok(false)
        }
        None => Ok(false),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Fake daemon: the WebSocket says hello and asks for a resync; every
    /// other connection (the `/v1/state` request) is dropped.
    async fn fake_daemon() -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap().to_string();
        tokio::spawn(async move {
            while let Ok((stream, _)) = listener.accept().await {
                tokio::spawn(async move {
                    let Ok(mut ws) = tokio_tungstenite::accept_async(stream).await else { return };
                    let hello = r#"{"type":"hello","epoch":"e1","seq":3,"resync_required":true}"#;
                    let _ = ws.send(Message::Text(hello.into())).await;
                    tokio::time::sleep(Duration::from_secs(5)).await;
                });
            }
        });
        addr
    }

    #[tokio::test]
    async fn not_connected_until_the_state_is_loaded() {
        let addr = fake_daemon().await;
        let (_handle, mut rx) = spawn(Client::new(vec![addr], "token".into()));
        let first = tokio::time::timeout(Duration::from_secs(5), rx.recv()).await.unwrap().unwrap();
        assert!(matches!(first, StreamEvent::Disconnected { .. }), "{first:?}");
    }

    async fn recv(rx: &mut mpsc::UnboundedReceiver<StreamEvent>) -> StreamEvent {
        tokio::time::timeout(Duration::from_secs(5), rx.recv()).await.unwrap().unwrap()
    }

    #[tokio::test]
    async fn kick_retries_at_once() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap().to_string();
        drop(listener);
        let (handle, mut rx) = spawn(Client::new(vec![addr], "token".into()));
        // Let the backoff grow past a second, then kick.
        for _ in 0..3 {
            recv(&mut rx).await;
        }
        let started = Instant::now();
        handle.kick();
        let StreamEvent::Disconnected { retry_in, .. } = recv(&mut rx).await else { panic!() };
        assert!(started.elapsed() < Duration::from_millis(900));
        assert_eq!(retry_in, BACKOFF_MIN);
    }
}
