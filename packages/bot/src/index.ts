/**
 * HiveMind Telegram bot — Flow 2 (ingestion) wiring.
 *
 * Listens to a group, captures decisions + files into the group's MemWal account.
 * The ingestion logic lives in @hivemind/core; this file is just the Telegram glue.
 *
 * Requires BotFather setup:
 *   1. /newbot  → copy token into .env as BOT_TOKEN
 *   2. /setprivacy → Disable   (so the bot sees ALL group messages, not just @-mentions)
 *
 * Capture triggers (v1, explicit = high precision):
 *   • any document/photo            → Seal-encrypted → Walrus + memory + on-chain manifest
 *   • text starting with "remember:" → stored verbatim as a fact
 *   • reply to a message with /save  → stores the replied-to text
 *   • /recall <query>                → semantic search (debug/demo)
 *
 * Onboarding: each chat gets its own creator-owned MemWalAccount via zkLogin/Enoki
 * (Flow 1 / Option B) and is registered on our `hivemind::registry` contract; files
 * are then anchored to that group's on-chain artifact manifest as they're ingested.
 */

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import https from "node:https";
import { setGlobalDispatcher, Agent as UndiciAgent } from "undici";
import { Telegraf, type Context } from "telegraf";
import {
  type SuiNetwork,
  type GroupRecord,
  Registry,
  ingestFile,
  ingestText,
  makeMemwal,
  makeSuiClient,
  readGroup,
  MEMWAL,
  MAX_DELEGATE_KEYS,
  ENCLAVE_DELEGATE,
  generateDelegateKey,
  addressFromEd25519PublicKey,
  hexToBytes,
  hivemindMoveTargets,
  type IngestedFile,
} from "@hivemind/core";
import { OnboardServer, type ConnectInfo } from "./server";
import { makeArtifactRecorder } from "./onchain";
import { signBindToken } from "./bindtoken";
import { deriveBotDelegate } from "./delegate";

// Some networks (incl. this sandbox) have broken IPv6 egress, so Node hangs trying
// the AAAA address for api.telegram.org. Force IPv4 for native fetch (file downloads,
// Walrus, relayer) and for telegraf's node-fetch client below. Harmless elsewhere.
setGlobalDispatcher(
  new UndiciAgent({ connect: { family: 4 } } as ConstructorParameters<typeof UndiciAgent>[0]),
);
const ipv4Agent = new https.Agent({ family: 4 });

// Anchor paths to the repo root so the bot works regardless of cwd
// (pnpm runs it from packages/bot/, but .env + data/ live at the root).
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

function loadEnv(): Record<string, string> {
  const e: Record<string, string> = { ...(process.env as Record<string, string>) };
  try {
    for (const line of readFileSync(resolve(ROOT, ".env"), "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !e[m[1]]) e[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  } catch { /* ignore */ }
  return e;
}

const env = loadEnv();
const BOT_TOKEN = env.BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error("Set BOT_TOKEN in .env (from @BotFather). See packages/bot/src/index.ts header.");
  process.exit(1);
}

const network = (env.SUI_NETWORK ?? "testnet") as SuiNetwork;
const serverUrl = env.MEMWAL_SERVER_URL ?? MEMWAL[network].relayerUrl;
const onboardUrl = env.ONBOARD_URL ?? "http://localhost:5173";
// Path B (claude.ai TEE connector): the hosted remote MCP URL members paste into
// claude.ai, and the HMAC secret that signs bind tokens (shared with the remote MCP).
const remoteMcpUrl = env.REMOTE_MCP_URL ?? "";
const bindSecret = env.BIND_SIGNING_SECRET ?? "";
// Master seed for deterministic per-group bot delegate keys. With it set, the bot
// rebuilds any group's delegate key from the on-chain registry alone — no local
// state, so a restart never loses groups. Without it, falls back to local registry.
const botMasterSeed = env.BOT_MASTER_SEED ?? "";
const delegateFor = (groupId: string) => (botMasterSeed ? deriveBotDelegate(botMasterSeed, groupId) : null);
// Hosts like Railway/Render inject the public port as PORT; honour it first so the
// onboarding API is reachable. Falls back to BOT_API_PORT, then 8080 for local dev.
const apiPort = Number(env.PORT ?? env.BOT_API_PORT ?? "8080");
const suiClient = makeSuiClient(network);
// Local store: now just a CACHE of the bot's per-group secret (delegate key) +
// member list. The canonical group→account/namespace/owner mapping is read from
// our on-chain `hivemind::registry` (the source of truth).
const registry = new Registry(resolve(ROOT, "data/registry.json"));
const groupCache = new Map<string, GroupRecord>();

/** Thrown when a chat hasn't completed creator-owned onboarding yet. */
class NotOnboarded extends Error {}

/**
 * Resolve a chat's group. The public state (account, namespace, owner) comes from
 * the on-chain registry; the local store supplies only the bot's secret delegate
 * key + cached member list. Falls back to the local record for groups predating
 * the on-chain registry, or if a Sui RPC read transiently fails.
 */
async function groupFor(chatId: number): Promise<GroupRecord> {
  const key = String(chatId);
  const cached = groupCache.get(key);
  if (cached) return cached;

  const local = await registry.get(key); // secret + member cache
  let onchain: Awaited<ReturnType<typeof readGroup>> = null;
  try {
    onchain = await readGroup(suiClient, network, key);
  } catch (e) {
    console.error("on-chain readGroup failed; falling back to local:", (e as Error).message);
  }

  let rec: GroupRecord;
  if (onchain) {
    // Chain is the source of truth. The bot's secret delegate key is either in
    // local state, or — for deterministically-onboarded groups — re-derived from
    // the master seed (and verified against the on-chain `writer`). The latter
    // survives any restart with no stored state.
    let botDelegateKey = local?.botDelegateKey;
    if (!botDelegateKey) {
      const derived = delegateFor(key);
      if (derived && derived.suiAddress.toLowerCase() === onchain.writer.toLowerCase()) {
        botDelegateKey = derived.privateKey;
      }
    }
    if (!botDelegateKey) throw new NotOnboarded();
    rec = {
      groupId: key,
      ownerAddress: onchain.owner,
      accountId: onchain.memwalAccount,
      botDelegateKey,
      namespace: onchain.namespace,
      onchainGroupId: onchain.groupId,
      members: local?.members ?? [],
      createdAt: local?.createdAt ?? Date.now(),
    };
  } else if (local) {
    rec = local; // legacy group (pre on-chain registry) or RPC-down fallback
  } else {
    throw new NotOnboarded();
  }

  groupCache.set(key, rec);
  return rec;
}

function onboardingLink(chatId: number): string {
  const token = onboard.issueToken(String(chatId));
  // chat/token live in the URL HASH: Enoki computes the Google redirect_uri as
  // location.href without the hash, so the redirect stays a stable origin that can
  // be whitelisted once (query params would make it vary per group → mismatch).
  return `${onboardUrl}/#chat=${chatId}&t=${token}`;
}

const pkg = MEMWAL[network].packageId;
// Once the MCP server is published to npm, set MCP_PACKAGE=hivemind-memory-mcp so members
// get a config that runs anywhere (`npx -y hivemind-memory-mcp`). Without it, we fall back
// to the in-repo source (works only on a machine with this repo — fine for local dev).
const MCP_PACKAGE = env.MCP_PACKAGE;
const mcpEntry = resolve(ROOT, "packages/mcp/src/index.ts");
const mcpInvocation = MCP_PACKAGE
  ? { command: "npx", args: ["-y", MCP_PACKAGE] }
  : { command: "npx", args: ["tsx", mcpEntry] };

/** Build a paste-ready MCP config for the member's Claude Desktop / Cursor. */
function mcpConfig(rec: GroupRecord, delegateKey: string): string {
  return JSON.stringify(
    {
      mcpServers: {
        hivemind: {
          ...mcpInvocation,
          env: {
            HIVEMIND_DELEGATE_KEY: delegateKey,
            HIVEMIND_ACCOUNT_ID: rec.accountId,
            HIVEMIND_NAMESPACE: rec.namespace,
            HIVEMIND_NETWORK: network,
          },
        },
      },
    },
    null,
    2,
  );
}

const onboard = new OnboardServer(
  registry,
  async (chatId, accountId) => {
    groupCache.delete(String(chatId)); // fresh group → resolve from chain on next message
    // Plain text (no parse_mode): the bot @handle can contain "_" which legacy
    // Markdown would mis-parse as italic.
    await bot.telegram
      .sendMessage(
        chatId,
        `🐝 HiveMind is live!\n\n` +
          `I'll quietly turn this group's decisions & files into a verifiable memory you own.\n\n` +
          `🏷️ Tag me — “@${bot.botInfo?.username ?? "HiveMind"} we ship on June 21” — or drop a file\n` +
          `🔎 /recall <question> to search it\n` +
          `🤖 Members: /connect to plug in your AI\n\n` +
          `Vault: ${accountId.slice(0, 12)}…${accountId.slice(-6)}`,
      )
      .catch(() => {});
  },
  {
    apiKey: env.ENOKI_PRIVATE_API_KEY,
    network,
    allowedMoveCallTargets: [
      `${pkg}::account::create_account`,
      `${pkg}::account::add_delegate_key`,
      ...hivemindMoveTargets(network), // our own registry: register_group + record_artifact
    ],
  },
  // Flow 3: owner approved → deliver the member's key + MCP config privately.
  async (info: ConnectInfo) => {
    const rec = await registry.get(info.chatId);
    if (!rec) return;

    // Enclave-enable: the owner just authorized the shared enclave delegate for
    // this group (claude.ai TEE). No personal key to deliver — just confirm.
    if (info.enclaveEnable) {
      groupCache.delete(info.chatId);
      await bot.telegram
        .sendMessage(
          info.chatId,
          `🤖 claude.ai is now enabled for this group.\nMembers can run /connect_claude to link their Claude account.`,
        )
        .catch(() => {});
      return;
    }

    const suiAddress = addressFromEd25519PublicKey(hexToBytes(info.memberPubKeyHex));
    await registry.addMember(info.chatId, { label: info.label, suiAddress, addedAt: Date.now() });
    groupCache.delete(info.chatId); // member count changed → refresh cache
    const config = mcpConfig(rec, info.memberPrivKey);
    try {
      await bot.telegram.sendMessage(
        info.requesterUserId,
        `✅ You're connected to the group's HiveMind memory!\n\nPaste this into your Claude Desktop config (claude_desktop_config.json), then restart Claude:\n\n\`\`\`json\n${config}\n\`\`\`\n\nThen ask Claude to "recall what the group decided".`,
        { parse_mode: "Markdown" },
      );
    } catch (e) {
      // Telegram blocks bot→user DMs until the user has started the bot.
      console.error("connect DM failed:", (e as Error).message);
      await bot.telegram
        .sendMessage(
          info.chatId,
          `⚠️ ${info.requesterName}, your connection was approved, but I can't DM you your key until you start a private chat with me.\n\n👉 Open my profile, press *Start*, then run /connect again.`,
          { parse_mode: "Markdown" },
        )
        .catch(() => {});
    }
  },
  delegateFor,
);

const bytesToHex = (b: Uint8Array) => Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");

// Records ingested files on our own on-chain manifest (sponsored, bot-delegate-signed).
// Null if no Enoki key — ingestion still works, just without the on-chain anchor.
const recorder = env.ENOKI_PRIVATE_API_KEY ? makeArtifactRecorder(env.ENOKI_PRIVATE_API_KEY, network) : null;

/** Append an ingested artifact to the group's on-chain manifest. Never throws.
 *  Returns true only if the artifact was actually anchored on-chain. */
async function recordOnChain(rec: GroupRecord, out: IngestedFile, name: string, mime: string): Promise<boolean> {
  if (!recorder || !rec.onchainGroupId) return false;
  try {
    const digest = await recorder.record({
      groupId: rec.onchainGroupId,
      botDelegateKey: rec.botDelegateKey,
      blobId: out.blobId,
      name,
      mime,
      sha256: out.sha256,
      sealed: out.sealed,
    });
    console.log(`⛓️  artifact recorded on-chain (${out.blobId.slice(0, 10)}…): ${digest}`);
    return true;
  } catch (e) {
    console.error("on-chain record_artifact failed (non-fatal):", (e as Error).message);
    return false;
  }
}

/** telegraf's emoji-literal type is finicky; cast the method, not the value. */
const react = (ctx: Context, emoji: string) =>
  (ctx.react as (e: string) => Promise<unknown>)(emoji).catch(() => {});

async function downloadTelegramFile(bot: Telegraf, fileId: string): Promise<Uint8Array> {
  const link = await bot.telegram.getFileLink(fileId);
  const res = await fetch(link.toString());
  return new Uint8Array(await res.arrayBuffer());
}

const bot = new Telegraf(BOT_TOKEN, { telegram: { agent: ipv4Agent } });

/** Resolve the group, or prompt the creator to finish onboarding. Returns null if not ready. */
async function resolveGroup(ctx: Context): Promise<GroupRecord | null> {
  const chatId = ctx.chat?.id;
  if (chatId == null) return null;
  try {
    return await groupFor(chatId);
  } catch (e) {
    if (e instanceof NotOnboarded) {
      await ctx.reply(
        `👋 This group isn't set up yet. The group creator can activate HiveMind here (you'll own the keys):\n${onboardingLink(chatId)}`,
      );
      return null;
    }
    throw e;
  }
}

bot.start((ctx) => ctx.reply(`🐝 HiveMind is listening. Tag me — “@${ctx.me} we ship on June 21” — drop a file, or reply /save to remember a message.`));

// --- /setup → (re)issue the onboarding link for this group ---
bot.command("setup", async (ctx) => {
  const existing = await registry.get(String(ctx.chat.id));
  if (existing) return ctx.reply(`✅ This group is already set up. Tag me — “@${ctx.me} <decision>” — or drop a file.`);
  await ctx.reply(`Activate HiveMind for this group (you'll own the keys):\n${onboardingLink(ctx.chat.id)}`);
});

// --- bot added to a group → DM the creator an onboarding link ---
bot.on("my_chat_member", async (ctx) => {
  const status = ctx.myChatMember.new_chat_member.status;
  if (status !== "member" && status !== "administrator") return; // ignore removals
  const chatId = ctx.chat.id;
  const link = onboardingLink(chatId);
  const dm = `🐝 Thanks for adding HiveMind to "${"title" in ctx.chat ? ctx.chat.title : "your group"}".\n\nTo activate it, create your group's memory (you own the keys):\n${link}`;
  // Prefer a private DM to the creator; fall back to a group message.
  const ok = await bot.telegram.sendMessage(ctx.from.id, dm).then(() => true).catch(() => false);
  if (!ok) {
    await ctx.reply(
      `🐝 HiveMind added! ${ctx.from.first_name}, activate it here (you'll own the keys):\n${link}`,
    ).catch(() => {});
  }
});

// --- documents (PDFs, etc.) ---
bot.on("document", async (ctx) => {
  try {
    const doc = ctx.message.document;
    const rec = await resolveGroup(ctx);
    if (!rec) return;
    await react(ctx, "👀");
    const bytes = await downloadTelegramFile(bot, doc.file_id);
    const filename = doc.file_name ?? `file-${doc.file_unique_id}`;
    const mime = doc.mime_type ?? "application/octet-stream";
    const out = await ingestFile(
      { record: rec, network, serverUrl },
      { bytes, filename, mime, caption: ctx.message.caption },
    );
    await react(ctx, "✅");
    const anchored = await recordOnChain(rec, out, filename, mime);
    await ctx.reply(
      `📎 *${filename}* secured.\n` +
        `🔒 Seal-encrypted → Walrus \`${out.blobId.slice(0, 12)}…\`\n` +
        `🧠 Added to group memory${anchored ? "\n⛓️ Anchored on-chain (verifiable)" : ""}`,
      { parse_mode: "Markdown" },
    );
  } catch (e) {
    await ctx.reply(`⚠️ Couldn't store that file: ${(e as Error).message}`);
  }
});

// --- photos ---
bot.on("photo", async (ctx) => {
  try {
    const photo = ctx.message.photo.at(-1)!; // largest size
    const rec = await resolveGroup(ctx);
    if (!rec) return;
    await react(ctx, "👀");
    const bytes = await downloadTelegramFile(bot, photo.file_id);
    const filename = `photo-${photo.file_unique_id}.jpg`;
    const out = await ingestFile(
      { record: rec, network, serverUrl },
      { bytes, filename, mime: "image/jpeg", caption: ctx.message.caption },
    );
    await react(ctx, "✅");
    const anchored = await recordOnChain(rec, out, filename, "image/jpeg");
    await ctx.reply(
      `🖼️ Image secured.\n🔒 Seal-encrypted → Walrus \`${out.blobId.slice(0, 12)}…\`${anchored ? "\n⛓️ Anchored on-chain (verifiable)" : ""}`,
      { parse_mode: "Markdown" },
    );
  } catch (e) {
    await ctx.reply(`⚠️ Couldn't store that image: ${(e as Error).message}`);
  }
});

// --- /connect → member requests an AI connection; owner approves via SPA ---
bot.command("connect", async (ctx) => {
  const rec = await resolveGroup(ctx);
  if (!rec) return;
  if (rec.members.length >= MAX_DELEGATE_KEYS - 1) {
    return ctx.reply("⚠️ This group has reached the delegate-key limit (20 per account).");
  }
  const member = await generateDelegateKey();
  const token = onboard.issueConnectToken({
    chatId: String(ctx.chat.id),
    requesterUserId: ctx.from.id,
    requesterName: ctx.from.first_name ?? "member",
    memberPrivKey: member.privateKey,
    memberPubKeyHex: bytesToHex(member.publicKey),
    label: `${ctx.from.first_name ?? "member"}-${Date.now().toString(36)}`,
    accountId: rec.accountId,
  });
  const link = `${onboardUrl}/#connect=${token}`;
  await ctx.reply(
    `🔑 ${ctx.from.first_name}, to connect your AI to this group's memory:\n\n` +
      `1️⃣ Start a private chat with me first (open my profile → *Start*) so I can DM you your key.\n` +
      `2️⃣ The group *owner* approves here: ${link}\n\n` +
      `Once approved, I'll DM you your key + setup config.`,
    { parse_mode: "Markdown" },
  );
});

// --- /enable_claude → owner authorizes the shared enclave delegate (one-time/group) ---
bot.command("enable_claude", async (ctx) => {
  const rec = await resolveGroup(ctx);
  if (!rec) return;
  // Reuse the connect approval SPA, but the key being authorized is the shared
  // enclave delegate (public address) — no personal key is generated/delivered.
  const token = onboard.issueConnectToken({
    chatId: String(ctx.chat.id),
    requesterUserId: ctx.from.id,
    requesterName: ctx.from.first_name ?? "owner",
    memberPrivKey: "",
    memberPubKeyHex: ENCLAVE_DELEGATE.publicKeyHex,
    label: "claude-enclave",
    accountId: rec.accountId,
    enclaveEnable: true,
  });
  const link = `${onboardUrl}/#connect=${token}`;
  // Plain text (no parse_mode): "/connect_claude" contains "_" which legacy
  // Markdown treats as an unbalanced italic entity and rejects.
  await ctx.reply(
    `🔐 Enable claude.ai for this group (one-time, owner only)\n\n` +
      `This authorizes HiveMind's secure enclave to read this group's memory on members' behalf — ` +
      `the enclave's key is hardware-sealed; the operator can't read it.\n\n` +
      `👉 Group owner, approve here: ${link}\n\n` +
      `After that, members run /connect_claude.`,
  );
});

// --- /connect_claude → link a member's claude.ai (hosted TEE path) to this group ---
bot.command("connect_claude", async (ctx) => {
  const rec = await resolveGroup(ctx);
  if (!rec) return;
  if (!bindSecret || !remoteMcpUrl) {
    return ctx.reply(
      "⚠️ The claude.ai connector isn't enabled on this bot yet (missing REMOTE_MCP_URL / BIND_SIGNING_SECRET).\n" +
        "You can still use the local path — run /connect.",
    );
  }
  // Bind token proves this user belongs to THIS group; the remote MCP writes it
  // into their Stytch identity so claude.ai recalls only this group's memory.
  const label = ("title" in ctx.chat && ctx.chat.title) ? ctx.chat.title : rec.namespace;
  const token = signBindToken({ accountId: rec.accountId, namespace: rec.namespace, network, label }, bindSecret);
  const bindLink = `${onboardUrl}/bind?t=${encodeURIComponent(token)}`;
  // Plain text (no parse_mode): the bind token + command names contain "_" which
  // Telegram's legacy Markdown parser treats as italic and rejects as unbalanced.
  await ctx.reply(
    `🤖 Connect this group's memory to claude.ai\n\n` +
      `1️⃣ Open this link and sign in — it links your Claude account to this group:\n${bindLink}\n\n` +
      `2️⃣ In claude.ai: Settings → Connectors → Add custom connector, and paste:\n${remoteMcpUrl.replace(/\/$/, "")}/mcp\n\n` +
      `Then ask Claude to "recall what the group decided". Your memory is read inside a secure enclave — the key never leaves it.\n\n` +
      `Prefer self-custody / Claude Desktop? Use /connect instead.`,
  );
});

// --- /recall <query> (demo/debug) ---
bot.command("recall", async (ctx) => {
  const query = ctx.message.text.replace(/^\/recall(@\S+)?\s*/, "").trim();
  if (!query) return ctx.reply("Usage: /recall <what do you want to remember?>");
  const rec = await resolveGroup(ctx);
  if (!rec) return;
  const memwal = makeMemwal({ key: rec.botDelegateKey, accountId: rec.accountId, network, serverUrl, namespace: rec.namespace });
  const res = await memwal.recall({ query, namespace: rec.namespace, limit: 4, maxDistance: 0.75 });
  if (res.results.length === 0) return ctx.reply("🤔 Nothing relevant in the group memory yet.");
  await ctx.reply(`🧠 From the group's memory:\n\n${res.results.map((r) => `• ${r.text}`).join("\n")}`);
});

// --- /save (reply to a message to remember it) ---
bot.command("save", async (ctx) => {
  const replied = (ctx.message as any).reply_to_message;
  const text: string | undefined = replied?.text;
  if (!text) return ctx.reply("Reply to a text message with /save to remember it.");
  const rec = await resolveGroup(ctx);
  if (!rec) return;
  await ingestText({ record: rec, network, serverUrl }, text, "fact");
  await react(ctx, "✅");
});

// --- text: explicit "remember:" trigger (high precision for v1) ---
bot.on("text", async (ctx) => {
  const text = ctx.message.text;

  // Primary UX: @-mention the bot — "@HiveMindBot we ship on June 21".
  // Strip every @mention of the bot from the text; the remainder is the fact.
  const me = `@${ctx.me}`.toLowerCase();
  const mentions = (ctx.message.entities ?? []).filter(
    (e) => e.type === "mention" && text.slice(e.offset, e.offset + e.length).toLowerCase() === me,
  );
  const repliedToBot =
    (ctx.message as any).reply_to_message?.from?.id === ctx.botInfo?.id;

  let fact: string | null = null;
  if (mentions.length > 0) {
    // Remove the mention spans (back-to-front so offsets stay valid).
    let stripped = text;
    for (const e of [...mentions].sort((a, b) => b.offset - a.offset)) {
      stripped = stripped.slice(0, e.offset) + stripped.slice(e.offset + e.length);
    }
    fact = stripped.replace(/\s+/g, " ").trim();
  } else if (repliedToBot && !text.startsWith("/")) {
    fact = text.trim(); // reply to the bot = remember this
  } else if (/^remember:/i.test(text)) {
    fact = text.replace(/^remember:\s*/i, "").trim(); // legacy alias
  }

  if (fact == null) return;
  if (!fact) {
    // Mentioned with no content — guide instead of silently ignoring.
    return void ctx.reply("🐝 Tag me with the thing to remember, e.g. “@" + ctx.me + " we ship on June 21”.").catch(() => {});
  }
  const rec = await resolveGroup(ctx);
  if (!rec) return;
  await ingestText({ record: rec, network, serverUrl }, fact, "fact");
  await react(ctx, "✅");
});

bot.catch((err, ctx) => console.error(`bot error (${ctx.updateType}):`, err));

// Start polling, tolerating a transient 409 ("terminated by other getUpdates").
// On a redeploy/restart Render briefly runs the old + new instance at once, so the
// new one's getUpdates conflicts with the old's until Render tears the old down.
// The HTTP backend (above) is already listening, so Render sees us healthy and
// retires the old instance; we just retry the poll until the token is free —
// exiting here would deadlock the deploy (Render never promotes a crashed instance).
async function launchWithRetry(): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await bot.launch(() => console.log("🐝 HiveMind bot running. Add it to a group (privacy mode OFF)."));
      return; // resolves only on graceful stop
    } catch (e) {
      const msg = (e as Error)?.message ?? String(e);
      if (/already launched/i.test(msg)) return; // polling is in fact running
      if (/409|conflict/i.test(msg) && attempt <= 24) {
        console.warn(`Telegram 409 (another poller — likely a deploy overlap). Retry ${attempt} in 5s…`);
        await new Promise((r) => setTimeout(r, 5000));
        continue;
      }
      console.error(`❌ Failed to reach Telegram: ${msg}`);
      console.error("   Check network access to api.telegram.org and that BOT_TOKEN is valid.");
      process.exit(1);
    }
  }
}
// Prefer WEBHOOK mode when a public URL is known (Render injects RENDER_EXTERNAL_URL).
// Telegram pushes updates → no polling, so 409 conflicts are impossible and the
// free-tier sleep is moot (an update wakes the service). Setting a webhook also
// evicts any stale getUpdates poller. Falls back to long-polling for local dev.
const publicUrl = (env.BOT_PUBLIC_URL ?? env.RENDER_EXTERNAL_URL ?? "").replace(/\/$/, "");
if (publicUrl) {
  const hookId = createHash("sha256").update(BOT_TOKEN).digest("hex").slice(0, 24);
  const hookPath = `/tg/${hookId}`;
  const secretToken = createHash("sha256").update("hivemind-webhook:" + BOT_TOKEN).digest("hex");
  onboard.useWebhook(hookPath, bot.webhookCallback(hookPath, { secretToken }));
  onboard.listen(apiPort);
  // Fetch botInfo first (powers ctx.me for @mention capture — launch() would set it
  // in polling mode), then register the webhook.
  bot.telegram
    .getMe()
    .then((me) => {
      bot.botInfo = me;
      return bot.telegram.setWebhook(`${publicUrl}${hookPath}`, {
        secret_token: secretToken,
        drop_pending_updates: true,
      });
    })
    .then(() => console.log(`🐝 HiveMind bot via webhook → ${publicUrl}${hookPath} (as @${bot.botInfo?.username})`))
    .catch((e: Error) => {
      console.error(`❌ setWebhook failed: ${e.message}`);
      process.exit(1);
    });
} else {
  onboard.listen(apiPort);
  void launchWithRetry();
}
process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
