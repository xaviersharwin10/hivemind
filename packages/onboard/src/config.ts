import type { SuiNetwork } from "@hivemind/core/browser";

export const config = {
  network: (import.meta.env.VITE_SUI_NETWORK ?? "testnet") as SuiNetwork,
  enokiApiKey: import.meta.env.VITE_ENOKI_API_KEY ?? "",
  googleClientId: import.meta.env.VITE_GOOGLE_CLIENT_ID ?? "",
  relayerUrl: import.meta.env.VITE_RELAYER_URL ?? "https://relayer-staging.memory.walrus.xyz",
  botApiUrl: import.meta.env.VITE_BOT_API_URL ?? "http://localhost:8080",
} as const;
