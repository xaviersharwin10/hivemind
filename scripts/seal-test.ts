/**
 * HiveMind — Seal artifact round-trip proof.
 *
 * Proves the privacy step end-to-end against the live group account on testnet:
 *   plaintext → Seal encrypt → Walrus (ciphertext only) → read back →
 *   Seal decrypt via the group's seal_approve policy (delegate key) → plaintext.
 *
 * Also asserts the blob stored on Walrus is genuinely ciphertext (not the
 * plaintext), i.e. the public aggregator never sees the file contents.
 *
 * Run:  pnpm seal-test
 */

import { readFileSync } from "node:fs";
import {
  type SuiNetwork,
  Registry,
  makeSuiClient,
  encryptArtifact,
  decryptArtifact,
  isSealEncrypted,
  uploadBlob,
  readBlob,
} from "@hivemind/core";

async function main() {
  const network = (process.env.SUI_NETWORK ?? "testnet") as SuiNetwork;
  const groupId = process.env.GROUP_ID ?? "-5421887261";

  const record = await new Registry("data/registry.json").get(groupId);
  if (!record) throw new Error(`No group "${groupId}" in registry.`);

  // Use the exact deployed MCP delegate key if present (proves the real read path),
  // otherwise fall back to the bot delegate (also a valid delegate on the account).
  let delegateKey = record.botDelegateKey;
  try {
    const mcp = JSON.parse(readFileSync(".mcp.json", "utf8"));
    const env = mcp?.mcpServers?.hivemind?.env;
    if (env?.HIVEMIND_ACCOUNT_ID === record.accountId && env?.HIVEMIND_DELEGATE_KEY) {
      delegateKey = env.HIVEMIND_DELEGATE_KEY;
    }
  } catch { /* no .mcp.json — use bot delegate */ }

  const suiClient = makeSuiClient(network);
  const secret = `HiveMind Seal proof — confidential group spec — nonce ${Date.now()}`;
  const plaintext = new TextEncoder().encode(secret);

  console.log(`\n🐝 Seal round-trip on account ${record.accountId.slice(0, 10)}… (owner ${record.ownerAddress.slice(0, 8)}…)\n`);

  console.log("🔐 encryptArtifact (Seal threshold-2, testnet open key servers)...");
  const ciphertext = await encryptArtifact({
    suiClient,
    network,
    namespace: record.namespace,
    ownerAddress: record.ownerAddress,
    data: plaintext,
  });
  console.log(`   ✅ ${plaintext.length} B plaintext → ${ciphertext.length} B EncryptedObject`);
  if (new TextDecoder().decode(ciphertext).includes(secret)) {
    throw new Error("ciphertext still contains the plaintext — encryption did not happen!");
  }

  console.log("📤 uploadBlob (ciphertext only) → Walrus...");
  const { blobId } = await uploadBlob(ciphertext);
  console.log(`   ✅ walrus_blob=${blobId}`);

  console.log("📥 readBlob from Walrus aggregator...");
  const got = await readBlob(blobId);
  console.log(`   ✅ ${got.length} B back; isSealEncrypted=${isSealEncrypted(got)}`);
  if (!isSealEncrypted(got)) throw new Error("blob read back is not a Seal EncryptedObject");
  if (new TextDecoder().decode(got).includes(secret)) {
    throw new Error("PRIVACY FAIL: plaintext is visible in the Walrus blob!");
  }

  console.log("🔓 decryptArtifact via seal_approve (delegate key signs session + policy)...");
  const recovered = await decryptArtifact({ suiClient, network, delegateKey, accountId: record.accountId, data: got });
  const recoveredText = new TextDecoder().decode(recovered);
  console.log(`   ↳ "${recoveredText}"`);
  if (recoveredText !== secret) throw new Error(`decrypt mismatch:\n  want: ${secret}\n  got:  ${recoveredText}`);

  console.log("\n🎉 Seal proven: Walrus held ciphertext only; the group's delegate key recovered the plaintext via on-chain seal_approve.\n");
}

main().catch((err) => {
  console.error("\n❌ Seal test failed:", err?.stack ?? err?.message ?? err);
  process.exit(1);
});
