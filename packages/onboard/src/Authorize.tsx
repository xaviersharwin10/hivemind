/**
 * /oauth/authorize — the Stytch Connected Apps consent screen.
 *
 * claude.ai's connector (after Dynamic Client Registration) redirects the user
 * here to grant HiveMind access. The flow:
 *
 *   1. User must have a Stytch session. If not, we show the email magic-link
 *      login (StytchLogin auto-authenticates the magic-link token on return).
 *   2. Once authenticated, <IdentityProvider/> renders the consent screen,
 *      reading the OAuth params (client_id, scope, redirect_uri…) from the URL.
 *   3. On approval, Stytch redirects back to claude.ai with an auth code, which
 *      claude.ai exchanges for the access-token JWT our MCP server verifies.
 *
 * This page is configured as the project's Authorization URL in the Stytch
 * dashboard (Connected Apps).
 */

import { useEffect } from "react";
import {
  StytchProvider,
  StytchLogin,
  IdentityProvider,
  useStytchUser,
  createStytchUIClient,
  Products,
  OTPMethods,
} from "@stytch/react";
import { config } from "./config";

const stytch = config.stytchPublicToken ? createStytchUIClient(config.stytchPublicToken) : null;

// Email one-time passcode (OTP): the user enters a 6-digit code inline on this
// page — no email redirect — so the OAuth request params and the session are
// never lost across a round-trip (which broke the magic-link flow).
const loginConfig = {
  products: [Products.otp],
  otpOptions: {
    methods: [OTPMethods.Email],
    expirationMinutes: 10,
  },
};

const loginStyles = {
  container: { backgroundColor: "transparent", width: "100%" },
  colors: { primary: "#f5b301", primaryHover: "#d99c00" },
  buttons: { primary: { backgroundColor: "#f5b301", textColor: "#090b11" } },
};

function Gate() {
  const { user } = useStytchUser();

  // Preserve the OAuth request params (client_id, redirect_uri, scope, state…)
  // across the magic-link email round-trip, which otherwise drops the query
  // string and leaves <IdentityProvider/> with nothing to consent to.
  useEffect(() => {
    if (new URLSearchParams(window.location.search).has("client_id")) {
      sessionStorage.setItem("hm_oauth_params", window.location.search);
    }
  }, []);

  // After login we may land back here without the OAuth params — restore them
  // so the consent screen (not the login form) renders.
  useEffect(() => {
    if (!user) return;
    if (!new URLSearchParams(window.location.search).has("client_id")) {
      const saved = sessionStorage.getItem("hm_oauth_params");
      if (saved) window.location.replace(`/oauth/authorize${saved}`);
    }
  }, [user]);

  return (
    <div style={card}>
      <div style={{ fontSize: 40, lineHeight: 1 }}>🐝</div>
      <h1 style={{ margin: "12px 0 4px", fontSize: 20 }}>Connect HiveMind</h1>
      <p style={{ margin: "0 0 20px", color: "#9aa3b2", fontSize: 14 }}>
        {user
          ? "Approve access so your AI can recall this group's memory."
          : "Sign in to authorize the connection."}
      </p>
      {user ? <IdentityProvider /> : <StytchLogin config={loginConfig} styles={loginStyles} />}
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

export function Authorize() {
  if (!stytch) {
    return (
      <div style={card}>
        <h1 style={{ fontSize: 18 }}>Authorization not configured</h1>
        <p style={{ color: "#9aa3b2", fontSize: 14 }}>
          Set <code>VITE_STYTCH_PUBLIC_TOKEN</code> to enable the consent screen.
        </p>
      </div>
    );
  }
  return (
    <StytchProvider stytch={stytch}>
      <Gate />
    </StytchProvider>
  );
}
