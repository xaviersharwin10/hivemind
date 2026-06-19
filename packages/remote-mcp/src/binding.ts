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
  /** Human label for the group (defaults to the namespace). Used to disambiguate
   *  results when a user is bound to multiple groups. */
  label?: string;
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
    return {
      accountId: String(d.accountId),
      namespace: String(d.namespace),
      network: String(d.network),
      label: d.label ? String(d.label) : String(d.namespace),
    };
  } catch {
    return null;
  }
}

function authHeader(): string {
  return "Basic " + Buffer.from(`${PROJECT_ID}:${PROJECT_SECRET}`).toString("base64");
}

// Small in-memory cache so recall doesn't hit the Stytch API every call.
const cache = new Map<string, { groups: Binding[]; exp: number }>();
const TTL_MS = 60_000;

/** The stored shape: a list of groups. Tolerates the legacy single-object shape. */
type StoredHivemind = { groups?: Binding[] } | Binding | undefined;

function normalize(hm: StoredHivemind): Binding[] {
  if (!hm) return [];
  const list = "groups" in hm && Array.isArray(hm.groups) ? hm.groups : "accountId" in hm ? [hm] : [];
  return list
    .filter((b): b is Binding => !!b && !!b.accountId && !!b.namespace)
    .map((b) => ({ accountId: b.accountId, namespace: b.namespace, network: b.network, label: b.label ?? b.namespace }));
}

async function fetchGroups(userId: string): Promise<Binding[]> {
  const hit = cache.get(userId);
  if (hit && Date.now() < hit.exp) return hit.groups;
  if (!PROJECT_SECRET) return [];
  const r = await fetch(`${API_BASE}/v1/users/${encodeURIComponent(userId)}`, {
    headers: { Authorization: authHeader() },
  });
  if (!r.ok) return []; // don't cache hard failures
  const j = (await r.json()) as { user?: { trusted_metadata?: { hivemind?: StoredHivemind } }; trusted_metadata?: { hivemind?: StoredHivemind } };
  const hm = j?.user?.trusted_metadata?.hivemind ?? j?.trusted_metadata?.hivemind;
  const groups = normalize(hm);
  cache.set(userId, { groups, exp: Date.now() + TTL_MS });
  return groups;
}

/** All groups an authenticated user is bound to (empty if none). */
export async function getBindings(userId: string): Promise<Binding[]> {
  return fetchGroups(userId);
}

/**
 * Add a group to the user's Stytch trusted_metadata, preserving any existing
 * bindings (so a user in multiple groups accumulates them). De-duped by
 * accountId+namespace; re-binding refreshes the label.
 */
export async function addBinding(userId: string, b: Binding): Promise<void> {
  if (!PROJECT_SECRET) throw new Error("STYTCH_PROJECT_SECRET not set");
  const existing = await fetchGroups(userId);
  const key = (x: Binding) => `${x.accountId}/${x.namespace}`;
  const groups = existing.filter((g) => key(g) !== key(b));
  groups.push({ accountId: b.accountId, namespace: b.namespace, network: b.network, label: b.label ?? b.namespace });
  const r = await fetch(`${API_BASE}/v1/users/${encodeURIComponent(userId)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: authHeader() },
    body: JSON.stringify({ trusted_metadata: { hivemind: { groups } } }),
  });
  if (!r.ok) throw new Error(`stytch set metadata ${r.status}: ${await r.text()}`);
  cache.set(userId, { groups, exp: Date.now() + TTL_MS });
}
