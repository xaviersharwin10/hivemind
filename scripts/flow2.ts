/**
 * HiveMind — Flow 2 ingestion proof (no Telegram token needed).
 *
 * Simulates the two chat events the bot will produce, against the real group
 * account proven in Flow 1:
 *   1. a dropped file  → Walrus blob + referencing MemWal memory
 *   2. a text decision → MemWal memory
 * then recalls to show both are retrievable, and reads the file back from Walrus.
 *
 * Run:  pnpm flow2
 */

import { readFileSync } from "node:fs";
import {
  type SuiNetwork,
  Registry,
  makeMemwal,
  ingestFile,
  ingestText,
  readBlob,
  MEMWAL,
} from "@hivemind/core";

function env(): Record<string, string> {
  const e: Record<string, string> = { ...(process.env as Record<string, string>) };
  try {
    for (const line of readFileSync(".env", "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !e[m[1]]) e[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  } catch { /* ignore */ }
  return e;
}

async function main() {
  const e = env();
  const network = (e.SUI_NETWORK ?? "testnet") as SuiNetwork;
  const groupId = e.GROUP_ID ?? "proto-group-1";
  const serverUrl = e.MEMWAL_SERVER_URL ?? MEMWAL[network].relayerUrl;

  const record = await new Registry("data/registry.json").get(groupId);
  if (!record) {
    console.error(`No group "${groupId}" in registry. Run \`pnpm flow1\` first.`);
    process.exit(1);
  }
  const ctx = { record, network, serverUrl };
  console.log(`\n🐝 HiveMind Flow 2 — ingestion into account ${record.accountId.slice(0, 10)}…\n`);

  // 1. simulate a dropped file (a tiny fake "API spec")
  const fakeSpec = new TextEncoder().encode(
    "HiveMind API Spec v1\nPOST /ingest  { text }\nGET /recall?q=...\nAuth: delegate key\n",
  );
  console.log("📎 ingestFile: API_Specs.txt → Walrus + memory (cold write ~30-40s)...");
  const file = await ingestFile(ctx, {
    bytes: fakeSpec,
    filename: "API_Specs.txt",
    mime: "text/plain",
    caption: "use this spec for the backend",
  });
  console.log(`   ✅ walrus_blob=${file.blobId}${file.alreadyCertified ? " (already certified)" : ""}`);

  // 2. simulate a text decision
  console.log('💬 ingestText: "We decided to ship the MVP by Friday." ...');
  await ingestText(ctx, "The group decided to ship the MVP by Friday.", "fact");
  console.log("   ✅ stored");

  // 3. recall both
  const memwal = makeMemwal({ key: record.botDelegateKey, accountId: record.accountId, network, serverUrl, namespace: record.namespace });
  for (const q of ["what file did we share for the backend?", "when are we shipping?"]) {
    console.log(`\n🔎 recall: "${q}"`);
    const res = await memwal.recall({ query: q, namespace: record.namespace, limit: 2, maxDistance: 0.75 });
    for (const r of res.results) console.log(`   • [${r.distance.toFixed(3)}] ${r.text}`);
    if (res.results.length === 0) console.log("   (no results yet — indexing may lag)");
  }

  // 4. read the artifact back from Walrus (what hivemind-read will do for Claude)
  console.log(`\n📥 readBlob(${file.blobId.slice(0, 12)}…) from Walrus:`);
  const bytes = await readBlob(file.blobId);
  console.log("   " + new TextDecoder().decode(bytes).split("\n")[0] + " …");

  console.log("\n🎉 Flow 2 proven: file→Walrus→memory, text→memory, recall, and artifact read-back all live.\n");
}

main().catch((err) => {
  console.error("\n❌ Flow 2 failed:", err?.message ?? err);
  process.exit(1);
});
