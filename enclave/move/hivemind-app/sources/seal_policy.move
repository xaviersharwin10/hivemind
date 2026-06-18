// Copyright (c), HiveMind.
// SPDX-License-Identifier: Apache-2.0
//
// Seal access policy that lets ONLY the registered, attested HiveMind enclave
// decrypt the enclave delegate key. The Seal key servers dev-inspect this
// `seal_approve` before releasing shares; it passes only when the request is
// signed by the ephemeral key of the on-chain-registered `Enclave<HIVEMIND>`.
// That is what makes "not even us" true: the operator can hold the ciphertext but
// can never decrypt it outside the attested enclave.
//
// Adapted from the Nautilus seal-policy example, specialized to `Enclave<HIVEMIND>`.
module app::seal_policy {
    use enclave::enclave::{Enclave, create_intent_message};
    use app::hivemind::HIVEMIND;
    use sui::{bcs, ed25519, hash::blake2b256};

    const ENoAccess: u64 = 0;
    const WalletPKIntent: u8 = 1;

    /// Signing payload struct signed by the enclave keypair (matches the Rust
    /// `WalletPK` in apps/hivemind/seal.rs).
    public struct WalletPK has drop {
        pk: vector<u8>,
    }

    /// Approves a Seal key fetch iff:
    ///  1) the Seal id is vector[0] (single bootstrap secret),
    ///  2) the tx sender is the wallet derived from `wallet_pk`, and
    ///  3) the signature over the WalletPK intent verifies against the enclave's
    ///     registered ephemeral pubkey — i.e. the request came from THIS attested enclave.
    entry fun seal_approve(
        id: vector<u8>,
        signature: vector<u8>,
        wallet_pk: vector<u8>,
        timestamp: u64,
        enclave: &Enclave<HIVEMIND>,
        ctx: &TxContext,
    ) {
        assert!(id == vector[0u8], ENoAccess);
        assert!(ctx.sender().to_bytes() == pk_to_address(&wallet_pk), ENoAccess);

        let signing_payload = create_intent_message(
            WalletPKIntent,
            timestamp,
            WalletPK { pk: wallet_pk },
        );
        let payload = bcs::to_bytes(&signing_payload);
        assert!(ed25519::ed25519_verify(&signature, enclave.pk(), &payload), ENoAccess);
    }

    /// Sui address derived from an ed25519 pubkey: blake2b256(flag(0x00) || pk).
    fun pk_to_address(pk: &vector<u8>): vector<u8> {
        let mut arr = vector[0u8];
        arr.append(*pk);
        blake2b256(&arr)
    }
}
