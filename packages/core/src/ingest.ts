/**
 * Flow 2 — ingestion pipeline. Turns chat events into durable group memory.
 *
 *   file  → Walrus blob + a MemWal memory that references it
 *   text  → MemWal memory (a distilled fact, or LLM-extracted facts via analyze)
 *
 * Transport-agnostic: the Telegram bot (or any future channel) calls these with
 * already-downloaded bytes / plain text, so the pipeline is testable without a bot.
 */

import { makeMemwal } from "./memwal";
import { uploadBlob } from "./walrus";
import { encryptArtifact } from "./seal";
import { artifactHash } from "./chain";
import { extractText, excerptOf } from "./extract";
import { makeSuiClient } from "./sui";
import type { GroupRecord } from "./registry";
import type { SuiNetwork } from "./constants";

export interface IngestCtx {
  record: Pick<GroupRecord, "botDelegateKey" | "accountId" | "namespace" | "ownerAddress">;
  network?: SuiNetwork;
  serverUrl?: string;
}

/** Marker embedded in artifact memories so a reader (hivemind-read) can recover the blob id.
 *  An optional content `excerpt` makes the file's *contents* semantically searchable. */
export function artifactMemoryText(a: {
  filename: string;
  mime: string;
  blobId: string;
  caption?: string;
  excerpt?: string;
}): string {
  const cap = a.caption?.trim() ? ` Caption: "${a.caption.trim()}".` : "";
  const body = a.excerpt ? ` Contents: ${a.excerpt}` : "";
  return `Artifact "${a.filename}" (${a.mime}) was shared in the group.${cap}${body} ` +
    `[walrus_blob=${a.blobId} name=${a.filename} type=${a.mime} enc=seal]`;
}

export interface IngestedFile {
  blobId: string;
  alreadyCertified: boolean;
  memoryText: string;
  /** SHA-256 of the (encrypted) bytes stored on Walrus — the on-chain integrity anchor. */
  sha256: Uint8Array;
  /** Whether the stored bytes are Seal-encrypted. */
  sealed: boolean;
}

/** Upload a file to Walrus and record a referencing memory. */
export async function ingestFile(
  ctx: IngestCtx,
  file: { bytes: Uint8Array; filename: string; mime: string; caption?: string },
): Promise<IngestedFile> {
  // Seal-encrypt before the bytes ever touch Walrus — the public aggregator only
  // sees ciphertext; only the group's owner/delegate keys can unwrap it.
  const network = ctx.network ?? "testnet";
  const ciphertext = await encryptArtifact({
    suiClient: makeSuiClient(network),
    network,
    namespace: ctx.record.namespace,
    ownerAddress: ctx.record.ownerAddress,
    data: file.bytes,
  });
  const { blobId, alreadyCertified } = await uploadBlob(ciphertext);
  // Pull a content excerpt from the plaintext so the file's *contents* are
  // searchable in memory (not just its filename).
  const extracted = await extractText(file.bytes, file.mime);
  const excerpt = extracted.text ? excerptOf(extracted.text) : undefined;
  const memoryText = artifactMemoryText({ ...file, blobId, excerpt });

  const memwal = makeMemwal({ ...client(ctx) });
  await memwal.rememberAndWait(memoryText, ctx.record.namespace, { timeoutMs: 90_000 });

  return { blobId, alreadyCertified, memoryText, sha256: artifactHash(ciphertext), sealed: true };
}

/**
 * Ingest text.
 *  - mode "fact": store the text verbatim as one memory (use for explicit triggers).
 *  - mode "auto": run analyze() so the LLM extracts discrete facts (use for passive capture).
 */
export async function ingestText(
  ctx: IngestCtx,
  text: string,
  mode: "fact" | "auto" = "fact",
): Promise<{ facts: string[] }> {
  const memwal = makeMemwal({ ...client(ctx) });
  if (mode === "auto") {
    const r = await memwal.analyzeAndWait(text, ctx.record.namespace, { timeoutMs: 120_000 });
    return { facts: r.facts.map((f) => f.text) };
  }
  await memwal.rememberAndWait(text, ctx.record.namespace, { timeoutMs: 90_000 });
  return { facts: [text] };
}

function client(ctx: IngestCtx) {
  return {
    key: ctx.record.botDelegateKey,
    accountId: ctx.record.accountId,
    namespace: ctx.record.namespace,
    network: ctx.network,
    serverUrl: ctx.serverUrl,
  };
}
