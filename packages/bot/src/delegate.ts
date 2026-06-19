/**
 * Deterministic bot-delegate keys.
 *
 * The bot's per-group delegate key is derived from a single secret master seed
 * plus the (stable) group id — never randomly generated or stored. That means the
 * bot can reconstruct any group's delegate key from the on-chain registry alone
 * (chat → account/namespace/writer), so a redeploy/restart never loses state and
 * never needs a re-/setup. The on-chain `writer` is exactly this derived address.
 *
 * Node-only (uses node:crypto); the onboarding SPA fetches the derived public key
 * from the bot backend rather than importing this.
 */
import { createHmac } from "node:crypto";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";

export interface DerivedDelegate {
  /** 32-byte ed25519 seed, hex — the format makeMemwal/the enclave expect. */
  privateKey: string;
  publicKey: Uint8Array;
  publicKeyHex: string;
  suiAddress: string;
}

/** Derive a stable ed25519 delegate for `groupId` from the master seed. */
export function deriveBotDelegate(masterSeed: string, groupId: string): DerivedDelegate {
  const seed = createHmac("sha256", masterSeed)
    .update(`hivemind-bot-delegate:${groupId}`)
    .digest(); // 32 bytes
  const kp = Ed25519Keypair.fromSecretKey(new Uint8Array(seed));
  const publicKey = kp.getPublicKey().toRawBytes();
  return {
    privateKey: seed.toString("hex"),
    publicKey,
    publicKeyHex: Buffer.from(publicKey).toString("hex"),
    suiAddress: kp.getPublicKey().toSuiAddress(),
  };
}
