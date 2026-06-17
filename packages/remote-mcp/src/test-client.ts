/**
 * Tiny MCP client to exercise the remote server end-to-end:
 *   client → remote-mcp (HTTP) → enclave (/process_data) → MemWal → back.
 *
 * Usage: pnpm --filter @hivemind/remote-mcp test-client "what did we ship?"
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const url = process.env.MCP_URL ?? "http://localhost:8787/mcp";
const query = process.argv[2] ?? "when do we ship?";

const transport = new StreamableHTTPClientTransport(new URL(url));
const client = new Client({ name: "hivemind-test-client", version: "0.0.1" });

await client.connect(transport);
const tools = await client.listTools();
console.log("tools:", tools.tools.map((t) => t.name).join(", "));

const res = await client.callTool({ name: "recall", arguments: { query, limit: 5 } });
console.log("\nrecall result:\n" + JSON.stringify(res, null, 2));

await client.close();
