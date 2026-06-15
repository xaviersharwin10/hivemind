/**
 * hivemind-read — MCP server that plugs a group's HiveMind memory into any MCP
 * client (Claude Desktop, Cursor, …). This is the cross-tool handoff: memory
 * written by the Telegram bot is read here by a local AI.
 *
 * Two tools:
 *   recall(query)        → semantic search over the group's MemWal memories
 *   read_artifact(blobId) → fetch the original file from Walrus by blob id
 *
 * Config (env, set in the MCP client's server config):
 *   HIVEMIND_DELEGATE_KEY  — a delegate key (hex) for the group's MemWalAccount
 *   HIVEMIND_ACCOUNT_ID    — the group's MemWalAccount object id
 *   HIVEMIND_NAMESPACE     — memory namespace (default "main")
 *   HIVEMIND_NETWORK       — testnet | mainnet (default testnet)
 */

import { setGlobalDispatcher, Agent as UndiciAgent } from "undici";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { makeMemwal, readBlob, makeSuiClient, isSealEncrypted, decryptArtifact, extractText, type SuiNetwork } from "@hivemind/core";

// Force IPv4 (some networks have broken IPv6 egress; harmless elsewhere).
setGlobalDispatcher(new UndiciAgent({ connect: { family: 4 } } as ConstructorParameters<typeof UndiciAgent>[0]));

const KEY = process.env.HIVEMIND_DELEGATE_KEY;
const ACCOUNT_ID = process.env.HIVEMIND_ACCOUNT_ID;
const NAMESPACE = process.env.HIVEMIND_NAMESPACE ?? "main";
const NETWORK = (process.env.HIVEMIND_NETWORK ?? "testnet") as SuiNetwork;

if (!KEY || !ACCOUNT_ID) {
  console.error("hivemind-read: set HIVEMIND_DELEGATE_KEY and HIVEMIND_ACCOUNT_ID in the MCP server env.");
  process.exit(1);
}

const memwal = makeMemwal({ key: KEY, accountId: ACCOUNT_ID, network: NETWORK, namespace: NAMESPACE });

const server = new McpServer({ name: "hivemind-read", version: "0.0.1" });

server.registerTool(
  "recall",
  {
    title: "Recall group memory",
    description:
      "Semantic search over the group chat's decisions, facts, and shared-file references stored in HiveMind. " +
      "Use this to find what the group decided or what files they shared before doing work on their behalf.",
    inputSchema: {
      query: z.string().describe("What to look for, in plain language"),
      limit: z.number().int().min(1).max(20).optional().describe("Max results (default 5)"),
    },
  },
  async ({ query, limit }) => {
    const res = await memwal.recall({ query, namespace: NAMESPACE, limit: limit ?? 5, maxDistance: 0.8 });
    if (res.results.length === 0) {
      return { content: [{ type: "text", text: "No relevant group memory found." }] };
    }
    const text = res.results
      .map((r, i) => `${i + 1}. (relevance ${(1 - r.distance).toFixed(2)}) ${r.text}`)
      .join("\n");
    return { content: [{ type: "text", text }] };
  },
);

server.registerTool(
  "read_artifact",
  {
    title: "Read a shared file from Walrus",
    description:
      "Fetch the original contents of a file shared in the group, by its Walrus blob id. " +
      "Blob ids appear in recall results as `walrus_blob=<id>`. Files are Seal-encrypted on " +
      "Walrus; this transparently decrypts them via the group's on-chain access policy and " +
      "returns the file's text contents.",
    inputSchema: {
      blobId: z.string().describe("The Walrus blob id (the walrus_blob=… value from a recall result)"),
    },
  },
  async ({ blobId }) => {
    try {
      const bytes = await readBlob(blobId);
      // New artifacts are Seal-encrypted; decrypt via seal_approve using our delegate
      // key. Legacy plaintext blobs (pre-Seal) are returned as-is for compatibility.
      let plaintext = bytes;
      if (isSealEncrypted(bytes)) {
        plaintext = await decryptArtifact({
          suiClient: makeSuiClient(NETWORK),
          network: NETWORK,
          delegateKey: KEY,
          accountId: ACCOUNT_ID,
          data: bytes,
        });
      }
      // Turn the bytes into readable text (PDF → extracted text, text → decoded).
      const { kind, text } = await extractText(plaintext);
      if (text) return { content: [{ type: "text", text }] };
      return {
        content: [{
          type: "text",
          text: `This artifact is a ${kind === "pdf" ? "PDF with no extractable text" : "binary file"} (${plaintext.length} bytes) — it can't be rendered as text.`,
        }],
      };
    } catch (e) {
      return { content: [{ type: "text", text: `Could not read blob ${blobId}: ${(e as Error).message}` }], isError: true };
    }
  },
);

await server.connect(new StdioServerTransport());
console.error("hivemind-read MCP server running (stdio).");
