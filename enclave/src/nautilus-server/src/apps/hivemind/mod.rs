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

use crate::common::IntentMessage;
use crate::common::{to_signed_response, ProcessDataRequest, ProcessedDataResponse};
use crate::AppState;
use crate::EnclaveError;
use axum::extract::State;
use axum::Json;
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
#[derive(Debug, Serialize, Deserialize)]
pub struct RecallRequest {
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
    let _limit = payload.limit.unwrap_or(5);

    // TODO(next todos): query MemWal for `namespace`/`query`, Seal-decrypt the
    // matched artifacts using the enclave-held delegate key, extract text.
    let hits = vec![RecallHit {
        text: format!(
            "(scaffold) recall for query {:?} in namespace {:?} — MemWal + Seal decrypt wired next",
            payload.query, payload.namespace
        ),
        relevance_bps: 0,
    }];

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
