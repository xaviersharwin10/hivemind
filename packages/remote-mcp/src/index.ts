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
import { z } from "zod";

const ENCLAVE_URL = (process.env.ENCLAVE_URL ?? "http://localhost:3000").replace(/\/$/, "");
const NAMESPACE = process.env.HIVEMIND_NAMESPACE ?? "";
const PORT = Number(process.env.PORT ?? 8787);

/** Shape of the enclave's signed /process_data response. */
interface EnclaveRecall {
  response: {
    intent: number;
    timestamp_ms: number;
    data: { namespace: string; hits: { text: string; relevance_bps: number }[] };
  };
  signature: string;
}

async function enclaveRecall(namespace: string, query: string, limit: number): Promise<EnclaveRecall> {
  const r = await fetch(`${ENCLAVE_URL}/process_data`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ payload: { namespace, query, limit } }),
  });
  if (!r.ok) throw new Error(`enclave ${r.status}: ${await r.text()}`);
  return (await r.json()) as EnclaveRecall;
}

/** A fresh MCP server with the recall tool wired to the enclave. */
function makeMcpServer(): McpServer {
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
      },
    },
    async ({ query, limit }) => {
      if (!NAMESPACE) {
        return { content: [{ type: "text", text: "Server misconfigured: HIVEMIND_NAMESPACE is not set." }] };
      }
      const out = await enclaveRecall(NAMESPACE, query, limit ?? 5);
      const hits = out.response.data.hits;
      if (hits.length === 0) {
        return { content: [{ type: "text", text: "No relevant group memory found." }] };
      }
      const body = hits
        .map((h, i) => `${i + 1}. (relevance ${(h.relevance_bps / 10000).toFixed(2)}) ${h.text}`)
        .join("\n");
      const trust = `\n\n— attested by enclave signature ${out.signature.slice(0, 16)}…`;
      return { content: [{ type: "text", text: body + trust }] };
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
      await makeMcpServer().connect(transport);
    } else {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "No valid session; send initialize first." }, id: null }));
      return;
    }
  }

  await transport.handleRequest(req, res, body);
}

const httpServer = createServer((req, res) => {
  if (req.method === "GET" && req.url === "/") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("hivemind-remote-mcp ok");
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
    `🛰️  hivemind-remote-mcp on :${PORT}  (enclave=${ENCLAVE_URL}, namespace=${NAMESPACE || "<unset>"})`,
  );
});
