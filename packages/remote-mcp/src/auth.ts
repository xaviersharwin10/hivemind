/**
 * auth.ts — the claude.ai ⇄ Stytch OAuth layer for the remote MCP server.
 *
 * claude.ai Custom Connectors speak OAuth 2.1 with Dynamic Client Registration
 * (DCR). We don't run our own auth server — Stytch's "Connected Apps" is the
 * authorization server. This module:
 *
 *   1. Serves the two discovery documents claude.ai fetches:
 *        /.well-known/oauth-protected-resource   (this server is the resource)
 *        /.well-known/oauth-authorization-server  (proxied from Stytch)
 *   2. Issues the 401 + WWW-Authenticate challenge that kicks off the flow.
 *   3. Verifies the incoming Stytch-issued JWT *locally* against the project
 *      JWKS (no per-request round-trip) before any recall reaches the enclave.
 *
 * Flow:
 *   claude.ai ──(no token)──► 401 + WWW-Authenticate(resource_metadata)
 *   claude.ai ── GET /.well-known/oauth-protected-resource ─► {authorization_servers:[stytch]}
 *   claude.ai ── DCR + auth-code flow against Stytch ─► access-token JWT
 *   claude.ai ── POST /mcp  (Authorization: Bearer <jwt>) ─► verified ─► recall
 *
 * Auth is ENFORCED only when STYTCH_DOMAIN is set. With it unset the server runs
 * in open local-loop mode (the existing enclave integration test path).
 *
 * Env:
 *   STYTCH_DOMAIN      — project domain, e.g. https://<slug>.customers.stytch.dev
 *                        (Stytch dashboard → Connected Apps). Tokens are signed
 *                        by this domain; it is also the JWT `iss`.
 *   STYTCH_PROJECT_ID  — project-test-… / project-live-…  (the JWT `aud`)
 *   SERVER_URL         — this server's public base URL (the OAuth `resource`)
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";

const STYTCH_DOMAIN = (process.env.STYTCH_DOMAIN ?? "").replace(/\/$/, "");
const PROJECT_ID = process.env.STYTCH_PROJECT_ID ?? "";
// Public base URL (the OAuth `resource`). Prefer an explicit SERVER_URL; on Render
// fall back to the auto-injected RENDER_EXTERNAL_URL so the hosted deploy is
// self-configuring; finally localhost for dev.
const SERVER_URL = (
  process.env.SERVER_URL ??
  process.env.RENDER_EXTERNAL_URL ??
  `http://localhost:${process.env.PORT ?? 8787}`
).replace(/\/$/, "");

export const authEnabled = STYTCH_DOMAIN.length > 0;

// Local JWKS verifier — fetches the project's signing keys once and caches them.
const jwks = authEnabled
  ? createRemoteJWKSet(new URL(`${STYTCH_DOMAIN}/.well-known/jwks.json`))
  : undefined;

/** RFC 9728 — tells claude.ai which authorization server protects this resource. */
function protectedResourceMetadata() {
  return {
    resource: SERVER_URL,
    authorization_servers: [STYTCH_DOMAIN],
    bearer_methods_supported: ["header"],
    // Only advertise scopes the Stytch authorization server actually supports —
    // a custom scope here makes claude.ai request it and Stytch rejects it
    // ("invalid scope"). Authorization to recall is gated by a valid token, not
    // by a custom scope.
    scopes_supported: ["openid", "profile", "email", "offline_access"],
  };
}

/** Proxy Stytch's own AS metadata so claude.ai discovers the DCR/token endpoints. */
async function authorizationServerMetadata(): Promise<unknown> {
  const r = await fetch(`${STYTCH_DOMAIN}/.well-known/oauth-authorization-server`);
  if (!r.ok) throw new Error(`stytch AS metadata ${r.status}`);
  return r.json();
}

/**
 * Handle the OAuth discovery routes. Returns true if it served the request.
 * Safe to call even when auth is disabled (it just 404s the well-knowns).
 */
export async function handleWellKnown(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = req.url ?? "";
  if (!url.startsWith("/.well-known/")) return false;

  if (!authEnabled) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "auth not configured" }));
    return true;
  }

  if (url.startsWith("/.well-known/oauth-protected-resource")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(protectedResourceMetadata()));
    return true;
  }
  if (url.startsWith("/.well-known/oauth-authorization-server")) {
    try {
      const meta = await authorizationServerMetadata();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(meta));
    } catch (e) {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String(e) }));
    }
    return true;
  }
  return false;
}

/** What a successfully verified caller looks like. */
export interface AuthContext {
  subject: string; // Stytch user id (JWT `sub`)
  claims: JWTPayload;
}

/**
 * Verify the Bearer token on an MCP request.
 *  - auth disabled        → returns null (open mode; caller proceeds)
 *  - missing/invalid token → writes the 401 challenge and returns "challenged"
 *  - valid token           → returns an AuthContext
 */
export async function requireAuth(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<AuthContext | null | "challenged"> {
  if (!authEnabled) return null;

  const header = req.headers["authorization"];
  const token = typeof header === "string" && header.startsWith("Bearer ")
    ? header.slice("Bearer ".length).trim()
    : undefined;

  if (!token) {
    challenge(res, "missing bearer token");
    return "challenged";
  }

  try {
    const { payload } = await jwtVerify(token, jwks!, {
      issuer: STYTCH_DOMAIN,
      audience: PROJECT_ID,
    });
    return { subject: String(payload.sub ?? ""), claims: payload };
  } catch (e) {
    challenge(res, `invalid token: ${e instanceof Error ? e.message : String(e)}`);
    return "challenged";
  }
}

/**
 * Verify a Stytch *session* JWT (from the consent/bind page) and return its
 * subject (the Stytch user id), or null. Used by the /bind endpoint to know who
 * is redeeming a bind token. Signature-only against the project JWKS — only this
 * project's tokens validate — so we don't constrain issuer/audience (session and
 * access tokens differ there).
 */
export async function verifySessionSubject(token: string): Promise<string | null> {
  if (!authEnabled || !token) return null;
  try {
    const { payload } = await jwtVerify(token, jwks!);
    return payload.sub ? String(payload.sub) : null;
  } catch {
    return null;
  }
}

function challenge(res: ServerResponse, detail: string): void {
  res.writeHead(401, {
    "Content-Type": "application/json",
    "WWW-Authenticate": `Bearer resource_metadata="${SERVER_URL}/.well-known/oauth-protected-resource", error="invalid_token", error_description="${detail}"`,
  });
  res.end(JSON.stringify({ error: "unauthorized", error_description: detail }));
}
