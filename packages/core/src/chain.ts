/**
 * HiveMind on-chain registry — TypeScript client for our own Move package
 * (`hivemind::registry`, see packages/contracts/hivemind).
 *
 * This is the web3 spine: a group's link to its MemWal memory account and the
 * tamper-evident manifest of every shared file live on Sui, not in a backend JSON
 * file. Anyone can resolve a group from its chat id and verify a Walrus blob
 * against the SHA-256 the group committed on-chain.
 *
 * Transaction *builders* are kept separate from execution so the same calls work
 * two ways: owner-signed via zkLogin/Enoki sponsorship (onboarding), and
 * bot-delegate-signed via sponsorship (per-file artifact recording).
 */

import { Transaction } from "@mysten/sui/transactions";
import { sha256 } from "@noble/hashes/sha2.js";
import { HIVEMIND, SUI_CLOCK, type SuiNetwork } from "./constants";
import { sponsoredExecute, type SponsorCtx } from "./onboard";
import type { SuiClient } from "./sui";

/** SHA-256 of the exact bytes stored on Walrus — the on-chain integrity anchor. */
export function artifactHash(bytes: Uint8Array): Uint8Array {
  return sha256(bytes);
}

/** Build the `register_group` tx (signed by the group owner). */
export function buildRegisterGroupTx(opts: {
  network: SuiNetwork;
  chatId: string;
  memwalAccount: string;
  namespace: string;
  writer: string;
}): Transaction {
  const { packageId, registryId } = HIVEMIND[opts.network];
  const tx = new Transaction();
  tx.moveCall({
    target: `${packageId}::registry::register_group`,
    arguments: [
      tx.object(registryId),
      tx.pure.string(opts.chatId),
      tx.pure.id(opts.memwalAccount),
      tx.pure.string(opts.namespace),
      tx.pure.address(opts.writer),
      tx.object(SUI_CLOCK),
    ],
  });
  return tx;
}

/** Build the `record_artifact` tx (signed by the group's owner or writer). */
export function buildRecordArtifactTx(opts: {
  network: SuiNetwork;
  groupId: string;
  blobId: string;
  name: string;
  mime: string;
  sha256: Uint8Array;
  sealed: boolean;
}): Transaction {
  const { packageId } = HIVEMIND[opts.network];
  const tx = new Transaction();
  tx.moveCall({
    target: `${packageId}::registry::record_artifact`,
    arguments: [
      tx.object(opts.groupId),
      tx.pure.string(opts.blobId),
      tx.pure.string(opts.name),
      tx.pure.string(opts.mime),
      tx.pure.vector("u8", Array.from(opts.sha256)),
      tx.pure.bool(opts.sealed),
      tx.object(SUI_CLOCK),
    ],
  });
  return tx;
}

/**
 * Register a group on-chain via sponsorship (owner-signed at onboarding).
 * Idempotent: if the chat id is already registered, reuse that `Group`.
 */
export async function registerGroupSponsored(opts: {
  ctx: SponsorCtx;
  network: SuiNetwork;
  chatId: string;
  memwalAccount: string;
  namespace: string;
  writer: string;
}): Promise<{ groupId: string; digest: string; reused: boolean }> {
  const existing = await findGroupId(opts.ctx.suiClient, opts.network, opts.chatId);
  if (existing) return { groupId: existing, digest: "reused-existing-group", reused: true };
  const tx = buildRegisterGroupTx({
    network: opts.network,
    chatId: opts.chatId,
    memwalAccount: opts.memwalAccount,
    namespace: opts.namespace,
    writer: opts.writer,
  });
  const digest = await sponsoredExecute(opts.ctx, tx);
  const groupId = await groupIdFromDigest(opts.ctx.suiClient, digest);
  return { groupId, digest, reused: false };
}

/** Move call targets to allow in an Enoki sponsorship policy for this package. */
export function hivemindMoveTargets(network: SuiNetwork): string[] {
  const { packageId } = HIVEMIND[network];
  return [`${packageId}::registry::register_group`, `${packageId}::registry::record_artifact`];
}

/** Read the `Group` object id created by a `register_group` transaction. */
export async function groupIdFromDigest(suiClient: SuiClient, digest: string): Promise<string> {
  const tx = await suiClient.waitForTransaction({ digest, options: { showObjectChanges: true } });
  const changes = (tx as { objectChanges?: Array<{ type: string; objectType?: string; objectId?: string }> }).objectChanges ?? [];
  for (const c of changes) {
    if (c.type === "created" && c.objectType?.endsWith("::registry::Group") && c.objectId) return c.objectId;
  }
  throw new Error(`register_group tx ${digest} did not create a Group object`);
}

/** Resolve a group's on-chain `Group` object id from its chat id, or null. */
export async function findGroupId(suiClient: SuiClient, network: SuiNetwork, chatId: string): Promise<string | null> {
  const { registryId } = HIVEMIND[network];
  try {
    const reg = await suiClient.getObject({ id: registryId, options: { showContent: true } });
    const content = (reg as { data?: { content?: { fields?: Record<string, unknown> } } }).data?.content;
    const tableId = (content?.fields?.groups as { fields?: { id?: { id?: string } } })?.fields?.id?.id;
    if (!tableId) return null;
    const field = await suiClient.getDynamicFieldObject({
      parentId: tableId,
      name: { type: "0x1::string::String", value: chatId },
    });
    const value = (field as { data?: { content?: { fields?: { value?: string } } } }).data?.content?.fields?.value;
    return value ?? null;
  } catch {
    return null;
  }
}

export interface OnChainGroup {
  groupId: string;
  owner: string;
  writer: string;
  memwalAccount: string;
  namespace: string;
}

/**
 * Read a group's canonical state from our on-chain registry (the source of truth
 * for the chat→account mapping). Returns null if the chat isn't registered.
 */
export async function readGroup(
  suiClient: SuiClient,
  network: SuiNetwork,
  chatId: string,
): Promise<OnChainGroup | null> {
  const groupId = await findGroupId(suiClient, network, chatId);
  if (!groupId) return null;
  const obj = await suiClient.getObject({ id: groupId, options: { showContent: true } });
  const f = (obj as { data?: { content?: { fields?: Record<string, unknown> } } }).data?.content?.fields;
  if (!f) return null;
  const acct = f.memwal_account;
  return {
    groupId,
    owner: String(f.owner),
    writer: String(f.writer),
    memwalAccount: typeof acct === "string" ? acct : String((acct as { id?: string })?.id ?? acct),
    namespace: String(f.namespace),
  };
}

export interface OnChainArtifact {
  blobId: string;
  name: string;
  mime: string;
  /** SHA-256 of the stored bytes, hex. */
  sha256: string;
  sealed: boolean;
  addedBy: string;
  addedAtMs: number;
}

/** Read a group's on-chain artifact manifest. */
export async function readGroupArtifacts(suiClient: SuiClient, groupId: string): Promise<OnChainArtifact[]> {
  const obj = await suiClient.getObject({ id: groupId, options: { showContent: true } });
  const fields = (obj as { data?: { content?: { fields?: Record<string, unknown> } } }).data?.content?.fields;
  const raw = (fields?.artifacts as Array<{ fields?: Record<string, unknown> }>) ?? [];
  return raw.map((a) => {
    const f = a.fields ?? {};
    const bytes = (f.sha256 as number[] | undefined) ?? [];
    return {
      blobId: String(f.blob_id ?? ""),
      name: String(f.name ?? ""),
      mime: String(f.mime ?? ""),
      sha256: bytes.map((b) => b.toString(16).padStart(2, "0")).join(""),
      sealed: Boolean(f.sealed),
      addedBy: String(f.added_by ?? ""),
      addedAtMs: Number(f.added_at_ms ?? 0),
    };
  });
}
