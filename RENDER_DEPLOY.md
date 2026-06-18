# Deploying the HiveMind hosted product to Render

Two web services from `render.yaml` (Blueprint), both built from `./Dockerfile`:

| Service | What it is | Public URL used by |
|---|---|---|
| `hivemind-mcp` | Confidential remote-MCP + `/bind` | **claude.ai** custom connector, onboard `/bind` page |
| `hivemind-bot` | Telegram bot + onboarding API | Telegram, onboard SPA backend |

The enclave (AWS Nitro, Elastic IP `34.203.108.130:3000`, pubkey `5829a8f7…`) is
already live and baked into the blueprint. Render reaches it over plain HTTP egress.

## 1. Create the Blueprint
1. Render dashboard → **New → Blueprint** → connect this GitHub repo → it reads `render.yaml`.
2. It creates `hivemind-mcp` and `hivemind-bot`. Click into each and fill the
   `sync:false` secrets below (values are in the local `.env` files — never commit them).

### `hivemind-mcp` secrets (from `packages/remote-mcp/.env`)
- `STYTCH_MGMT_KEY_ID`
- `STYTCH_MGMT_SECRET`
- `STYTCH_PROJECT_SECRET`
- `BIND_SIGNING_SECRET`  ← must be **identical** to the bot's

### `hivemind-bot` secrets (from `packages/bot/.env`)
- `BOT_TOKEN`
- `ENOKI_PRIVATE_API_KEY`
- `BIND_SIGNING_SECRET`  ← same value as the MCP's
- `REMOTE_MCP_URL`  ← set **after** step 2 to the MCP's URL (e.g. `https://hivemind-mcp.onrender.com`)

## 2. Get the MCP URL, wire the bot
After `hivemind-mcp` deploys, copy its `https://…onrender.com` URL and set it as
`hivemind-bot`'s `REMOTE_MCP_URL`, then redeploy the bot. (`SERVER_URL` on the MCP
auto-derives from Render's `RENDER_EXTERNAL_URL` — nothing to set.)

## 3. Point the onboard SPA (Vercel) at the hosted backends
In the `hivemind-onboard` Vercel project → Settings → Environment Variables:
- `VITE_REMOTE_MCP_URL` = the `hivemind-mcp` URL (for the `/bind` page)
- `VITE_BOT_API_URL`    = the `hivemind-bot` URL (onboarding/connect backend)
- `VITE_STYTCH_PUBLIC_TOKEN` = `public-token-test-b0f980ab-…`
Redeploy the Vercel project.

## 4. Stytch dashboard
- Connected Apps → add redirect/allowed URL for the `/bind` page: `https://hivemind-onboard.vercel.app/bind`.
- Confirm `https://hivemind-onboard.vercel.app/oauth/authorize` is still the consent URL.

## 5. claude.ai connector
Settings → Connectors → Add custom connector → paste the **`hivemind-mcp` URL**.
The 401 → discovery → Stytch consent → recall flow runs against the hosted MCP.

## Owner one-time per group (in Telegram)
- `/enable_claude` → approve with the owner zkLogin → authorizes the enclave delegate
  `0x0aba86…` on that group's MemWalAccount (so the attested enclave can recall it).
- `/connect_claude` → opens the `/bind` link → email OTP → links the Claude identity
  to that group (written to Stytch `trusted_metadata`).

## Notes
- Free plan sleeps on idle; the bot long-polls so it stays warm, but add an uptime
  pinger if claude.ai cold-starts feel slow.
- `BIND_SIGNING_SECRET` MUST match across bot + MCP or bind tokens fail to verify.
