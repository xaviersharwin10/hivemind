// Copyright (c), HiveMind.
// SPDX-License-Identifier: Apache-2.0
//
// HiveMind enclave app — confidential, attested recall over a group's MemWal memory.
//
// This is the in-enclave half of the remote MCP. The enclave holds the group
// delegate key (provisioned as a Seal secret to this enclave's PCRs), queries
// MemWal, Seal-decrypts the group's artifacts, and returns an ATTESTED response
// signed by the enclave ephemeral key. The operator can never read the key or
// the plaintext — that is the whole point of running it here instead of on a
// plain server.
//
// SCAFFOLD STAGE: `process_data` returns a signed stub so the app slot,
// signing, and attestation wiring are proven end-to-end. The MemWal query and
// Seal decryption are layered in next (see todo list).

mod memwal;

use crate::common::IntentMessage;
use crate::common::{to_signed_response, ProcessDataRequest, ProcessedDataResponse};
use crate::AppState;
use crate::EnclaveError;
use axum::extract::State;
use axum::Json;
use memwal::MemwalConfig;
use serde::{Deserialize, Serialize};
use serde_repr::{Deserialize_repr, Serialize_repr};
use std::sync::Arc;

/// Intent scope for each kind of signed response this app produces.
#[derive(Serialize_repr, Deserialize_repr, Debug)]
#[repr(u8)]
pub enum IntentScope {
    Recall = 0,
}

/// Inner type T for ProcessDataRequest<T> — a recall query against one group.
///
/// `account_id` + `namespace` identify the target group and are supplied by the
/// remote MCP from the *verified caller identity* (Stytch trusted_metadata), never
/// from untrusted user input — that's what enforces per-user group isolation. The
/// enclave's stable delegate key must be authorized on `account_id`.
#[derive(Debug, Serialize, Deserialize)]
pub struct RecallRequest {
    /// The group's MemWalAccount object id.
    pub account_id: String,
    /// The group's MemWal namespace (the Telegram chat id).
    pub namespace: String,
    /// What to look for, in plain language.
    pub query: String,
    /// Max results (defaults to 5 when omitted).
    #[serde(default)]
    pub limit: Option<u32>,
}

/// One recalled memory/artifact reference.
///
/// Note: the response is BCS-serialized for signing (and on-chain verification),
/// and BCS has no float type — so relevance is carried as integer basis points
/// (0..=10000), not f64.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct RecallHit {
    pub text: String,
    pub relevance_bps: u16,
}

/// Inner type T for IntentMessage<T> — the signed recall result.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct RecallResponse {
    pub namespace: String,
    pub hits: Vec<RecallHit>,
}

/// POST /process_data — attested recall.
pub async fn process_data(
    State(state): State<Arc<AppState>>,
    Json(request): Json<ProcessDataRequest<RecallRequest>>,
) -> Result<Json<ProcessedDataResponse<IntentMessage<RecallResponse>>>, EnclaveError> {
    let payload = request.payload;
    let limit = payload.limit.unwrap_or(5);

    // The enclave's stable delegate credentials (env for the local debug loop;
    // Seal-provisioned in production). Server-mode recall returns already-decrypted
    // text. The target group is `payload.account_id`, set from the verified caller.
    let cfg = MemwalConfig::from_env().map_err(EnclaveError::GenericError)?;
    let result = memwal::recall(
        &cfg,
        &payload.account_id,
        &payload.namespace,
        &payload.query,
        limit,
    )
    .await
    .map_err(|e| EnclaveError::GenericError(format!("recall failed: {e}")))?;

    let hits = result
        .results
        .into_iter()
        .map(|m| {
            // distance (0=identical) → relevance basis points (10000=identical).
            let relevance = (1.0 - m.distance).clamp(0.0, 1.0);
            RecallHit {
                text: m.text,
                relevance_bps: (relevance * 10000.0) as u16,
            }
        })
        .collect();

    let timestamp_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| EnclaveError::GenericError(format!("Failed to read clock: {e}")))?
        .as_millis() as u64;

    Ok(Json(to_signed_response(
        &state.eph_kp,
        RecallResponse {
            namespace: payload.namespace,
            hits,
        },
        timestamp_ms,
        IntentScope::Recall as u8,
    )))
}
