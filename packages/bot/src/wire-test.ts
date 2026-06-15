/**
 * Live test for the wired on-chain flows (2a register_group + 2b sponsored
 * record_artifact). Proves the exact paths the bot/onboarding use:
 *   - register a group on-chain with the bot delegate as writer
 *   - the bot delegate (a plain Ed25519 key) records an artifact, Enoki-sponsored
 *   - read the manifest back and verify the hash
 *
 * Run:  pnpm --filter @hivemind/bot exec tsx src/wire-test.ts
 */

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type SuiNetwork,
  makeSuiClient,
  keypairFromSecret,
  generateDelegateKey,
  buildRegisterGroupTx,
  groupIdFromDigest,
  readGroupArtifacts,
  artifactHash,
} from "@hivemind/core";
import { makeArtifactRecorder } from "./onchain";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
function env(name: string): string {
  const m = readFileSync(resolve(ROOT, ".env"), "utf8").match(new RegExp(`^\\s*${name}\\s*=\\s*(.*)\\s*$`, "m"));
  if (!m) throw new Error(`${name} not in .env`);
  return m[1].replace(/^["']|["']$/g, "");
}

async function main() {
  const network = (process.env.SUI_NETWORK ?? "testnet") as SuiNetwork;
  const suiClient = makeSuiClient(network);
  const owner = keypairFromSecret(env("SUI_PRIVATE_KEY"));
  const ownerAddr = owner.getPublicKey().toSuiAddress();

  // The bot delegate — a plain Ed25519 key, authorized as the group's writer.
  const bot = await generateDelegateKey();
  const chatId = `wire-${Date.now()}`;
  const memwalAccount = "0x74c056bb3ffc83163309eb7f32114b83628108ac21c3f154a86371ade3dfac76";

  console.log(`\n🐝 Wiring test — owner ${ownerAddr.slice(0, 10)}…  bot-writer ${bot.suiAddress.slice(0, 10)}…\n`);

  // 2a: register_group (owner pays gas directly here; in prod this is Enoki-sponsored)
  console.log("📝 register_group (writer = bot delegate) ...");
  const r = await suiClient.signAndExecuteTransaction({
    signer: owner,
    transaction: buildRegisterGroupTx({ network, chatId, memwalAccount, namespace: "main", writer: bot.suiAddress }),
    options: { showEffects: true },
  });
  await suiClient.waitForTransaction({ digest: r.digest });
  const groupId = await groupIdFromDigest(suiClient, r.digest);
  console.log(`   ✅ Group ${groupId}`);

  // 2b: the bot delegate records an artifact, Enoki-sponsored (the real bot path)
  console.log("⛓️  record_artifact via Enoki sponsorship (bot-delegate-signed) ...");
  const recorder = makeArtifactRecorder(env("ENOKI_PRIVATE_API_KEY"), network);
  const bytes = new TextEncoder().encode("wired artifact payload");
  const sha256 = artifactHash(bytes);
  const digest = await recorder.record({
    groupId,
    botDelegateKey: bot.privateKey,
    blobId: "wired_blob_demo",
    name: "decision.pdf",
    mime: "application/pdf",
    sha256,
    sealed: true,
  });
  console.log(`   ✅ recorded (tx ${digest})`);

  const artifacts = await readGroupArtifacts(suiClient, groupId);
  console.log(`\n📂 on-chain manifest (${artifacts.length}):`);
  for (const a of artifacts) {
    const match = a.sha256 === Buffer.from(sha256).toString("hex");
    console.log(`   • ${a.name} blob=${a.blobId} by=${a.addedBy.slice(0, 10)}… sealed=${a.sealed} hash✓=${match}`);
  }
  if (artifacts.length !== 1) throw new Error("expected exactly 1 artifact");

  console.log(`\n🎉 Wired path proven: bot delegate (Enoki-sponsored) writes the on-chain artifact manifest.\n`);
}

main().catch((e) => {
  console.error("\n❌ wire-test failed:", e?.stack ?? e?.message ?? e);
  process.exit(1);
});
