/**
 * Flow 1 (real) — zkLogin/Enoki per-group onboarding, framework-agnostic.
 *
 * The group creator owns the account (Option B): they sign with their Enoki zkLogin
 * wallet; gas is sponsored by the MemWal relayer (`/sponsor` + `/sponsor/execute`),
 * so no faucet/funding is needed. Two transactions, both sponsored + owner-signed:
 *   1. create_account(registry, clock)
 *   2. add_delegate_key(account, botPubkey, botAddr, label, clock)
 *
 * This module holds the logic; the browser UI supplies `sender` + `signTransaction`
 * (from @mysten/dapp-kit). Nothing here imports React or a wallet, so it type-checks
 * and unit-tests without a browser.
 */

import { Transaction } from "@mysten/sui/transactions";
import { blake2b } from "@noble/hashes/blake2.js";
import { MEMWAL, type SuiNetwork } from "./constants";
import type { SuiClient } from "./sui";

const SUI_CLOCK = "0x0000000000000000000000000000000000000000000000000000000000000006";

/** Browser-supplied signer (dapp-kit `useSignTransaction().mutateAsync`). */
export type SignTransaction = (args: { transaction: Transaction }) => Promise<{ signature: string }>;

export interface SponsorCtx {
  suiClient: SuiClient;
  relayerUrl: string;
  sender: string; // creator's zkLogin address
  signTransaction: SignTransaction;
}

function toBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== "undefined") return Buffer.from(bytes).toString("base64");
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Sui address derived from an Ed25519 public key (flag 0x00 || pubkey, blake2b-256). */
export function addressFromEd25519PublicKey(pubkey: Uint8Array): string {
  const input = new Uint8Array(33);
  input[0] = 0x00;
  input.set(pubkey, 1);
  return "0x" + bytesToHex(blake2b(input, { dkLen: 32 }));
}

/**
 * Sponsor → sign → execute a transaction through the relayer's gas station.
 * Returns the tx digest.
 */
export async function sponsoredExecute(ctx: SponsorCtx, tx: Transaction): Promise<string> {
  const kindBytes = await tx.build({ client: ctx.suiClient as never, onlyTransactionKind: true });

  const sponsorRes = await fetch(`${ctx.relayerUrl}/sponsor`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ transactionBlockKindBytes: toBase64(kindBytes), sender: ctx.sender }),
  });
  if (!sponsorRes.ok) throw new Error(`Sponsor failed (${sponsorRes.status}): ${await sponsorRes.text()}`);
  const sponsored = (await sponsorRes.json()) as { bytes: string; digest: string };

  const { signature } = await ctx.signTransaction({ transaction: Transaction.from(sponsored.bytes) });

  const execRes = await fetch(`${ctx.relayerUrl}/sponsor/execute`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ digest: sponsored.digest, signature }),
  });
  if (!execRes.ok) throw new Error(`Sponsored execute failed (${execRes.status}): ${await execRes.text()}`);
  const { digest } = (await execRes.json()) as { digest: string };
  return digest;
}

/**
 * Look up an existing MemWalAccount for an owner via the registry's
 * `accounts: Table<address, ID>`. Returns the account id, or null if none.
 * Lets onboarding be idempotent: each Sui address can own only ONE account, so a
 * creator who already onboarded (or whose earlier attempt half-succeeded) reuses it.
 */
export async function findExistingAccount(
  suiClient: SuiClient,
  registryId: string,
  owner: string,
): Promise<string | null> {
  try {
    const reg = await suiClient.getObject({ id: registryId, options: { showContent: true } });
    const content = (reg as { data?: { content?: { fields?: Record<string, unknown> } } }).data?.content;
    const tableId = (content?.fields?.accounts as { fields?: { id?: { id?: string } } })?.fields?.id?.id;
    if (!tableId) return null;
    const field = await suiClient.getDynamicFieldObject({
      parentId: tableId,
      name: { type: "address", value: owner },
    });
    const value = ((field as { data?: { content?: { fields?: { value?: string } } } }).data?.content?.fields?.value);
    return value ?? null;
  } catch {
    return null;
  }
}

/** Read the created MemWalAccount object id from a create_account tx. */
async function accountIdFromDigest(suiClient: SuiClient, digest: string): Promise<string> {
  const tx = await suiClient.waitForTransaction({ digest, options: { showObjectChanges: true, showEffects: true } });
  const changes = (tx as { objectChanges?: Array<{ type: string; objectType?: string; objectId?: string }> }).objectChanges ?? [];
  for (const c of changes) {
    if (c.type === "created" && c.objectType?.includes("::account::MemWalAccount") && c.objectId) {
      return c.objectId;
    }
  }
  throw new Error(`create_account tx ${digest} did not yield a MemWalAccount object`);
}

export interface OnboardResult {
  accountId: string;
  ownerAddress: string;
  botDelegate: { privateKey: string; publicKey: Uint8Array; suiAddress: string };
  createDigest: string;
  addDelegateDigest: string;
}

/**
 * Run the full sponsored onboarding for a group.
 * `botDelegate` is generated by the caller (so the bot's private key is produced in
 * the same trusted context that will persist it) via `generateDelegateKey()`.
 */
export async function onboardGroupSponsored(opts: {
  ctx: SponsorCtx;
  network: SuiNetwork;
  botDelegate: { privateKey: string; publicKey: Uint8Array; suiAddress: string };
  botLabel?: string;
}): Promise<OnboardResult> {
  const { packageId, registryId } = MEMWAL[opts.network];
  const { ctx } = opts;

  // 1. create_account — but reuse an existing account if this owner already has one
  //    (one address = one MemWalAccount; re-creating aborts with EAccountAlreadyExists).
  let accountId = await findExistingAccount(ctx.suiClient, registryId, ctx.sender);
  let createDigest = "reused-existing-account";
  if (!accountId) {
    const createTx = new Transaction();
    createTx.moveCall({
      target: `${packageId}::account::create_account`,
      arguments: [createTx.object(registryId), createTx.object(SUI_CLOCK)],
    });
    createDigest = await sponsoredExecute(ctx, createTx);
    accountId = await accountIdFromDigest(ctx.suiClient, createDigest);
  }

  // 2. add_delegate_key(bot)
  const addDelegateDigest = await addDelegateKeySponsored({
    ctx,
    network: opts.network,
    accountId,
    publicKey: opts.botDelegate.publicKey,
    label: opts.botLabel ?? "hivemind-bot",
  });

  return {
    accountId,
    ownerAddress: ctx.sender,
    botDelegate: opts.botDelegate,
    createDigest,
    addDelegateDigest,
  };
}

/**
 * Sponsored `add_delegate_key` — signed by the account OWNER (creator's zkLogin).
 * Used by Flow 3: the owner approves adding a member's delegate key. The on-chain
 * owner check is the security boundary (a non-owner signature aborts with ENotOwner).
 */
export async function addDelegateKeySponsored(opts: {
  ctx: SponsorCtx;
  network: SuiNetwork;
  accountId: string;
  publicKey: Uint8Array;
  label: string;
}): Promise<string> {
  const { packageId } = MEMWAL[opts.network];
  const pk = opts.publicKey;
  if (pk.length !== 32) throw new Error(`public key must be 32 bytes, got ${pk.length}`);
  const tx = new Transaction();
  tx.moveCall({
    target: `${packageId}::account::add_delegate_key`,
    arguments: [
      tx.object(opts.accountId),
      tx.pure("vector<u8>", Array.from(pk)),
      tx.pure("address", addressFromEd25519PublicKey(pk)),
      tx.pure("string", opts.label),
      tx.object(SUI_CLOCK),
    ],
  });
  return sponsoredExecute(opts.ctx, tx);
}
