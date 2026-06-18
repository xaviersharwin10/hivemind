/**
 * /bind — links a claude.ai user (Stytch identity) to their HiveMind group.
 *
 * Opened from the bot's /connect_claude link (`/bind?t=<bindToken>`). The user
 * signs in with email OTP (inline, no redirect), then we POST the bind token +
 * their Stytch session JWT to the remote MCP's /bind endpoint, which verifies both
 * and writes the binding into their trusted_metadata. After this, adding the
 * connector in claude.ai recalls only this group's memory.
 */

import { useEffect, useState } from "react";
import {
  StytchProvider,
  StytchLogin,
  useStytchUser,
  useStytch,
  createStytchUIClient,
  Products,
  OTPMethods,
} from "@stytch/react";
import { config } from "./config";

const stytch = config.stytchPublicToken ? createStytchUIClient(config.stytchPublicToken) : null;

const loginConfig = {
  products: [Products.otp],
  otpOptions: { methods: [OTPMethods.Email], expirationMinutes: 10 },
};

const loginStyles = {
  container: { backgroundColor: "transparent", width: "100%" },
  colors: { primary: "#f5b301", primaryHover: "#d99c00" },
  buttons: { primary: { backgroundColor: "#f5b301", textColor: "#090b11" } },
};

function bindToken(): string {
  return new URLSearchParams(window.location.search).get("t") ?? "";
}

type Status = "login" | "binding" | "done" | "error";

function Inner() {
  const { user } = useStytchUser();
  const sdk = useStytch();
  const [status, setStatus] = useState<Status>("login");
  const [msg, setMsg] = useState("");

  useEffect(() => {
    if (!user || status !== "login") return;
    const token = bindToken();
    if (!token) {
      setStatus("error");
      setMsg("Missing bind token — re-open the link from Telegram (/connect_claude).");
      return;
    }
    const sessionJwt = sdk.session.getTokens()?.session_jwt;
    if (!sessionJwt) {
      setStatus("error");
      setMsg("No active session. Please sign in again.");
      return;
    }
    setStatus("binding");
    fetch(`${config.remoteMcpUrl.replace(/\/$/, "")}/bind`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bindToken: token, sessionJwt }),
    })
      .then(async (r) => {
        if (!r.ok) throw new Error(((await r.json().catch(() => ({}))) as { error?: string }).error ?? r.statusText);
        setStatus("done");
      })
      .catch((e) => {
        setStatus("error");
        setMsg(e instanceof Error ? e.message : String(e));
      });
  }, [user, status, sdk]);

  return (
    <div style={card}>
      <div style={{ fontSize: 40, lineHeight: 1 }}>🐝</div>
      <h1 style={{ margin: "12px 0 4px", fontSize: 20 }}>Link Claude to your group</h1>
      {status === "login" && !user && (
        <>
          <p style={hint}>Sign in to link this Claude account to your HiveMind group.</p>
          <StytchLogin config={loginConfig} styles={loginStyles} />
        </>
      )}
      {(status === "binding" || (status === "login" && user)) && <p style={hint}>Linking…</p>}
      {status === "done" && (
        <p style={hint}>
          ✅ Linked! Now add the connector in claude.ai (Settings → Connectors → Add custom
          connector) using the URL from the bot, then ask Claude to recall your group's memory.
        </p>
      )}
      {status === "error" && <div style={{ ...hint, color: "#ff8080" }}>⚠ {msg}</div>}
    </div>
  );
}

const card: React.CSSProperties = {
  maxWidth: 420,
  margin: "8vh auto",
  padding: 28,
  background: "#11141c",
  border: "1px solid #222838",
  borderRadius: 16,
  textAlign: "center",
};
const hint: React.CSSProperties = { margin: "0 0 16px", color: "#9aa3b2", fontSize: 14 };

export function Bind() {
  if (!stytch) {
    return (
      <div style={card}>
        <h1 style={{ fontSize: 18 }}>Not configured</h1>
        <p style={hint}>Set VITE_STYTCH_PUBLIC_TOKEN and VITE_REMOTE_MCP_URL.</p>
      </div>
    );
  }
  return (
    <StytchProvider stytch={stytch}>
      <Inner />
    </StytchProvider>
  );
}
