/**
 * Seal — threshold encryption for HiveMind artifacts.
 *
 * Files dropped in a group are encrypted with Seal *before* they touch Walrus, so
 * the public Walrus aggregator only ever holds ciphertext. Decryption is gated by
 * the group's own `MemWalAccount::seal_approve` policy — the same on-chain access
 * control that protects MemWal memories — so exactly the keys that can read the
 * group's memory (the owner + delegates) can read its files. No extra contract.
 *
 * Policy / id layout (mirrors MemWal Manual mode so artifacts and memories share
 * one access model):
 *
 *   id = hex(utf8(namespace)) || hex(ownerAddress[2:])
 *
 *   - namespace prefix  → distinct Seal keys per namespace (isolation).
 *   - owner-address suffix → satisfies seal_approve's owner branch
 *     `has_suffix(id, bcs::to_bytes(owner))`. The delegate branch (used by the
 *     hivemind-read MCP) ignores the suffix and instead checks the caller's Sui
 *     address against the account's delegate list, so a delegate key decrypts too.
 *
 * Key servers + threshold are the testnet/mainnet open-mode set MemWal uses, so
 * we stay decrypt-compatible with anything the MemWal relayer wrote.
 */

import { SealClient, SessionKey, EncryptedObject } from "@mysten/seal";
import { Transaction } from "@mysten/sui/transactions";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { MEMWAL, type SuiNetwork } from "./constants";
import type { SuiClient } from "./sui";

/** Open-mode Seal key servers, per network (same set MemWal Manual mode defaults to). */
export const SEAL_KEY_SERVERS: Record<SuiNetwork, { objectId: string; weight: number }[]> = {
  testnet: [
    { objectId: "0x73d05d62c18d9374e3ea529e8e0ed6161da1a141a94d3f76ae3fe4e99356db75", weight: 1 },
    { objectId: "0xf5d14a81a982144ae441cd7d64b09027f116a468bd36e7eca494f750591623c8", weight: 1 },
  ],
  mainnet: [
    { objectId: "0x145540d931f182fef76467dd8074c9839aea126852d90d18e1556fcbbd1208b6", weight: 1 }, // Overclock (Open)
    { objectId: "0xe0eb52eba9261b96e895bbb4deca10dcd64fbc626a1133017adcd5131353fd10", weight: 1 }, // Studio Mirai (Open)
  ],
};

/** Number of key servers that must return a share to decrypt. */
export const SEAL_THRESHOLD = 2;

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Build the namespace-scoped, owner-suffixed Seal identity for an artifact. */
export function artifactSealId(namespace: string, ownerAddress: string): string {
  const nsHex = bytesToHex(new TextEncoder().encode(namespace));
  const ownerHex = ownerAddress.startsWith("0x") ? ownerAddress.slice(2) : ownerAddress;
  return `${nsHex}${ownerHex}`;
}

function makeSealClient(suiClient: SuiClient, network: SuiNetwork): SealClient {
  return new SealClient({
    // SuiJsonRpcClient exposes `.core` (a CoreClient), satisfying SealCompatibleClient.
    suiClient: suiClient as unknown as ConstructorParameters<typeof SealClient>[0]["suiClient"],
    serverConfigs: SEAL_KEY_SERVERS[network],
    verifyKeyServers: true,
  });
}

/**
 * True if `data` is a Seal EncryptedObject (vs. a legacy plaintext blob). Lets the
 * reader stay backward-compatible with artifacts uploaded before Seal landed.
 */
export function isSealEncrypted(data: Uint8Array): boolean {
  try {
    EncryptedObject.parse(data);
    return true;
  } catch {
    return false;
  }
}

export interface EncryptArtifactOpts {
  suiClient: SuiClient;
  network: SuiNetwork;
  namespace: string;
  ownerAddress: string;
  data: Uint8Array;
}

/** Seal-encrypt artifact bytes. Returns the BCS-encoded EncryptedObject to store on Walrus. */
export async function encryptArtifact(opts: EncryptArtifactOpts): Promise<Uint8Array> {
  const seal = makeSealClient(opts.suiClient, opts.network);
  const { encryptedObject } = await seal.encrypt({
    threshold: SEAL_THRESHOLD,
    packageId: MEMWAL[opts.network].packageId,
    id: artifactSealId(opts.namespace, opts.ownerAddress),
    data: opts.data,
  });
  return new Uint8Array(encryptedObject);
}

export interface DecryptArtifactOpts {
  suiClient: SuiClient;
  network: SuiNetwork;
  /** Delegate (or owner) Ed25519 private key, hex — signs the Seal session + seal_approve. */
  delegateKey: string;
  /** The group's MemWalAccount object id (the seal_approve policy object). */
  accountId: string;
  /** The ciphertext (a Seal EncryptedObject) read back from Walrus. */
  data: Uint8Array;
}

/**
 * Decrypt a Seal-encrypted artifact via the group's `seal_approve` policy.
 *
 * The delegate key is used as a Sui keypair: its address is what the account's
 * delegate list authorizes, and it signs the Seal SessionKey. We build a
 * `seal_approve(id, account)` PTB; the key servers dev-inspect it with that
 * address as sender, release shares when the policy passes, and we combine them
 * locally to recover the plaintext. The plaintext never leaves this process.
 */
export async function decryptArtifact(opts: DecryptArtifactOpts): Promise<Uint8Array> {
  const packageId = MEMWAL[opts.network].packageId;
  const keypair = Ed25519Keypair.fromSecretKey(hexToBytes(opts.delegateKey));
  const address = keypair.getPublicKey().toSuiAddress();

  const parsed = EncryptedObject.parse(opts.data);
  const fullId = parsed.id; // hex string, no 0x

  // PTB that calls the group's on-chain access policy. onlyTransactionKind so the
  // key servers can dev-inspect it without a gas object.
  const tx = new Transaction();
  tx.moveCall({
    target: `${packageId}::account::seal_approve`,
    arguments: [tx.pure("vector<u8>", Array.from(hexToBytes(fullId))), tx.object(opts.accountId)],
  });
  const txBytes = await tx.build({ client: opts.suiClient as any, onlyTransactionKind: true });

  const seal = makeSealClient(opts.suiClient, opts.network);
  const sessionKey = await SessionKey.create({
    address,
    packageId,
    ttlMin: 5,
    signer: keypair,
    suiClient: opts.suiClient as unknown as Parameters<typeof SessionKey.create>[0]["suiClient"],
  });

  await seal.fetchKeys({ ids: [fullId], txBytes, sessionKey, threshold: SEAL_THRESHOLD });
  return seal.decrypt({ data: opts.data, sessionKey, txBytes });
}
