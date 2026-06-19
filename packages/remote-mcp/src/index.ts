/**
 * hivemind-remote-mcp — the claude.ai-facing half of the confidential MCP.
 *
 * claude.ai's Custom Connectors speak MCP over **Streamable HTTP** (remote),
 * which our local stdio server can't satisfy. This server does:
 *
 *   claude.ai ──MCP/HTTP──► this server ──HTTP──► Nautilus enclave (/process_data)
 *
 * The enclave holds the delegate key, queries MemWal, and returns an ATTESTED,
 * enclave-signed recall result. This server forwards the query and relays the
 * signed result — it never holds the delegate key or sees a decryption key.
 *
 * Phase 1 (this file): the MCP/HTTP transport + recall tool proxying to the
 * enclave. OAuth (claude.ai's auth handshake) and on-server signature
 * verification are layered next.
 *
 * Config (env):
 *   ENCLAVE_URL         — the enclave's base URL (default http://localhost:3000)
 *   HIVEMIND_NAMESPACE  — the group's MemWal namespace (the chat id)
 *   PORT                — listen port (default 8787)
 */

import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { bcs } from "@mysten/bcs";
import * as ed from "@noble/ed25519";
import { z } from "zod";
import { authEnabled, handleWellKnown, requireAuth, verifySessionSubject } from "./auth.js";
import { verifyBindToken, addBinding, getBindings, type Binding } from "./binding.js";

const ENCLAVE_URL = (process.env.ENCLAVE_URL ?? "http://localhost:3000").replace(/\/$/, "");
// Local dev fallback (auth OFF): a single group. With auth ON the group comes
// from the caller's Stytch binding, never these env vars.
const NAMESPACE = process.env.HIVEMIND_NAMESPACE ?? "";
const ACCOUNT_ID = process.env.HIVEMIND_ACCOUNT_ID ?? "";
const PORT = Number(process.env.PORT ?? 8787);
// In production this MUST be the enclave key registered ON-CHAIN (from the
// attestation), not whatever a server claims. For the local loop we fall back
// to fetching it from the enclave's /health_check.
const ENCLAVE_PUBKEY_ENV = process.env.ENCLAVE_PUBKEY;

const RECALL_INTENT = 0;

/** BCS layout — must match the Rust enclave app and the Move verifier exactly. */
const RecallHitBcs = bcs.struct("RecallHit", { text: bcs.string(), relevance_bps: bcs.u16() });
const RecallResponseBcs = bcs.struct("RecallResponse", {
  namespace: bcs.string(),
  hits: bcs.vector(RecallHitBcs),
});
const IntentMessageBcs = bcs.struct("IntentMessage", {
  intent: bcs.u8(),
  timestamp_ms: bcs.u64(),
  data: RecallResponseBcs,
});

function hexToBytes(hex: string): Uint8Array {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Shape of the enclave's signed /process_data response. */
interface EnclaveRecall {
  response: {
    intent: number;
    timestamp_ms: number;
    data: { namespace: string; hits: { text: string; relevance_bps: number }[] };
  };
  signature: string;
}

let cachedPubkey: string | undefined = ENCLAVE_PUBKEY_ENV;
async function enclavePubkey(): Promise<string> {
  if (cachedPubkey) return cachedPubkey;
  const r = await fetch(`${ENCLAVE_URL}/health_check`);
  const j = (await r.json()) as { pk: string };
  cachedPubkey = j.pk;
  return cachedPubkey;
}

/** Re-derive the signed bytes and verify the enclave's Ed25519 signature. */
async function verifyAttestation(out: EnclaveRecall): Promise<boolean> {
  if (out.response.intent !== RECALL_INTENT) return false;
  const msg = IntentMessageBcs.serialize({
    intent: out.response.intent,
    timestamp_ms: out.response.timestamp_ms,
    data: out.response.data,
  }).toBytes();
  const sig = hexToBytes(out.signature);
  const pk = hexToBytes(await enclavePubkey());
  try {
    return await ed.verifyAsync(sig, msg, pk);
  } catch {
    return false;
  }
}

async function enclaveRecall(
  accountId: string,
  namespace: string,
  query: string,
  limit: number,
): Promise<EnclaveRecall> {
  const r = await fetch(`${ENCLAVE_URL}/process_data`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ payload: { account_id: accountId, namespace, query, limit } }),
  });
  if (!r.ok) throw new Error(`enclave ${r.status}: ${await r.text()}`);
  return (await r.json()) as EnclaveRecall;
}

/**
 * A fresh MCP server with the recall tool wired to the enclave.
 *
 * `subject` is the authenticated Stytch user id (when auth is on). The target
 * group is resolved from that user's binding — never from the request — so each
 * caller can only reach their own group. With auth off, falls back to the local
 * dev env group.
 */
function makeMcpServer(subject?: string): McpServer {
  const server = new McpServer({ name: "hivemind-remote", version: "0.1.0" });

  server.registerTool(
    "recall",
    {
      title: "Recall group memory (confidential, attested)",
      description:
        "Semantic search over a Telegram group's HiveMind memory — decisions, facts, and shared-file contents. " +
        "The search runs inside a confidential TEE enclave that holds the group's key; results are signed by the enclave.",
      inputSchema: {
        query: z.string().describe("What to look for, in plain language"),
        limit: z.number().int().min(1).max(20).optional().describe("Max results (default 5)"),
        group: z
          .string()
          .optional()
          .describe("Optional: restrict to one group by name (label or namespace). Omit to search all your groups."),
      },
    },
    async ({ query, limit, group }) => {
      // Resolve the caller's group(s) from their verified identity (auth on) or the
      // local dev env (auth off). The user never supplies account ids — only an
      // optional group name to filter the groups they're already bound to.
      let groups: Binding[];
      if (authEnabled) {
        if (!subject) {
          return { isError: true, content: [{ type: "text", text: "Not authenticated." }] };
        }
        groups = await getBindings(subject);
        if (groups.length === 0) {
          return {
            content: [
              {
                type: "text",
                text:
                  "This Claude account isn't linked to a HiveMind group yet. In your group's Telegram, run /connect_claude and open the bind link, then try again.",
              },
            ],
          };
        }
        if (group) {
          const want = group.toLowerCase();
          const filtered = groups.filter(
            (g) => (g.label ?? g.namespace).toLowerCase() === want || g.namespace.toLowerCase() === want,
          );
          if (filtered.length === 0) {
            const names = groups.map((g) => g.label ?? g.namespace).join(", ");
            return { content: [{ type: "text", text: `No bound group named "${group}". Your groups: ${names}.` }] };
          }
          groups = filtered;
        }
      } else {
        if (!NAMESPACE || !ACCOUNT_ID) {
          return { content: [{ type: "text", text: "Server misconfigured: set HIVEMIND_ACCOUNT_ID and HIVEMIND_NAMESPACE (local dev)." }] };
        }
        groups = [{ accountId: ACCOUNT_ID, namespace: NAMESPACE, network: "testnet", label: NAMESPACE }];
      }

      // Recall every (selected) group in parallel; the enclave attests each result.
      const multi = groups.length > 1;
      const perGroup = await Promise.all(
        groups.map(async (g) => {
          try {
            const out = await enclaveRecall(g.accountId, g.namespace, query, limit ?? 5);
            if (!(await verifyAttestation(out))) return { g, error: "attestation_failed" as const };
            return { g, out };
          } catch (e) {
            return { g, error: e instanceof Error ? e.message : String(e) };
          }
        }),
      );

      // If every group failed to reach the enclave, surface the unavailable message.
      if (perGroup.every((r) => "error" in r)) {
        const anyAttestFail = perGroup.some((r) => r.error === "attestation_failed");
        if (anyAttestFail) {
          return {
            isError: true,
            content: [{ type: "text", text: "⚠ Enclave attestation FAILED — refusing to return unverified memory." }],
          };
        }
        return {
          content: [
            {
              type: "text",
              text: `HiveMind's confidential memory service is temporarily unavailable. Please try again shortly. (${(perGroup[0] as { error: string }).error})`,
            },
          ],
        };
      }

      const sections: string[] = [];
      let lastSig = "";
      for (const r of perGroup) {
        if ("error" in r) continue;
        const hits = r.out.response.data.hits;
        lastSig = r.out.signature;
        const label = r.g.label ?? r.g.namespace;
        if (hits.length === 0) {
          if (multi) sections.push(`### ${label}\n(no relevant memory)`);
          continue;
        }
        const body = hits
          .map((h, i) => `${i + 1}. (relevance ${(h.relevance_bps / 10000).toFixed(2)}) ${h.text}`)
          .join("\n");
        sections.push(multi ? `### ${label}\n${body}` : body);
      }

      if (sections.length === 0 || sections.every((s) => s.endsWith("(no relevant memory)"))) {
        return { content: [{ type: "text", text: "No relevant group memory found." }] };
      }
      const trust = `\n\n✓ attested by enclave (sig ${lastSig.slice(0, 16)}…, verified)`;
      return { content: [{ type: "text", text: sections.join("\n\n") + trust }] };
    },
  );

  return server;
}

// Stateful session store: claude.ai sends `initialize` once, then reuses the
// returned mcp-session-id for subsequent tool calls.
const transports: Record<string, StreamableHTTPServerTransport> = {};

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : undefined);
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  // Gate every MCP call on a valid Stytch-issued token (when auth is enabled).
  // A missing/invalid token writes the 401 + WWW-Authenticate challenge that
  // bootstraps claude.ai's OAuth + Dynamic Client Registration flow.
  const auth = await requireAuth(req, res);
  if (auth === "challenged") return;
  const subject = auth ? auth.subject : undefined;

  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  const body = req.method === "POST" ? await readBody(req) : undefined;

  let transport: StreamableHTTPServerTransport | undefined =
    sessionId ? transports[sessionId] : undefined;

  if (!transport) {
    if (req.method === "POST" && isInitializeRequest(body)) {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid) => {
          transports[sid] = transport as StreamableHTTPServerTransport;
        },
      });
      transport.onclose = () => {
        if (transport?.sessionId) delete transports[transport.sessionId];
      };
      await makeMcpServer(subject).connect(transport);
    } else {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "No valid session; send initialize first." }, id: null }));
      return;
    }
  }

  await transport.handleRequest(req, res, body);
}

/**
 * POST /bind { bindToken, sessionJwt } — links the logged-in Stytch user to the
 * group encoded in the bot-signed bind token. Called from the bind page (another
 * origin), so CORS is open. The binding is written to trusted_metadata, which the
 * user cannot forge — the namespace they recall from is fixed here, by identity.
 */
async function handleBind(req: IncomingMessage, res: ServerResponse): Promise<void> {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  if (req.method === "OPTIONS") {
    res.writeHead(204).end();
    return;
  }
  if (req.method !== "POST") {
    res.writeHead(405, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "method not allowed" }));
    return;
  }
  const body = (await readBody(req)) as { bindToken?: string; sessionJwt?: string } | undefined;
  const subject = await verifySessionSubject(body?.sessionJwt ?? "");
  if (!subject) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "invalid or missing Stytch session" }));
    return;
  }
  const binding = verifyBindToken(body?.bindToken ?? "");
  if (!binding) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "invalid or expired bind token" }));
    return;
  }
  await addBinding(subject, binding);
  const groups = await getBindings(subject);
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true, namespace: binding.namespace, groups: groups.length }));
}

const httpServer = createServer((req, res) => {
  if (req.method === "GET" && req.url === "/") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("hivemind-remote-mcp ok");
    return;
  }
  if (req.url?.startsWith("/bind")) {
    handleBind(req, res).catch((e) => {
      if (!res.headersSent) res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String(e) }));
    });
    return;
  }
  // OAuth discovery documents (served only when STYTCH_DOMAIN is configured).
  if (req.url?.startsWith("/.well-known/")) {
    handleWellKnown(req, res).catch((e) => {
      if (!res.headersSent) res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String(e) }));
    });
    return;
  }
  if (req.url?.startsWith("/mcp")) {
    handleMcp(req, res).catch((e) => {
      if (!res.headersSent) res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String(e) }));
    });
    return;
  }
  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not Found");
});

httpServer.listen(PORT, () => {
  console.log(
    `🛰️  hivemind-remote-mcp on :${PORT}  (enclave=${ENCLAVE_URL}, namespace=${NAMESPACE || "<unset>"}, auth=${authEnabled ? "stytch" : "off (local)"})`,
  );
});
