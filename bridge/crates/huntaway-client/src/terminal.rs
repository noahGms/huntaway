//! Live terminal of an agent (`/v1/agents/{id}/terminal`): screens in,
//! keystrokes out.

use futures_util::{SinkExt, StreamExt};
use serde_json::Value;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use tokio_tungstenite::tungstenite::Message;

use crate::{Client, Error, Result};

#[derive(Debug, Clone)]
pub enum TerminalEvent {
    /// Whole visible screen, with ANSI colors.
    Screen { ansi: String },
    Error { code: String, message: String },
    Closed,
}

/// Input sent to the pane: text and/or Herdr key names (`enter`, `esc`, `ctrl+c`…).
#[derive(Debug, Clone, serde::Serialize)]
pub struct TerminalInput {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub keys: Vec<String>,
}

pub struct TerminalHandle {
    pub input: mpsc::UnboundedSender<TerminalInput>,
    task: JoinHandle<()>,
}

impl Drop for TerminalHandle {
    fn drop(&mut self) {
        self.task.abort();
    }
}

pub async fn open(client: &Client, agent_id: &str) -> Result<(TerminalHandle, mpsc::UnboundedReceiver<TerminalEvent>)> {
    let path = format!("/v1/agents/{}/terminal", Client::segment(agent_id));
    let mut last = String::new();
    for (index, url) in client.ws_candidates(&path) {
        match tokio_tungstenite::connect_async(&url).await {
            Ok((ws, _)) => {
                client.mark_active(index);
                let (out_tx, mut out_rx) = mpsc::unbounded_channel::<TerminalInput>();
                let (ev_tx, ev_rx) = mpsc::unbounded_channel();
                let task = tokio::spawn(async move {
                    let (mut sink, mut source) = ws.split();
                    loop {
                        tokio::select! {
                            input = out_rx.recv() => {
                                let Some(input) = input else { break };
                                let text = serde_json::to_string(&input).unwrap_or_default();
                                if sink.send(Message::Text(text.into())).await.is_err() {
                                    break;
                                }
                            }
                            msg = source.next() => match msg {
                                Some(Ok(Message::Text(text))) => {
                                    let Ok(v) = serde_json::from_str::<Value>(&text) else { continue };
                                    let event = match v["type"].as_str() {
                                        Some("screen") => TerminalEvent::Screen { ansi: v["ansi"].as_str().unwrap_or_default().to_string() },
                                        Some("error") => TerminalEvent::Error {
                                            code: v["code"].as_str().unwrap_or_default().to_string(),
                                            message: v["message"].as_str().unwrap_or_default().to_string(),
                                        },
                                        _ => continue,
                                    };
                                    if ev_tx.send(event).is_err() {
                                        break;
                                    }
                                }
                                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                                _ => {}
                            }
                        }
                    }
                    let _ = ev_tx.send(TerminalEvent::Closed);
                });
                return Ok((TerminalHandle { input: out_tx, task }, ev_rx));
            }
            Err(e) => last = e.to_string(),
        }
    }
    Err(Error::Unreachable(last))
}
