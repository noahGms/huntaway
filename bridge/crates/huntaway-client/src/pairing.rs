//! Pairing: `huntaway://pair/<base64url JSON>` links (same payload as the QR
//! code), `POST /v1/pair`, and the bridge identity check (fingerprint of the
//! public key + ed25519 signature of our nonce).

use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use base64::Engine as _;
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use huntaway_api::{pair_signed_message, PairRequest, PairResponse, PairingPayload, PAIR_LINK_PREFIX};
use rand::RngCore;
use sha2::{Digest, Sha256};

use crate::{Error, Result};

/// Accepts a pairing link, the raw JSON payload, or its base64url.
pub fn parse(input: &str) -> Result<PairingPayload> {
    let input = input.trim();
    let json = if input.starts_with('{') {
        input.as_bytes().to_vec()
    } else {
        let encoded = input.strip_prefix(PAIR_LINK_PREFIX).unwrap_or(input);
        URL_SAFE_NO_PAD
            .decode(encoded.trim_end_matches('='))
            .map_err(|_| Error::Pairing("lien d'appairage invalide".into()))?
    };
    let payload: PairingPayload =
        serde_json::from_slice(&json).map_err(|_| Error::Pairing("contenu d'appairage invalide".into()))?;
    if payload.v != 1 {
        return Err(Error::Pairing(format!("version d'appairage non prise en charge : {}", payload.v)));
    }
    if payload.addresses.is_empty() {
        return Err(Error::Pairing("aucune adresse dans le lien : active Tailscale ou `lan = true` sur la machine".into()));
    }
    Ok(payload)
}

/// `sha256:<base64url>` of a raw public key.
pub fn fingerprint(public_key: &[u8]) -> String {
    format!("sha256:{}", URL_SAFE_NO_PAD.encode(Sha256::digest(public_key)))
}

/// Result of a successful pairing.
#[derive(Debug, Clone)]
pub struct Paired {
    pub machine_id: String,
    pub machine_name: String,
    pub address: String,
    pub addresses: Vec<String>,
    pub device_id: String,
    pub token: String,
    pub permissions: Vec<String>,
    /// Base64 ed25519 key, to detect a machine whose identity changed.
    pub public_key: String,
}

/// Redeems the pairing code on the first address that answers and checks
/// the bridge identity.
pub async fn pair(payload: &PairingPayload, device_name: &str) -> Result<Paired> {
    let mut nonce = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut nonce);
    let nonce = URL_SAFE_NO_PAD.encode(nonce);
    let http = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(4))
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| Error::Pairing(e.to_string()))?;
    let body = PairRequest { code: payload.pairing_code.clone(), device_name: device_name.to_string(), nonce: nonce.clone() };
    let mut last = String::new();
    for addr in &payload.addresses {
        let resp = match http.post(format!("http://{addr}/v1/pair")).json(&body).send().await {
            Ok(r) => r,
            Err(e) => {
                last = format!("{addr} : {e}");
                continue;
            }
        };
        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            let message = serde_json::from_str::<huntaway_api::ErrorBody>(&text)
                .map(|b| b.error.message)
                .unwrap_or_else(|_| format!("HTTP {status}"));
            return Err(Error::Pairing(message));
        }
        let reply: PairResponse = resp.json().await.map_err(|e| Error::Decode(e.to_string()))?;
        verify(payload, &reply, &nonce)?;
        // Put the address that answered first.
        let mut addresses = payload.addresses.clone();
        addresses.retain(|a| a != addr);
        addresses.insert(0, addr.clone());
        return Ok(Paired {
            machine_id: reply.machine_id,
            machine_name: reply.machine_name,
            address: addr.clone(),
            addresses,
            device_id: reply.device_id,
            token: reply.token,
            permissions: reply.permissions,
            public_key: reply.public_key,
        });
    }
    Err(Error::Unreachable(last))
}

fn verify(payload: &PairingPayload, reply: &PairResponse, nonce: &str) -> Result<()> {
    let key_bytes = STANDARD.decode(&reply.public_key).map_err(|_| Error::Pairing("clé publique invalide".into()))?;
    if fingerprint(&key_bytes) != payload.fingerprint {
        return Err(Error::Pairing("empreinte différente de celle du lien : machine non vérifiée".into()));
    }
    if reply.machine_id != payload.machine_id {
        return Err(Error::Pairing("identifiant de machine inattendu".into()));
    }
    let key_bytes: [u8; 32] = key_bytes.try_into().map_err(|_| Error::Pairing("clé publique invalide".into()))?;
    let key = VerifyingKey::from_bytes(&key_bytes).map_err(|_| Error::Pairing("clé publique invalide".into()))?;
    let sig_bytes = STANDARD.decode(&reply.signature).map_err(|_| Error::Pairing("signature invalide".into()))?;
    let sig = Signature::from_slice(&sig_bytes).map_err(|_| Error::Pairing("signature invalide".into()))?;
    let message = pair_signed_message(nonce, &reply.machine_id, &reply.device_id);
    key.verify(message.as_bytes(), &sig).map_err(|_| Error::Pairing("signature de la machine invalide".into()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn payload() -> PairingPayload {
        PairingPayload {
            v: 1,
            machine_id: "m_x".into(),
            machine_name: "Mac".into(),
            addresses: vec!["100.1.2.3:7420".into()],
            pairing_code: "code".into(),
            fingerprint: "sha256:abc".into(),
        }
    }

    #[test]
    fn parses_links_json_and_base64() {
        let json = serde_json::to_string(&payload()).unwrap();
        let encoded = URL_SAFE_NO_PAD.encode(json.as_bytes());
        assert_eq!(parse(&format!("{PAIR_LINK_PREFIX}{encoded}")).unwrap(), payload());
        assert_eq!(parse(&json).unwrap(), payload());
        assert_eq!(parse(&format!("  {encoded}\n")).unwrap(), payload());
        assert!(parse("huntaway://pair/!!!").is_err());
    }

    #[test]
    fn verifies_signature_and_fingerprint() {
        use ed25519_dalek::{Signer, SigningKey};
        let key = SigningKey::from_bytes(&[7u8; 32]);
        let public = key.verifying_key().to_bytes();
        let mut p = payload();
        p.fingerprint = fingerprint(&public);
        let reply = PairResponse {
            device_id: "d_1".into(),
            token: "t".into(),
            permissions: vec![],
            machine_id: "m_x".into(),
            machine_name: "Mac".into(),
            public_key: STANDARD.encode(public),
            signature: STANDARD.encode(key.sign(pair_signed_message("n", "m_x", "d_1").as_bytes()).to_bytes()),
        };
        assert!(verify(&p, &reply, "n").is_ok());
        assert!(verify(&p, &reply, "other").is_err());
        let mut wrong = p.clone();
        wrong.fingerprint = "sha256:nope".into();
        assert!(verify(&wrong, &reply, "n").is_err());
    }
}
