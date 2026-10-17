//! `/v1/stream` follower: connects, replays missed events with `since` /
//! `epoch`, reloads the state when the daemon asks for a resync, measures the
//! latency and reconnects with backoff.

use std::time::{Duration, Instant};

use futures_util::{SinkExt, StreamExt};
use huntaway_api::{Envelope, StateSnapshot, StreamMessage};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use tokio_tungstenite::tungstenite::Message;

use crate::Client;

#[derive(Debug, Clone)]
pub enum StreamEvent {
    /// Connected through `address`.
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
pub struct StreamHandle(JoinHandle<()>);

impl Drop for StreamHandle {
    fn drop(&mut self) {
        self.0.abort();
    }
}

const PING_EVERY: Duration = Duration::from_secs(10);
/// No message (not even a pong) for this long: the connection is dead.
const SILENCE_MAX: Duration = Duration::from_secs(45);
const BACKOFF_MAX: Duration = Duration::from_secs(15);

pub fn spawn(client: Client) -> (StreamHandle, mpsc::UnboundedReceiver<StreamEvent>) {
    let (tx, rx) = mpsc::unbounded_channel();
    let handle = tokio::spawn(run(client, tx));
    (StreamHandle(handle), rx)
}

struct Cursor {
    epoch: Option<String>,
    seq: u64,
}

async fn run(client: Client, tx: mpsc::UnboundedSender<StreamEvent>) {
    let mut cursor = Cursor { epoch: None, seq: 0 };
    let mut backoff = Duration::from_millis(500);
    loop {
        let started = Instant::now();
        let error = match follow(&client, &tx, &mut cursor).await {
            Ok(()) => "connexion fermée".to_string(),
            Err(e) => e,
        };
        if tx.is_closed() {
            return;
        }
        // A connection that lived a while resets the backoff.
        if started.elapsed() > Duration::from_secs(30) {
            backoff = Duration::from_millis(500);
        }
        let _ = tx.send(StreamEvent::Disconnected { error, retry_in: backoff });
        tokio::time::sleep(backoff).await;
        backoff = (backoff * 2).min(BACKOFF_MAX);
    }
}

async fn follow(client: &Client, tx: &mpsc::UnboundedSender<StreamEvent>, cursor: &mut Cursor) -> Result<(), String> {
    let path = match &cursor.epoch {
        Some(epoch) => format!("/v1/stream?since={}&epoch={}", cursor.seq, urlencoding::encode(epoch)),
        None => "/v1/stream".to_string(),
    };
    let mut socket = None;
    let mut last_error = String::from("aucune adresse");
    for (index, url) in client.ws_candidates(&path) {
        match tokio::time::timeout(Duration::from_secs(4), tokio_tungstenite::connect_async(&url)).await {
            Ok(Ok((ws, _))) => {
                client.mark_active(index);
                socket = Some(ws);
                break;
            }
            Ok(Err(e)) => last_error = e.to_string(),
            Err(_) => last_error = "délai dépassé".into(),
        }
    }
    let ws = socket.ok_or(last_error)?;
    let _ = tx.send(StreamEvent::Connected { address: client.active_address().unwrap_or_default() });
    let (mut sink, mut source) = ws.split();
    let mut ping = tokio::time::interval(PING_EVERY);
    let mut ping_sent: Option<Instant> = None;
    let mut last_seen = Instant::now();

    loop {
        tokio::select! {
            _ = ping.tick() => {
                if last_seen.elapsed() > SILENCE_MAX {
                    return Err("plus de réponse de la machine".into());
                }
                ping_sent = Some(Instant::now());
                sink.send(Message::Ping(Vec::new().into())).await.map_err(|e| e.to_string())?;
            }
            msg = source.next() => {
                let Some(msg) = msg else { return Ok(()) };
                let msg = msg.map_err(|e| e.to_string())?;
                last_seen = Instant::now();
                match msg {
                    Message::Text(text) => handle_text(client, tx, cursor, &text).await?,
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

async fn handle_text(client: &Client, tx: &mpsc::UnboundedSender<StreamEvent>, cursor: &mut Cursor, text: &str) -> Result<(), String> {
    match StreamMessage::parse(text) {
        Some(StreamMessage::Hello(hello)) => {
            if hello.resync_required || cursor.epoch.as_deref() != Some(hello.epoch.as_str()) {
                let snapshot = client.state().await.map_err(|e| e.to_string())?;
                cursor.epoch = Some(snapshot.machine.epoch.clone());
                cursor.seq = snapshot.seq;
                let _ = tx.send(StreamEvent::Snapshot(Box::new(snapshot)));
            }
        }
        Some(StreamMessage::Event(event)) => {
            // Already part of the snapshot.
            if event.seq <= cursor.seq {
                return Ok(());
            }
            cursor.seq = event.seq;
            let _ = tx.send(StreamEvent::Event(Box::new(event)));
        }
        None => {}
    }
    Ok(())
}
