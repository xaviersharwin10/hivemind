/**
 * Proves per-group namespace isolation on a SINGLE MemWalAccount.
 *
 * One creator's address can own only one MemWalAccount, so two of their groups
 * share it — but with a per-group namespace their memories stay separate. This
 * writes two distinct facts under two namespaces on the same account, then recalls
 * in each and asserts neither namespace leaks into the other.
 *
 * Run:  pnpm namespace-test
 */

import { type SuiNetwork, Registry, makeMemwal, MEMWAL } from "@hivemind/core";

async function main() {
  const network = (process.env.SUI_NETWORK ?? "testnet") as SuiNetwork;
  const serverUrl = MEMWAL[network].relayerUrl;

  // Reuse a real, proven account (its bot delegate can read+write).
  const reg = await new Registry("data/registry.json").get("-5421887261");
  if (!reg) throw new Error("expected group -5421887261 in data/registry.json");
  const { accountId, botDelegateKey } = reg;

  const run = Date.now().toString(36);
  const nsA = `iso-alpha-${run}`;
  const nsB = `iso-bravo-${run}`;
  const factA = `Team ALPHA decided to use Rust for the engine. (tag ${run})`;
  const factB = `Team BRAVO decided to use Go for the engine. (tag ${run})`;

  const memA = makeMemwal({ key: botDelegateKey, accountId, network, serverUrl, namespace: nsA });
  const memB = makeMemwal({ key: botDelegateKey, accountId, network, serverUrl, namespace: nsB });

  console.log(`\n🐝 Namespace isolation on one account ${accountId.slice(0, 10)}…`);
  console.log(`   ns A=${nsA}  ns B=${nsB}\n`);

  console.log("✍️  writing one fact into each namespace (cold writes ~30-40s each)…");
  await Promise.all([
    memA.rememberAndWait(factA, nsA, { timeoutMs: 120_000 }),
    memB.rememberAndWait(factB, nsB, { timeoutMs: 120_000 }),
  ]);
  console.log("   ✅ both stored\n");

  const q = "what language did the team choose for the engine?";
  const [resA, resB] = await Promise.all([
    memA.recall({ query: q, namespace: nsA, limit: 5, maxDistance: 0.9 }),
    memB.recall({ query: q, namespace: nsB, limit: 5, maxDistance: 0.9 }),
  ]);

  const textsA = resA.results.map((r) => r.text);
  const textsB = resB.results.map((r) => r.text);
  console.log(`🔎 recall in ns A → ${textsA.length} hit(s):`);
  textsA.forEach((t) => console.log(`   • ${t}`));
  console.log(`🔎 recall in ns B → ${textsB.length} hit(s):`);
  textsB.forEach((t) => console.log(`   • ${t}`));

  const aHasOwn = textsA.some((t) => t.includes("ALPHA") && t.includes(run));
  const aLeaksB = textsA.some((t) => t.includes("BRAVO"));
  const bHasOwn = textsB.some((t) => t.includes("BRAVO") && t.includes(run));
  const bLeaksA = textsB.some((t) => t.includes("ALPHA"));

  console.log("\nResult:");
  console.log(`   ns A sees its own fact:  ${aHasOwn ? "✓" : "✗"}`);
  console.log(`   ns A leaks ns B's fact:  ${aLeaksB ? "✗ LEAK" : "✓ none"}`);
  console.log(`   ns B sees its own fact:  ${bHasOwn ? "✓" : "✗"}`);
  console.log(`   ns B leaks ns A's fact:  ${bLeaksA ? "✗ LEAK" : "✓ none"}`);

  if (!aHasOwn || !bHasOwn) throw new Error("a namespace could not see its own fact (indexing lag? re-run)");
  if (aLeaksB || bLeaksA) throw new Error("namespace LEAK — memories crossed between namespaces!");

  console.log("\n🎉 Per-group namespace isolation proven: same account, separate memories.\n");
}

main().catch((e) => {
  console.error("\n❌ namespace-test failed:", e?.message ?? e);
  process.exit(1);
});
