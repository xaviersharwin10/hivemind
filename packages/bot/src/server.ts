/**
 * Onboarding backend for the bot. Tiny node:http server (no extra deps).
 *
 *  - issueToken(chatId)          → one-time token for an onboarding link
 *  - POST /onboard/complete      ← the SPA posts the created account here
 *
 * The owner key never touches this server — only the bot's delegate key + the
 * account id come back, which is exactly what the bot needs to write memory.
 */

import { createServer, type IncomingMessage } from "node:http";
import { randomUUID } from "node:crypto";
import { EnokiClient } from "@mysten/enoki";
import type { Registry, SuiNetwork } from "@hivemind/core";

interface Pending {
  chatId: string;
  createdAt: number;
}

/** A pending Flow-3 member connection, awaiting owner approval. */
export interface ConnectInfo {
  chatId: string;
  requesterUserId: number;
  requesterName: string;
  memberPrivKey: string;
  memberPubKeyHex: string;
  label: string;
  accountId: string;
  createdAt: number;
  /** True when this approval authorizes the shared ENCLAVE delegate (claude.ai
   *  TEE), not a personal member key — no private key is delivered. */
  enclaveEnable?: boolean;
}

export interface SponsorConfig {
  /** Enoki PRIVATE api key (enoki_private_...). Server-side only. */
  apiKey?: string;
  network: SuiNetwork;
  /** Move call targets this onboarding is allowed to sponsor. */
  allowedMoveCallTargets: string[];
}

const TOKEN_TTL_MS = 30 * 60 * 1000; // 30 min

export class OnboardServer {
  private pending = new Map<string, Pending>();
  private connectPending = new Map<string, ConnectInfo>();
  private enoki?: EnokiClient;
  /** Optional Telegram webhook: when set, POSTs to this path are handed to telegraf. */
  private webhook?: { path: string; handler: (req: IncomingMessage, res: import("node:http").ServerResponse) => void };

  /** Register the Telegram webhook handler (call before listen). */
  useWebhook(path: string, handler: (req: IncomingMessage, res: import("node:http").ServerResponse) => void): void {
    this.webhook = { path, handler };
  }

  constructor(
    private readonly registry: Registry,
    private readonly onComplete: (chatId: string, accountId: string) => Promise<void>,
    /** Enoki gas-station config — we sponsor onboarding txs directly (the public relayer won't). */
    private readonly sponsor: SponsorConfig,
    /** Flow 3: called after the owner approves a member's delegate; delivers the key. */
    private readonly onConnectComplete: (info: ConnectInfo) => Promise<void>,
    /** Deterministic bot delegate for a chat (null if no master seed configured).
     *  The SPA fetches the derived key to authorize that exact address on-chain. */
    private readonly botDelegateFor?: (
      chatId: string,
    ) => { privateKey: string; publicKeyHex: string; suiAddress: string } | null,
  ) {
    if (sponsor.apiKey) this.enoki = new EnokiClient({ apiKey: sponsor.apiKey });
  }

  issueToken(chatId: string): string {
    const token = randomUUID();
    this.pending.set(token, { chatId: String(chatId), createdAt: Date.now() });
    return token;
  }

  issueConnectToken(info: Omit<ConnectInfo, "createdAt">): string {
    const token = randomUUID();
    this.connectPending.set(token, { ...info, createdAt: Date.now() });
    return token;
  }

  private async readRaw(req: IncomingMessage): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    return Buffer.concat(chunks).toString("utf8");
  }

  private async readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
    return JSON.parse((await this.readRaw(req)) || "{}");
  }

  /** Sponsor a transaction via our own Enoki gas station and return { bytes, digest }. */
  private async sponsorCreate(req: IncomingMessage, res: import("node:http").ServerResponse) {
    if (!this.enoki) return json(res, 500, { error: "ENOKI_PRIVATE_API_KEY not set — cannot sponsor onboarding." });
    try {
      const body = await this.readJson(req);
      const result = await this.enoki.createSponsoredTransaction({
        network: this.sponsor.network,
        transactionKindBytes: String(body.transactionBlockKindBytes ?? ""),
        sender: String(body.sender ?? ""),
        allowedAddresses: [String(body.sender ?? "")],
        allowedMoveCallTargets: this.sponsor.allowedMoveCallTargets,
      });
      json(res, 200, { bytes: result.bytes, digest: result.digest });
    } catch (e) {
      json(res, 502, { error: `enoki sponsor failed: ${enokiError(e)}` });
    }
  }

  /** Execute a sponsored, user-signed transaction via Enoki and return { digest }. */
  private async sponsorExecute(req: IncomingMessage, res: import("node:http").ServerResponse) {
    if (!this.enoki) return json(res, 500, { error: "ENOKI_PRIVATE_API_KEY not set." });
    try {
      const body = await this.readJson(req);
      const result = await this.enoki.executeSponsoredTransaction({
        digest: String(body.digest ?? ""),
        signature: String(body.signature ?? ""),
      });
      json(res, 200, { digest: result.digest });
    } catch (e) {
      json(res, 502, { error: `enoki execute failed: ${enokiError(e)}` });
    }
  }

  listen(port: number): void {
    createServer(async (req, res) => {
      // Telegram webhook (if configured): hand the raw request to telegraf before
      // we touch the body or set CORS. Telegram pushes updates here, so the bot
      // never polls (no getUpdates → no 409 conflicts).
      if (this.webhook && req.method === "POST" && req.url === this.webhook.path) {
        this.webhook.handler(req, res);
        return;
      }

      // CORS — the SPA is served from another origin (localhost:5173).
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
      res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
      if (req.method === "OPTIONS") return res.writeHead(204).end();

      // Enoki gas-station sponsorship (browser → here → Enoki).
      if (req.method === "POST" && req.url === "/sponsor") return this.sponsorCreate(req, res);
      if (req.method === "POST" && req.url === "/sponsor/execute") return this.sponsorExecute(req, res);

      // Deterministic onboarding: SPA fetches the bot's derived delegate (gated by
      // the one-time onboarding token) so it can authorize that exact address on-chain.
      if (req.method === "GET" && req.url?.startsWith("/bot-delegate")) {
        const q = new URL(req.url, "http://x").searchParams;
        const token = q.get("token") ?? "";
        const pend = this.pending.get(token);
        if (!pend || Date.now() - pend.createdAt > TOKEN_TTL_MS) {
          return json(res, 404, { error: "Invalid or expired onboarding token." });
        }
        const d = this.botDelegateFor?.(pend.chatId);
        if (!d) return json(res, 501, { error: "Deterministic delegates not enabled (no BOT_MASTER_SEED)." });
        return json(res, 200, { privateKey: d.privateKey, publicKeyHex: d.publicKeyHex, suiAddress: d.suiAddress });
      }

      // Flow 3: approver SPA fetches what to add; then reports completion.
      if (req.method === "GET" && req.url?.startsWith("/connect/info")) {
        const token = new URL(req.url, "http://x").searchParams.get("token") ?? "";
        const info = this.connectPending.get(token);
        if (!info || Date.now() - info.createdAt > TOKEN_TTL_MS) {
          return json(res, 404, { error: "Invalid or expired connect request." });
        }
        return json(res, 200, {
          accountId: info.accountId,
          memberPublicKey: info.memberPubKeyHex,
          label: info.label,
          requesterName: info.requesterName,
          network: this.sponsor.network,
        });
      }
      if (req.method === "POST" && req.url === "/connect/complete") {
        try {
          const body = await this.readJson(req);
          const token = String(body.token ?? "");
          const info = this.connectPending.get(token);
          if (!info || Date.now() - info.createdAt > TOKEN_TTL_MS) {
            return json(res, 400, { error: "Invalid or expired connect request." });
          }
          this.connectPending.delete(token);
          await this.onConnectComplete(info);
          return json(res, 200, { ok: true });
        } catch (e) {
          return json(res, 500, { error: (e as Error).message });
        }
      }

      if (req.method === "POST" && req.url === "/onboard/complete") {
        try {
          const body = await this.readJson(req);
          const token = String(body.token ?? "");
          const pend = this.pending.get(token);
          if (!pend || Date.now() - pend.createdAt > TOKEN_TTL_MS) {
            return json(res, 400, { error: "Invalid or expired onboarding token." });
          }
          const accountId = String(body.accountId ?? "");
          const ownerAddress = String(body.ownerAddress ?? "");
          const botDelegateKey = String(body.botDelegateKey ?? "");
          const onchainGroupId = body.onchainGroupId ? String(body.onchainGroupId) : undefined;
          if (!accountId || !ownerAddress || !botDelegateKey) {
            return json(res, 400, { error: "Missing accountId / ownerAddress / botDelegateKey." });
          }

          await this.registry.upsert({
            groupId: pend.chatId,
            ownerAddress, // creator's zkLogin address — NO owner secret stored (Option B)
            accountId,
            botDelegateKey,
            onchainGroupId,
            // Per-group namespace (= chat id) so one creator's multiple groups keep
            // separate memory pools + separate Seal keys under the same account.
            namespace: pend.chatId,
          });
          this.pending.delete(token);
          await this.onComplete(pend.chatId, accountId);
          return json(res, 200, { ok: true });
        } catch (e) {
          return json(res, 500, { error: (e as Error).message });
        }
      }

      json(res, 404, { error: "not found" });
    }).listen(port, () => console.log(`🛠️  onboarding backend on :${port}`));
  }
}

function json(res: import("node:http").ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

/** The Enoki SDK hides the real reason in error.cause — surface it. */
function enokiError(e: unknown): string {
  const err = e as Error & { cause?: { message?: string } };
  const cause = err?.cause?.message;
  return cause ? `${err.message} — ${cause}` : (err?.message ?? String(e));
}
