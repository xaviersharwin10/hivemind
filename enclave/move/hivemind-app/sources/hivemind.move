// Copyright (c), HiveMind.
// SPDX-License-Identifier: Apache-2.0
//
// On-chain half of the HiveMind confidential MCP.
//
// Registers the HiveMind enclave on Sui (its PCRs + ephemeral public key, via
// the Nautilus `enclave` framework) and verifies that a recall response was
// produced by *that attested enclave* — not by some arbitrary server. The
// RecallResponse / RecallHit structs MUST mirror the Rust enclave app's BCS
// layout (apps/hivemind), or signature verification will fail.
module app::hivemind {
    use enclave::enclave::{Self, Enclave};
    use std::string::String;

    /// Intent scope for recall responses. Must match `IntentScope::Recall` in Rust.
    const RECALL_INTENT: u8 = 0;
    const EInvalidSignature: u64 = 1;
    const EMismatchedHits: u64 = 2;

    /// Mirrors `RecallHit` in the Rust enclave app (BCS: String, then u16).
    public struct RecallHit has copy, drop {
        text: String,
        relevance_bps: u16,
    }

    /// Mirrors `RecallResponse` — the inner T of IntentMessage<T> in Rust.
    public struct RecallResponse has copy, drop {
        namespace: String,
        hits: vector<RecallHit>,
    }

    /// One-time witness identifying this enclave application.
    public struct HIVEMIND has drop {}

    fun init(otw: HIVEMIND, ctx: &mut TxContext) {
        let cap = enclave::new_cap(otw, ctx);

        // PCR placeholders; replaced with the real enclave measurements via
        // `update_pcrs` once the enclave image is built (see UsingNautilus.md).
        cap.create_enclave_config(
            b"hivemind enclave".to_string(),
            x"000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000", // pcr0
            x"000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000", // pcr1
            x"000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000", // pcr2
            ctx,
        );

        transfer::public_transfer(cap, ctx.sender())
    }

    /// Verify that a recall result was produced by the attested HiveMind enclave.
    /// Hits are passed as parallel vectors (text + relevance) so the response can
    /// be reconstructed and checked against the enclave's signature.
    public fun verify_recall<T>(
        namespace: String,
        hits_text: vector<String>,
        hits_relevance_bps: vector<u16>,
        timestamp_ms: u64,
        sig: &vector<u8>,
        enclave: &Enclave<T>,
    ): bool {
        let n = hits_text.length();
        assert!(n == hits_relevance_bps.length(), EMismatchedHits);

        let mut hits = vector<RecallHit>[];
        let mut i = 0;
        while (i < n) {
            hits.push_back(RecallHit {
                text: hits_text[i],
                relevance_bps: hits_relevance_bps[i],
            });
            i = i + 1;
        };

        let ok = enclave.verify_signature(
            RECALL_INTENT,
            timestamp_ms,
            RecallResponse { namespace, hits },
            sig,
        );
        assert!(ok, EInvalidSignature);
        ok
    }
}
