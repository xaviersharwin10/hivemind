# 🐝 HiveMind

> Turn ephemeral group chats into a verifiable, portable AI memory lake — with zero user friction.

**Sui Overflow 2026 · Walrus track.** Built on Walrus (verifiable storage), MemWal (Walrus Memory), Seal, zkLogin, and Enoki.

---

## The problem

Group chats are a black hole for data. Decisions, PDFs, links, and receipts get buried within hours. When you later want an AI (Claude, Cursor) to act on what the group decided, you're stuck hunting down files and copy-pasting hundreds of messages to rebuild context in another app.

## What HiveMind does

You invite `@HiveMind_Bot` into your existing Telegram group. It sits in the background and turns the group's decisions and shared files into a **verifiable, portable memory** stored on Walrus — owned by the group creator, not us.

Later, any MCP-compatible AI tool (Claude Desktop, Cursor) plugs into that memory and can **recall the group's decisions and read the original files** — without anyone copy-pasting a thing.

```
Telegram group  ──►  HiveMind bot  ──►  Walrus (files) + MemWal (memory)
                                              │
   "Write the server based on what we         ▼
    decided in Telegram today."  ◄──  Claude / Cursor  (via MCP)
```

## Why it fits the Walrus track

The track asks for exactly three things, and HiveMind is built around all three:

- **Cross-tool / cross-agent memory sharing** — a Telegram bot writes memory; a separate local AI reads it. Two runtimes, one shared on-chain memory pool.
- **Artifact-driven workflows** — files dropped in chat become Walrus blobs with cryptographic integrity, referenced from memory; the AI reads the *real* document.
- **Multi-agent coordination** — ingestion and execution agents coordinate asynchronously through durable, shared memory.

## Data ownership (the key design)

Each group's memory lives in its own **`MemWalAccount` on Sui, owned by the group creator's Google identity via zkLogin** — no key ever touches our backend. Onboarding gas is sponsored by Enoki, so creators need no SUI. Access is granted by **delegate keys** the owner controls; revoking a member or freezing the whole group is an on-chain action only the owner can take.

---

## Status — what's working (proven on Sui testnet)

| Flow | What it does | State |
|---|---|---|
| **On-chain registry (our Move pkg)** | `hivemind::registry` indexes groups + a verifiable artifact manifest (SHA-256 anchors) on Sui | ✅ deployed + live E2E |
| **Onboarding** | Creator owns a per-group `MemWalAccount` via Google zkLogin (Enoki-sponsored) **and the group is registered on-chain** | ✅ live E2E |
| **Ingestion** | files → Seal-encrypted Walrus blob + MemWal memory + **on-chain artifact manifest** (bot-signed, Enoki-sponsored) | ✅ live |
| **Seal-encrypted artifacts** | Files are Seal-encrypted before Walrus; decryption gated by the group's on-chain `seal_approve` | ✅ live E2E |
| **Member handoff** | `/connect` → owner approves → member gets a delegate key + MCP config | ✅ live |
| **`hivemind-read` MCP** | Claude/Cursor recall group memory + read (decrypt) the original Walrus files | ✅ live |

The sections below cover the full design, the MemWal permission model, and the decisions behind it.

---

## Repo layout

```
packages/
  contracts/ our own Sui Move package (hivemind::registry): on-chain group index
             + tamper-evident artifact manifest with SHA-256 integrity anchors
  core/      shared logic: MemWal client, Walrus up/download, Seal, ingestion,
             zkLogin/Enoki onboarding txs, on-chain registry client (chain.ts)
  bot/       Telegram bot + onboarding/sponsorship/handoff backend (:8080)
  onboard/   Vite + dapp-kit + Enoki SPA: Google sign-in → sponsored onboarding / member approval
  mcp/       hivemind-read MCP server (publishable npm pkg hivemind-memory-mcp):
             recall() + read_artifact() with PDF/text extraction
scripts/     flow1/flow2 (account + ingestion), seal-test, chain-test — runnable proofs
```

### Our on-chain contract (Sui testnet)

`hivemind::registry` — **package [`0xe9a1e57c…896d8e`](https://suiscan.xyz/testnet/object/0xe9a1e57c815cb1f2bd8c54d1c5973b0f9c565e5c3fbacffae8d47c7052896d8e)**, shared `Registry` `0xb058138c…347daa`.
It maps a chat id → its `Group`, ties the group to its `MemWalAccount`, and holds an
append-only **artifact manifest** (Walrus blob id + name + mime + SHA-256 + sealed flag).
This replaces a backend JSON file: the group→memory link and every shared file are
now verifiable on-chain — anyone can check a Walrus blob against its committed hash.
Source + tests in [packages/contracts/hivemind](packages/contracts/hivemind).

## Running it

Prereqs: Node 20+, pnpm. Copy `.env.example` → `.env` and fill in:
`BOT_TOKEN` (BotFather), `GOOGLE_CLIENT_ID` + `ENOKI_API_KEY` (public, for the SPA),
`ENOKI_PRIVATE_API_KEY` (server-side sponsorship). The SPA reads its own `packages/onboard/.env`.

```bash
pnpm install
pnpm bot        # Telegram bot + onboarding backend on :8080
pnpm onboard    # onboarding SPA on :5173 (second terminal)
```

**BotFather setup:** `/newbot` → token; `/setprivacy` → **Disable** (so the bot sees group messages).

**Use it:**
1. Add the bot to a Telegram group → it DMs the creator an onboarding link.
2. Creator opens it → **Sign in with Google** → their group account is created (gas sponsored, they own it).
3. In the group: drop a file or type `remember: we're using Postgres`. `/recall postgres` reads it back.
4. A member types `/connect` → owner approves → member is DMed a delegate key + `claude_desktop_config.json`.
5. Paste that into Claude → ask *"recall what the group decided and read the spec file."*

### Connecting an AI (MCP)

The `hivemind-read` server (`recall` + `read_artifact`) ships as a standalone npm package, so a member can run it on any machine with no checkout:

```jsonc
// claude_desktop_config.json
{ "mcpServers": { "hivemind": {
  "command": "npx", "args": ["-y", "hivemind-memory-mcp"],
  "env": { "HIVEMIND_DELEGATE_KEY": "…", "HIVEMIND_ACCOUNT_ID": "0x…",
           "HIVEMIND_NAMESPACE": "<chat id>", "HIVEMIND_NETWORK": "testnet" }
}}}
```

`read_artifact` decrypts the Seal-encrypted blob and **extracts readable text** (PDF → text), so the AI reads the real document. The `/connect` flow DMs a member this exact config pre-filled. (Set the bot env `MCP_PACKAGE=hivemind-memory-mcp` once published; otherwise it falls back to the in-repo path — see [.mcp.json.example](.mcp.json.example).)

**Publishing the MCP server:** `cd packages/mcp && pnpm build && npm publish --access public` (the package is `hivemind-memory-mcp`; needs an npm token with **2FA bypass** enabled, or run it on a machine where you can enter your 2FA OTP).

### Runnable proofs (no Telegram needed)

```bash
pnpm flow1       # create/reuse a MemWalAccount + delegate, remember→recall round-trip
pnpm flow2       # file→Walrus→memory, text→memory, recall, artifact read-back
pnpm seal-test       # plaintext→Seal encrypt→Walrus (ciphertext only)→decrypt via seal_approve
pnpm chain-test      # our Move pkg: register_group + record_artifact + read manifest, live on testnet
pnpm namespace-test  # two groups, one account → each recalls only its own memory (no leakage)
```

Contract build/test: `cd packages/contracts/hivemind && sui move test`.

---

## Honest limitations / roadmap

- **Per-group memory under a shared account.** A Sui address can own exactly one `MemWalAccount`, so a creator's multiple groups share one account — but each group has its **own namespace** (its chat id), so memories and Seal keys are separated per group and recall never mixes them (proven by `pnpm namespace-test`). The residual edge — a *malicious, technical* member of one group deliberately targeting another of the *same creator's* groups via the account-wide delegate — is the kind of thing production handles with server-side permissions (as every real app does); full cryptographic per-group isolation (per-group owner accounts) is a roadmap item, deliberately deferred because it trades everyday usability/recoverability for purity most users don't need.
- **Adding a member needs the creator to approve** (owner-only `add_delegate_key`) — inherent to "no one but you holds the keys."
- Telegram-only ingestion in v1; Discord/email forwarders are a roadmap slide.

## Built with

Sui Move · [Walrus](https://walrus.xyz) · [MemWal / Walrus Memory](https://github.com/MystenLabs/MemWal) · [Seal](https://seal.mystenlabs.com) · zkLogin · [Enoki](https://portal.enoki.mystenlabs.com) · [MCP](https://modelcontextprotocol.io) · TypeScript · telegraf · React/Vite
