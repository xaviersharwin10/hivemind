/**
 * bindtoken.ts — signs the bind token that links a claude.ai user to this group.
 *
 * The token proves "the bearer is a member of group X" (the bot only issues it to
 * members in the group chat). The remote MCP verifies it with the same shared
 * HMAC secret and writes the binding into the user's Stytch trusted_metadata.
 *
 * Format (must match packages/remote-mcp/src/binding.ts):
 *   base64url(payloadJson) "." base64url(hmacSha256(payloadB64, secret))
 */

import { createHmac } from "node:crypto";

export interface BindPayload {
  accountId: string;
  namespace: string;
  network: string;
}

const DEFAULT_TTL_MS = 30 * 60 * 1000; // 30 min

/** Sign a bind token. Returns "" if no secret is configured. */
export function signBindToken(p: BindPayload, secret: string, ttlMs = DEFAULT_TTL_MS): string {
  if (!secret) return "";
  const payload = { ...p, exp: Date.now() + ttlMs };
  const payloadB64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const sig = createHmac("sha256", secret).update(payloadB64).digest("base64url");
  return `${payloadB64}.${sig}`;
}
