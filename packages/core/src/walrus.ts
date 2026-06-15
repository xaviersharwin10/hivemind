/**
 * Walrus blob storage for artifacts (files dropped in chat).
 *
 * MemWal is text-only, so heavy files (PDFs, images, receipts) go to raw Walrus
 * and are referenced from a MemWal text memory by blob id. Uses the public
 * testnet publisher/aggregator HTTP API with fallbacks (endpoints flap).
 *
 * Bytes handed to `uploadBlob` are already Seal-encrypted by the ingestion layer
 * (see `seal.ts` / `ingest.ts`), so Walrus only ever holds ciphertext. This module
 * is deliberately encryption-agnostic — it just moves opaque blobs.
 */

const PUBLISHERS = [
  "https://wal-publisher-testnet.staketab.org",
  "https://publisher.walrus-testnet.walrus.space",
];

const AGGREGATORS = [
  "https://wal-aggregator-testnet.staketab.org",
  "https://aggregator.walrus-testnet.walrus.space",
];

export interface UploadedBlob {
  blobId: string;
  /** true if Walrus already had an identical blob certified. */
  alreadyCertified: boolean;
}

/** Upload bytes to Walrus, trying publishers in order. `epochs` = storage lifetime. */
export async function uploadBlob(bytes: Uint8Array, epochs = 5): Promise<UploadedBlob> {
  let lastErr = "";
  for (const base of PUBLISHERS) {
    try {
      const res = await fetch(`${base}/v1/blobs?epochs=${epochs}`, {
        method: "PUT",
        // value is the Uint8Array; typed as ArrayBuffer so it satisfies BodyInit under
        // both the Node and DOM libs (TS 5.7 Uint8Array generic vs fetch BodyInit).
        body: bytes as unknown as ArrayBuffer,
      });
      if (!res.ok) { lastErr = `${base} -> HTTP ${res.status}`; continue; }
      const j: any = await res.json();
      const blobId: string | undefined =
        j?.newlyCreated?.blobObject?.blobId ?? j?.alreadyCertified?.blobId;
      if (!blobId) { lastErr = `${base} -> no blobId in response`; continue; }
      return { blobId, alreadyCertified: Boolean(j?.alreadyCertified) };
    } catch (e) {
      lastErr = `${base} -> ${(e as Error).message}`;
    }
  }
  throw new Error(`Walrus upload failed. Last: ${lastErr}`);
}

/** Read a blob back from Walrus, trying aggregators in order. */
export async function readBlob(blobId: string): Promise<Uint8Array> {
  let lastErr = "";
  for (const base of AGGREGATORS) {
    try {
      const res = await fetch(`${base}/v1/blobs/${blobId}`);
      if (!res.ok) { lastErr = `${base} -> HTTP ${res.status}`; continue; }
      return new Uint8Array(await res.arrayBuffer());
    } catch (e) {
      lastErr = `${base} -> ${(e as Error).message}`;
    }
  }
  throw new Error(`Walrus read failed for ${blobId}. Last: ${lastErr}`);
}
