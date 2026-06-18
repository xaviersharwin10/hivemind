/**
 * binding.ts — links a claude.ai user (Stytch identity) to exactly one HiveMind
 * group, and resolves that link at recall time.
 *
 * Why: the hosted MCP has one URL for everyone. A user must only ever touch their
 * own group, so the group `{accountId, namespace}` is derived from the *verified
 * identity*, never from the request. The binding is established once via a bind
 * token the bot issues (proof the user is in that group) and stored in the user's
 * Stytch `trusted_metadata` (backend-only — the user can't forge it).
 *
 * Flow:
 *   bot `/connect_claude` → signs a bind token {accountId, namespace, network}
 *   user opens bind link → Stytch login → POST /bind {bindToken, sessionJwt}
 *   here: verify token (shared HMAC) + session (JWKS→sub) → write trusted_metadata
 *   recall → read trusted_metadata.hivemind for the authenticated sub
 *
 * Env:
 *   BIND_SIGNING_SECRET    — HMAC secret shared with the bot (signs bind tokens)
 *   STYTCH_PROJECT_ID      — project-test-… (Basic-auth user for the backend API)
 *   STYTCH_PROJECT_SECRET  — project secret (secret-test-…) for the backend API
 *   STYTCH_API_BASE        — https://test.stytch.com (test) | https://api.stytch.com (live)
 */

import { createHmac, timingSafeEqual } from "node:crypto";

const BIND_SECRET = process.env.BIND_SIGNING_SECRET ?? "";
const PROJECT_ID = process.env.STYTCH_PROJECT_ID ?? "";
const PROJECT_SECRET = process.env.STYTCH_PROJECT_SECRET ?? "";
const API_BASE = (process.env.STYTCH_API_BASE ?? "https://test.stytch.com").replace(/\/$/, "");

export interface Binding {
  accountId: string;
  namespace: string;
  network: string;
}

/**
 * Verify a bind token of the form `base64url(payloadJson).base64url(hmac)`.
 * Returns the binding, or null if the signature/expiry is invalid.
 */
export function verifyBindToken(token: string): Binding | null {
  if (!BIND_SECRET) return null;
  const dot = token.indexOf(".");
  if (dot < 0) return null;
  const payloadB64 = token.slice(0, dot);
  const sigB64 = token.slice(dot + 1);
  const expected = createHmac("sha256", BIND_SECRET).update(payloadB64).digest();
  let got: Buffer;
  try {
    got = Buffer.from(sigB64, "base64url");
  } catch {
    return null;
  }
  if (got.length !== expected.length || !timingSafeEqual(got, expected)) return null;
  try {
    const d = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
    if (typeof d.exp === "number" && Date.now() > d.exp) return null;
    if (!d.accountId || !d.namespace || !d.network) return null;
    return { accountId: String(d.accountId), namespace: String(d.namespace), network: String(d.network) };
  } catch {
    return null;
  }
}

function authHeader(): string {
  return "Basic " + Buffer.from(`${PROJECT_ID}:${PROJECT_SECRET}`).toString("base64");
}

/** Write the group binding to the user's Stytch trusted_metadata (backend-only). */
export async function setBinding(userId: string, b: Binding): Promise<void> {
  if (!PROJECT_SECRET) throw new Error("STYTCH_PROJECT_SECRET not set");
  const r = await fetch(`${API_BASE}/v1/users/${encodeURIComponent(userId)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: authHeader() },
    body: JSON.stringify({ trusted_metadata: { hivemind: b } }),
  });
  if (!r.ok) throw new Error(`stytch set metadata ${r.status}: ${await r.text()}`);
}

// Small in-memory cache so recall doesn't hit the Stytch API every call.
const cache = new Map<string, { b: Binding | null; exp: number }>();
const TTL_MS = 60_000;

/** Read the group binding for an authenticated user, or null if not yet bound. */
export async function getBinding(userId: string): Promise<Binding | null> {
  const hit = cache.get(userId);
  if (hit && Date.now() < hit.exp) return hit.b;
  if (!PROJECT_SECRET) return null;
  const r = await fetch(`${API_BASE}/v1/users/${encodeURIComponent(userId)}`, {
    headers: { Authorization: authHeader() },
  });
  if (!r.ok) return null; // don't cache hard failures
  const j = (await r.json()) as { user?: { trusted_metadata?: { hivemind?: Binding } }; trusted_metadata?: { hivemind?: Binding } };
  const hm = j?.user?.trusted_metadata?.hivemind ?? j?.trusted_metadata?.hivemind ?? null;
  const b = hm ? { accountId: hm.accountId, namespace: hm.namespace, network: hm.network } : null;
  cache.set(userId, { b, exp: Date.now() + TTL_MS });
  return b;
}
