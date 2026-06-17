# 🐝 HiveMind

> Turn ephemeral group chats into a verifiable, portable AI memory lake — with zero user friction.

**Sui Overflow 2026 · Walrus track.** Built on Walrus (verifiable storage), MemWal (Walrus Memory), Seal, zkLogin, and Enoki.

---

## The problem

Group chats are a black hole for data. Decisions, PDFs, links, and receipts get buried within hours. When you later want an AI (Claude, Cursor) to act on what the group decided, you're stuck hunting down files and copy-pasting hundreds of messages to rebuild context in another app.

## What HiveMind does

You invite `@HiveMind_Bot` into your existing Telegram group. It sits in the background and turns the group's decisions and shared files into a **verifiable, portable memory** stored on Walrus — owned by the group creator, not us.

Later, any MCP-compatible AI tool (Claude Desktop, Cursor) plugs into that memory and can **recall the group's decisions and read the original files** — without anyone copy-pasting a thing.

## Architecture

![HiveMind architecture](docs/architecture.png)

A **capture** path (Telegram → bot) and a **recall** path (your AI → a local MCP server) converge on one **group-owned, verifiable memory** — Seal-encrypted files on Walrus plus MemWal semantic memory — all anchored and access-gated on Sui by our `hivemind::registry` Move package (zkLogin sign-in, Enoki gas sponsorship, SHA-256 file manifest, delegate-key access). Two runtimes, one shared memory; the original plaintext is only ever decrypted on the member's own machine.

## Why it fits the Walrus track

The track asks for exactly three things, and HiveMind is built around all three:

- **Cross-tool / cross-agent memory sharing** — a Telegram bot writes memory; a separate local AI reads it. Two runtimes, one shared on-chain memory pool.
- **Artifact-driven workflows** — files dropped in chat become Walrus blobs with cryptographic integrity, referenced from memory; the AI reads the *real* document.
- **Multi-agent coordination** — ingestion and execution agents coordinate asynchronously through durable, shared memory.

## Data ownership (the key design)

Each group's memory lives in its own **`MemWalAccount` on Sui, owned by the group creator's Google identity via zkLogin** — no key ever touches our backend. Onboarding gas is sponsored by Enoki, so creators need no SUI. Access is granted by **delegate keys** the owner controls; revoking a member or freezing the whole group is an on-chain action only the owner can take.

---

## Who it's for — value at a glance

**Value proposition:** group chats are where decisions actually happen — and where they're instantly lost. HiveMind turns that throwaway context into a **verifiable, portable memory the group owns**, so any AI can act on what was decided without a human re-assembling context by hand.

| User Persona | Real-World Scenario | Quantifiable Impact |
|---|---|---|
| **Early-stage startup / small dev team** | Architecture and product calls get made in the Telegram group, then buried. To get Claude or Cursor to build the agreed design, someone re-pastes scattered messages and re-uploads the spec into every new AI session. | **~3–5 hrs/week per dev** reclaimed from rebuilding context; every new AI session starts with full project memory in seconds, not minutes of copy-paste. |
| **Freelance agency ↔ client group** | Clients drop briefs, brand assets and `final_v3.pdf` into the chat; weeks later nobody can find which file or which decision was approved, sparking scope disputes. | Every file is **hash-anchored and recallable on demand** — kills "where's that file?" churn and scope-creep arguments; approvals resolved by proof, faster sign-off. |
| **Web3 DAO / community organizer** | Governance and treasury decisions happen in Telegram with no durable, tamper-proof record; members later dispute "what was actually agreed." | A **verifiable, on-chain-anchored decision log** — disputes settled by cryptographic proof, not memory; full auditable history with zero extra tooling. |
| **Distributed team across time zones** | Decisions get made while half the team sleeps; the other half spends the morning catching up or pinging around for context. | Replaces async catch-up threads — recall the night's decisions instantly; **~2–3 fewer sync calls/week** spent just re-establishing context. |
| **Hackathon / student build team** | A fast 2–4 person team builds with AI on different laptops; each person's Claude/Cursor has no idea what the others decided or which files were shared. | A new teammate's AI is productive in **under 1 minute** from a single config paste — one shared, portable memory across every machine, no re-onboarding. |
| **Open-source maintainer / mod team** | Design rationale and shared resources live in chat history a new contributor can't search; maintainers re-explain the same context again and again. | New-contributor ramp from **days to minutes** — their AI reads the group's real decisions and documents directly; far less repeated maintainer hand-holding. |

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
| **Confidential remote MCP (Nautilus TEE)** | recall runs **inside an AWS Nitro enclave** that holds the key; results are enclave-signed and verified before use — unlocks zero-install **claude.ai** connectors without the operator ever seeing plaintext | 🧪 local PoC proven (Rust enclave + Move verifier + MCP-over-HTTP front, real recall vs testnet); OAuth + AWS deploy pending |

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
             recall() + read_artifact() with PDF/text extraction (local, self-custody)
  remote-mcp/ claude.ai-facing MCP-over-HTTP server: proxies recall to the
             Nautilus enclave and verifies the enclave's attestation signature
enclave/     Nautilus (AWS Nitro TEE) confidential MCP:
             src/nautilus-server/src/apps/hivemind  Rust app — attested recall over MemWal
             move/hivemind-app                       Move pkg — enclave registration + verifier
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

## Confidential remote MCP (Nautilus TEE)

The local MCP gives **full self-custody** (the key and decryption stay on your machine) but needs an MCP-capable desktop app. To reach **claude.ai** (zero-install, the widest audience) the decryption has to happen server-side — which normally means the operator could read your group's memory. We close that gap with a **Trusted Execution Environment** via Sui's [**Nautilus**](https://docs.sui.io/concepts/cryptography/nautilus):

```
claude.ai ──MCP/HTTP──► remote-mcp ──► Nautilus enclave (AWS Nitro) ──► MemWal
                            ▲                  holds key, decrypts,        │
                            └── verifies enclave signature ──  signs result┘
                                          (on-chain registered PCRs + pubkey)
```

- The **enclave** (`enclave/src/nautilus-server/src/apps/hivemind`, Rust) holds the delegate key, queries MemWal, and returns an **enclave-signed** recall result. The operator, host, even root **cannot read enclave memory** — so "not even us" holds even for the web tier.
- The **Move package** (`enclave/move/hivemind-app`) registers the enclave on-chain (PCRs + pubkey from its attestation) and verifies its signed responses.
- The **remote MCP** (`packages/remote-mcp`) speaks claude.ai's Streamable-HTTP transport, proxies recall to the enclave, and **cryptographically verifies the enclave's signature (BCS + Ed25519) before returning anything** — refusing unverified memory.

**Status:** the full path is **proven on the free local loop** — the Rust enclave does real recall against the testnet relayer, and an MCP client pulls verified, attested results end to end. Remaining to go live: claude.ai **OAuth** and the **real AWS Nitro enclave + on-chain attestation**.

Reproduce the local loop (no AWS needed):

```bash
# 1) build + run the enclave app locally (debug; real attestation needs Nitro hardware)
cd enclave/src/nautilus-server
API_KEY=unused MEMWAL_SERVER_URL=https://relayer-staging.memory.walrus.xyz \
  HIVEMIND_ACCOUNT_ID=0x… HIVEMIND_DELEGATE_KEY=… \
  cargo run --features hivemind          # :3000

# 2) run the claude.ai-facing remote MCP, pointed at the enclave
ENCLAVE_URL=http://localhost:3000 HIVEMIND_NAMESPACE=<chat id> \
  pnpm --filter @hivemind/remote-mcp start    # :8787

# 3) drive it with an MCP client → verified, attested recall
pnpm --filter @hivemind/remote-mcp test-client "what did we decide?"
```

Move build: `cd enclave/move/hivemind-app && sui move build`.

---

## Honest limitations / roadmap

- **Per-group memory under a shared account.** A Sui address can own exactly one `MemWalAccount`, so a creator's multiple groups share one account — but each group has its **own namespace** (its chat id), so memories and Seal keys are separated per group and recall never mixes them (proven by `pnpm namespace-test`). The residual edge — a *malicious, technical* member of one group deliberately targeting another of the *same creator's* groups via the account-wide delegate — is the kind of thing production handles with server-side permissions (as every real app does); full cryptographic per-group isolation (per-group owner accounts) is a roadmap item, deliberately deferred because it trades everyday usability/recoverability for purity most users don't need.
- **Adding a member needs the creator to approve** (owner-only `add_delegate_key`) — inherent to "no one but you holds the keys."
- Telegram-only ingestion in v1; Discord/email forwarders are a roadmap slide.
- **Confidential remote MCP (Nautilus TEE)** — local PoC proven (Rust enclave + Move verifier + attestation-verifying MCP-HTTP front, real recall vs testnet); going live needs claude.ai OAuth + a real AWS Nitro enclave with on-chain attestation. This is the path to a zero-install **claude.ai** connector that keeps "not even us" confidentiality on the web tier.

## Built with

Sui Move · [Walrus](https://walrus.xyz) · [MemWal / Walrus Memory](https://github.com/MystenLabs/MemWal) · [Seal](https://seal.mystenlabs.com) · [Nautilus (TEE)](https://docs.sui.io/concepts/cryptography/nautilus) · zkLogin · [Enoki](https://portal.enoki.mystenlabs.com) · [MCP](https://modelcontextprotocol.io) · Rust · TypeScript · telegraf · React/Vite
