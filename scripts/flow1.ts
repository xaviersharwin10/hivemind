/**
 * HiveMind — Flow 1 prototype (Group Onboarding), proven end to end on testnet.
 *
 * What it proves (the riskiest unverified path):
 *   1. create_account            → a fresh MemWalAccount for the group
 *   2. generate + add_delegate_key → the bot's delegate key, registered on-chain
 *   3. remember + recall         → a memory round-trip through the relayer
 *
 * Owner = a local Ed25519 keypair here. In the Option-B build the same calls take
 * a zkLogin/Enoki signer instead — only the signer changes.
 *
 * Run:  cp .env.example .env  &&  pnpm install  &&  pnpm flow1
 */

import { readFileSync } from "node:fs";
import {
  MEMWAL,
  type SuiNetwork,
  makeSuiClient,
  keypairFromSecret,
  newOwnerKeypair,
  getBalanceMist,
  tryFaucet,
  createGroupAccount,
  makeMemwal,
  Registry,
} from "@hivemind/core";

// --- tiny .env loader (no dep) ---
function loadEnv(): Record<string, string> {
  const env: Record<string, string> = { ...process.env as Record<string, string> };
  try {
    for (const line of readFileSync(".env", "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !env[m[1]]) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  } catch { /* no .env — rely on process.env */ }
  return env;
}

const MIN_BALANCE_MIST = 50_000_000n; // ~0.05 SUI, enough for two txs

async function main() {
  const env = loadEnv();
  const network = (env.SUI_NETWORK ?? "testnet") as SuiNetwork;
  const groupId = env.GROUP_ID ?? "proto-group-1";
  const serverUrl = env.MEMWAL_SERVER_URL ?? MEMWAL[network].relayerUrl;

  console.log(`\n🐝 HiveMind Flow 1 — network=${network} group=${groupId}\n`);

  const suiClient = makeSuiClient(network);
  const registry = new Registry("data/registry.json");

  // --- idempotency: reuse an existing group account if we've already made one ---
  const existing = await registry.get(groupId);
  if (existing) {
    console.log("ℹ️  Group already onboarded — reusing existing account.");
    console.log(`   accountId: ${existing.accountId}`);
    await memoryRoundTrip(existing.botDelegateKey, existing.accountId, network, serverUrl, existing.namespace);
    return;
  }

  // --- owner keypair (prototype stand-in for a zkLogin owner) ---
  let ownerSecret = env.SUI_PRIVATE_KEY?.trim();
  if (!ownerSecret) {
    const fresh = newOwnerKeypair();
    ownerSecret = fresh.secret;
    console.log("🔑 Generated a new owner keypair (no SUI_PRIVATE_KEY was set).");
    console.log(`   address: ${fresh.address}`);
    console.log(`   secret : ${fresh.secret}`);
    console.log("   → Paste this secret into .env as SUI_PRIVATE_KEY so re-runs reuse it.\n");
  }
  const owner = keypairFromSecret(ownerSecret);
  const ownerAddress = owner.getPublicKey().toSuiAddress();

  // --- fund the owner (gas for create_account + add_delegate_key) ---
  let balance = await getBalanceMist(suiClient, ownerAddress);
  if (balance < MIN_BALANCE_MIST) {
    console.log(`💧 Balance ${balance} MIST < threshold — requesting from faucet...`);
    const ok = await tryFaucet(network, ownerAddress);
    if (ok) {
      // faucet settles async; poll briefly
      for (let i = 0; i < 10 && balance < MIN_BALANCE_MIST; i++) {
        await new Promise((r) => setTimeout(r, 1500));
        balance = await getBalanceMist(suiClient, ownerAddress);
      }
    }
    if (balance < MIN_BALANCE_MIST) {
      console.error(
        `\n❌ Owner ${ownerAddress} still underfunded (${balance} MIST).\n` +
        `   Fund it manually: https://faucet.sui.io  (network: ${network}), then re-run.\n`,
      );
      process.exit(1);
    }
  }
  console.log(`✅ Owner funded: ${ownerAddress} (${balance} MIST)\n`);

  // --- Flow 1 core: create account + register bot delegate ---
  console.log("⛓️  create_account + add_delegate_key (2 owner-signed txs)...");
  const group = await createGroupAccount({ network, suiClient, owner, botLabel: "hivemind-bot" });
  console.log(`✅ MemWalAccount: ${group.accountId}`);
  console.log(`   create tx     : ${group.createDigest}`);
  console.log(`   bot delegate  : ${group.botDelegate.suiAddress}`);
  console.log(`   add-delegate tx: ${group.addDelegateDigest}\n`);

  const record = await registry.upsert({
    groupId,
    ownerAddress: group.ownerAddress,
    ownerSecret, // PROTOTYPE ONLY
    accountId: group.accountId,
    botDelegateKey: group.botDelegate.privateKey,
  });

  // --- prove memory works through the bot delegate ---
  await memoryRoundTrip(record.botDelegateKey, record.accountId, network, serverUrl, record.namespace);

  console.log("\n🎉 Flow 1 proven end to end. Account + bot delegate + memory round-trip all live.\n");
}

async function memoryRoundTrip(
  botKey: string,
  accountId: string,
  network: SuiNetwork,
  serverUrl: string,
  namespace: string,
) {
  const memwal = makeMemwal({ key: botKey, accountId, network, serverUrl, namespace });

  console.log("🩺 relayer health...");
  const health = await memwal.health();
  console.log(`   ${health.status} (v${health.version})`);

  const fact = "HiveMind Flow 1 proof: the group decided to use a Python backend.";
  console.log(`💾 remember: "${fact}" (cold writes take ~30-40s: SEAL encrypt + Walrus upload + embed)`);
  await memwal.rememberAndWait(fact, namespace, { timeoutMs: 90_000 });

  console.log(`🔎 recall: "what backend did we choose?"`);
  const res = await memwal.recall({ query: "what backend did we choose?", namespace, limit: 3, maxDistance: 0.7 });
  for (const r of res.results) console.log(`   • [${r.distance.toFixed(3)}] ${r.text}`);
  if (res.results.length === 0) console.log("   (no results — indexing may still be catching up)");
}

main().catch((err) => {
  console.error("\n❌ Flow 1 failed:", err?.message ?? err);
  process.exit(1);
});
