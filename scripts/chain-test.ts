/**
 * HiveMind — on-chain registry proof against OUR deployed Move package.
 *
 * Calls `hivemind::registry` live on Sui testnet (no Enoki — a local funded key
 * pays gas), proving the web3 spine end-to-end:
 *   register_group  → creates a Group object on-chain
 *   record_artifact → appends a hashed artifact to the on-chain manifest
 *   readGroupArtifacts / findGroupId → read it back from chain
 *
 * Run:  pnpm chain-test
 */

import { readFileSync } from "node:fs";
import {
  type SuiNetwork,
  makeSuiClient,
  keypairFromSecret,
  HIVEMIND,
  buildRegisterGroupTx,
  buildRecordArtifactTx,
  artifactHash,
  groupIdFromDigest,
  findGroupId,
  readGroupArtifacts,
} from "@hivemind/core";

function envVar(name: string): string {
  const m = readFileSync(".env", "utf8").match(new RegExp(`^\\s*${name}\\s*=\\s*(.*)\\s*$`, "m"));
  if (!m) throw new Error(`${name} not in .env`);
  return m[1].replace(/^["']|["']$/g, "");
}

async function main() {
  const network = (process.env.SUI_NETWORK ?? "testnet") as SuiNetwork;
  const suiClient = makeSuiClient(network);
  const signer = keypairFromSecret(envVar("SUI_PRIVATE_KEY"));
  const me = signer.getPublicKey().toSuiAddress();

  const chatId = `demo-chain-${Date.now()}`;
  const memwalAccount = "0x74c056bb3ffc83163309eb7f32114b83628108ac21c3f154a86371ade3dfac76";

  console.log(`\n🐝 HiveMind on-chain registry — package ${HIVEMIND[network].packageId.slice(0, 10)}…`);
  console.log(`   signer ${me.slice(0, 10)}…  chat_id ${chatId}\n`);

  // 1. register_group
  console.log("📝 register_group ...");
  let r = await suiClient.signAndExecuteTransaction({
    signer,
    transaction: buildRegisterGroupTx({ network, chatId, memwalAccount, namespace: "main", writer: me }),
    options: { showEffects: true },
  });
  await suiClient.waitForTransaction({ digest: r.digest });
  const groupId = await groupIdFromDigest(suiClient, r.digest);
  console.log(`   ✅ Group ${groupId}  (tx ${r.digest})`);

  // 2. record_artifact (with a real integrity hash)
  const fakeBytes = new TextEncoder().encode("HiveMind on-chain artifact manifest proof");
  const hash = artifactHash(fakeBytes);
  console.log("📎 record_artifact ...");
  r = await suiClient.signAndExecuteTransaction({
    signer,
    transaction: buildRecordArtifactTx({
      network,
      groupId,
      blobId: "wBMr7ug_demo_blob_id",
      name: "spec.txt",
      mime: "text/plain",
      sha256: hash,
      sealed: true,
    }),
    options: { showEffects: true },
  });
  await suiClient.waitForTransaction({ digest: r.digest });
  console.log(`   ✅ recorded  (tx ${r.digest})`);

  // 3. read it back from chain
  const resolved = await findGroupId(suiClient, network, chatId);
  console.log(`\n🔎 findGroupId(${chatId}) → ${resolved}  ${resolved === groupId ? "✓ matches" : "✗ MISMATCH"}`);
  const artifacts = await readGroupArtifacts(suiClient, groupId);
  console.log(`📂 on-chain manifest (${artifacts.length} artifact):`);
  for (const a of artifacts) {
    console.log(`   • ${a.name} (${a.mime}) blob=${a.blobId} sealed=${a.sealed}`);
    console.log(`     sha256=${a.sha256}`);
    console.log(`     hash matches our bytes? ${a.sha256 === Buffer.from(hash).toString("hex") ? "✓" : "✗"}`);
  }

  console.log(`\n🎉 Our own Move package drives a live on-chain group + verifiable artifact manifest on Sui testnet.\n`);
}

main().catch((err) => {
  console.error("\n❌ chain-test failed:", err?.stack ?? err?.message ?? err);
  process.exit(1);
});
