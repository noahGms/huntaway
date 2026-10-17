//! Rust client of the `huntawayd` API (`docs/api.md`).
//!
//! - [`Client`]: authenticated HTTP calls, trying the machine's addresses in
//!   order and remembering the one that answered;
//! - [`stream::spawn`]: the `/v1/stream` WebSocket with replay (`since` /
//!   `epoch`), resync and reconnection;
//! - [`terminal::open`]: the live terminal of an agent;
//! - [`pairing`]: pairing links and identity checks.

pub mod pairing;
pub mod stream;
pub mod terminal;

use std::sync::{Arc, Mutex};
use std::time::Duration;

pub use huntaway_api as api;
use huntaway_api::{ErrorBody, MachineResponse, StateSnapshot};
use reqwest::Method;
use serde::de::DeserializeOwned;
use serde_json::Value;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// The daemon answered with an error body.
    #[error("{message}")]
    Api { status: u16, code: String, message: String },
    /// No address answered.
    #[error("machine injoignable : {0}")]
    Unreachable(String),
    #[error("réponse invalide : {0}")]
    Decode(String),
    #[error("{0}")]
    Pairing(String),
}

impl Error {
    pub fn code(&self) -> &str {
        match self {
            Error::Api { code, .. } => code,
            Error::Unreachable(_) => "unreachable",
            Error::Decode(_) => "decode",
            Error::Pairing(_) => "pairing",
        }
    }
}

pub type Result<T> = std::result::Result<T, Error>;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(3);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(90);

/// HTTP client of one machine.
#[derive(Clone)]
pub struct Client {
    http: reqwest::Client,
    addresses: Arc<Vec<String>>,
    token: Arc<String>,
    /// Index of the address that answered last.
    active: Arc<Mutex<usize>>,
}

impl Client {
    /// `addresses` are `host:port` entries, tried in order.
    pub fn new(addresses: Vec<String>, token: String) -> Self {
        let http = reqwest::Client::builder()
            .connect_timeout(CONNECT_TIMEOUT)
            .timeout(REQUEST_TIMEOUT)
            .build()
            .expect("client http");
        Self { http, addresses: Arc::new(addresses), token: Arc::new(token), active: Arc::new(Mutex::new(0)) }
    }

    pub fn addresses(&self) -> &[String] {
        &self.addresses
    }

    pub fn token(&self) -> &str {
        &self.token
    }

    /// Address that answered last.
    pub fn active_address(&self) -> Option<String> {
        self.addresses.get(*self.active.lock().unwrap()).cloned()
    }

    /// Addresses starting with the active one.
    fn ordered(&self) -> Vec<(usize, String)> {
        let start = *self.active.lock().unwrap();
        let n = self.addresses.len();
        (0..n).map(|i| (start + i) % n).map(|i| (i, self.addresses[i].clone())).collect()
    }

    pub(crate) fn mark_active(&self, index: usize) {
        *self.active.lock().unwrap() = index;
    }

    pub(crate) fn ws_candidates(&self, path_and_query: &str) -> Vec<(usize, String)> {
        let sep = if path_and_query.contains('?') { '&' } else { '?' };
        self.ordered()
            .into_iter()
            .map(|(i, addr)| (i, format!("ws://{addr}{path_and_query}{sep}token={}", urlencoding::encode(&self.token))))
            .collect()
    }

    async fn send(&self, method: Method, path: &str, body: Option<Body>) -> Result<Value> {
        let mut last = String::from("aucune adresse");
        for (index, addr) in self.ordered() {
            let url = format!("http://{addr}{path}");
            let mut req = self.http.request(method.clone(), &url).bearer_auth(self.token.as_str());
            match &body {
                Some(Body::Json(v)) => req = req.json(v),
                Some(Body::Bytes(b)) => req = req.header("content-type", "application/octet-stream").body(b.clone()),
                None => {}
            }
            let resp = match req.send().await {
                Ok(r) => r,
                Err(e) if e.is_connect() || (e.is_timeout() && !e.is_body()) => {
                    last = format!("{addr} : {e}");
                    continue;
                }
                Err(e) => return Err(Error::Unreachable(e.to_string())),
            };
            self.mark_active(index);
            let status = resp.status();
            let bytes = resp.bytes().await.map_err(|e| Error::Unreachable(e.to_string()))?;
            if status.is_success() {
                return serde_json::from_slice(&bytes).map_err(|e| Error::Decode(e.to_string()));
            }
            return Err(match serde_json::from_slice::<ErrorBody>(&bytes) {
                Ok(body) => Error::Api { status: status.as_u16(), code: body.error.code, message: body.error.message },
                Err(_) => Error::Api {
                    status: status.as_u16(),
                    code: "http_error".into(),
                    message: format!("HTTP {status} : {}", String::from_utf8_lossy(&bytes).chars().take(200).collect::<String>()),
                },
            });
        }
        Err(Error::Unreachable(last))
    }

    pub async fn get(&self, path: &str) -> Result<Value> {
        self.send(Method::GET, path, None).await
    }

    pub async fn post(&self, path: &str, body: Value) -> Result<Value> {
        self.send(Method::POST, path, Some(Body::Json(body))).await
    }

    pub async fn get_typed<T: DeserializeOwned>(&self, path: &str) -> Result<T> {
        serde_json::from_value(self.get(path).await?).map_err(|e| Error::Decode(e.to_string()))
    }

    pub async fn machine(&self) -> Result<MachineResponse> {
        self.get_typed("/v1/machine").await
    }

    pub async fn state(&self) -> Result<StateSnapshot> {
        self.get_typed("/v1/state").await
    }

    /// Sends an attachment; returns its path on the machine.
    pub async fn upload(&self, name: &str, bytes: Vec<u8>) -> Result<String> {
        let path = format!("/v1/uploads?name={}", urlencoding::encode(name));
        let v = self.send(Method::POST, &path, Some(Body::Bytes(bytes))).await?;
        v["path"].as_str().map(str::to_string).ok_or_else(|| Error::Decode("chemin absent".into()))
    }

    /// Percent-encodes a path segment (agent ids contain `:`).
    pub fn segment(s: &str) -> String {
        urlencoding::encode(s).into_owned()
    }
}

enum Body {
    Json(Value),
    Bytes(Vec<u8>),
}
