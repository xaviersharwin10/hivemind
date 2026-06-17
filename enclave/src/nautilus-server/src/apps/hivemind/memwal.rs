// Copyright (c), HiveMind.
// SPDX-License-Identifier: Apache-2.0
//
// Minimal MemWal relayer client (server-mode) for the enclave.
//
// There is no Rust MemWal SDK, so we speak the relayer HTTP API directly,
// mirroring the TypeScript SDK's `signedRequest` exactly:
//
//   canonical message = "{ts}.{METHOD}.{path}.{sha256hex(body)}.{nonce}.{account_id}"
//   signed with the Ed25519 delegate key; sent as headers:
//   x-public-key, x-signature, x-timestamp, x-nonce, x-account-id
//
// In server-mode the relayer (itself a TEE) handles embedding + Seal + Walrus
// and returns already-decrypted `text`, so recall needs no OpenAI key and no
// client-side Seal. The delegate key is used purely to authenticate the request.

use fastcrypto::ed25519::{Ed25519KeyPair, Ed25519PrivateKey};
use fastcrypto::encoding::{Encoding, Hex};
use fastcrypto::hash::{HashFunction, Sha256};
use fastcrypto::traits::{KeyPair, Signer, ToFromBytes};
use serde::{Deserialize, Serialize};

/// Enclave-held MemWal credentials. In production these are provisioned to the
/// enclave as a Seal secret; for local debugging they come from env vars.
pub struct MemwalConfig {
    pub server_url: String,
    pub account_id: String,
    /// 32-byte Ed25519 delegate private key, hex-encoded (no 0x).
    pub delegate_key_hex: String,
}

/// The packed-secret shape injected in production. AWS Nitro tooling (and the
/// Nautilus template) injects a single secret env var, so account_id + the
/// delegate key travel together as one JSON blob.
#[derive(Deserialize)]
struct MemwalSecret {
    account_id: String,
    delegate_key: String,
    #[serde(default)]
    server_url: Option<String>,
}

const DEFAULT_SERVER_URL: &str = "https://relayer-staging.memory.walrus.xyz";

impl MemwalConfig {
    /// Load credentials.
    ///
    /// Production (enclave): a single secret env var `HIVEMIND_MEMWAL_SECRET`
    /// holding JSON `{account_id, delegate_key, server_url?}` — this matches the
    /// Nautilus one-secret injection model (set `API_ENV_VAR_NAME`).
    ///
    /// Local debug: falls back to individual env vars.
    pub fn from_env() -> Result<Self, String> {
        if let Ok(raw) = std::env::var("HIVEMIND_MEMWAL_SECRET") {
            let s: MemwalSecret = serde_json::from_str(&raw)
                .map_err(|e| format!("HIVEMIND_MEMWAL_SECRET is not valid JSON: {e}"))?;
            return Ok(MemwalConfig {
                server_url: s.server_url.unwrap_or_else(|| DEFAULT_SERVER_URL.to_string()),
                account_id: s.account_id,
                delegate_key_hex: s.delegate_key,
            });
        }
        Ok(MemwalConfig {
            server_url: std::env::var("MEMWAL_SERVER_URL")
                .unwrap_or_else(|_| DEFAULT_SERVER_URL.to_string()),
            account_id: std::env::var("HIVEMIND_ACCOUNT_ID")
                .map_err(|_| "HIVEMIND_ACCOUNT_ID not set".to_string())?,
            delegate_key_hex: std::env::var("HIVEMIND_DELEGATE_KEY")
                .map_err(|_| "HIVEMIND_DELEGATE_KEY not set".to_string())?,
        })
    }
}

#[derive(Serialize)]
struct RecallBody<'a> {
    query: &'a str,
    limit: u32,
    namespace: &'a str,
}

/// One recalled memory as returned by the relayer.
#[derive(Deserialize, Debug, Clone)]
pub struct RecallMemory {
    #[serde(default)]
    pub blob_id: Option<String>,
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub distance: f64,
}

#[derive(Deserialize, Debug)]
pub struct RecallResult {
    #[serde(default)]
    pub results: Vec<RecallMemory>,
    #[serde(default)]
    pub total: u64,
}

/// Build the delegate keypair from the hex private key.
fn keypair(delegate_key_hex: &str) -> Result<Ed25519KeyPair, String> {
    let bytes = Hex::decode(delegate_key_hex).map_err(|e| format!("bad delegate key hex: {e}"))?;
    let sk = Ed25519PrivateKey::from_bytes(&bytes).map_err(|e| format!("bad delegate key: {e}"))?;
    Ok(Ed25519KeyPair::from(sk))
}

/// Server-mode recall: POST /api/recall with a delegate-signed request.
pub async fn recall(
    cfg: &MemwalConfig,
    namespace: &str,
    query: &str,
    limit: u32,
) -> Result<RecallResult, String> {
    let path = "/api/recall";
    let body = RecallBody {
        query,
        limit,
        namespace,
    };
    // The exact bytes we hash MUST be the exact bytes we send.
    let body_str = serde_json::to_string(&body).map_err(|e| format!("serialize body: {e}"))?;
    let body_sha256 = Hex::encode(Sha256::digest(body_str.as_bytes()).digest);

    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| format!("clock: {e}"))?
        .as_secs()
        .to_string();
    let nonce = uuid::Uuid::new_v4().to_string();

    let message = format!(
        "{}.{}.{}.{}.{}.{}",
        timestamp, "POST", path, body_sha256, nonce, cfg.account_id
    );

    let kp = keypair(&cfg.delegate_key_hex)?;
    let signature = kp.sign(message.as_bytes());
    let pub_hex = Hex::encode(kp.public().as_bytes());
    let sig_hex = Hex::encode(signature.as_bytes());

    let url = format!("{}{}", cfg.server_url.trim_end_matches('/'), path);
    let client = reqwest::Client::new();
    let resp = client
        .post(&url)
        .header("Content-Type", "application/json")
        .header("x-public-key", pub_hex)
        .header("x-signature", sig_hex)
        .header("x-timestamp", &timestamp)
        .header("x-nonce", &nonce)
        .header("x-account-id", &cfg.account_id)
        .body(body_str)
        .send()
        .await
        .map_err(|e| format!("request failed: {e}"))?;

    let status = resp.status();
    let text = resp
        .text()
        .await
        .map_err(|e| format!("read body: {e}"))?;
    if !status.is_success() {
        return Err(format!("recall failed ({status}): {text}"));
    }
    serde_json::from_str(&text).map_err(|e| format!("parse response: {e} — body: {text}"))
}
