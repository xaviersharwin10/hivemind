import { useEffect } from "react";
import {
  createNetworkConfig,
  SuiClientProvider,
  WalletProvider,
  useSuiClientContext,
} from "@mysten/dapp-kit";
import { isEnokiNetwork, registerEnokiWallets } from "@mysten/enoki";
import { getJsonRpcFullnodeUrl } from "@mysten/sui/jsonRpc";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { config } from "./config";
import "@mysten/dapp-kit/dist/index.css";

const { networkConfig } = createNetworkConfig({
  testnet: { url: getJsonRpcFullnodeUrl("testnet"), network: "testnet" },
  mainnet: { url: getJsonRpcFullnodeUrl("mainnet"), network: "mainnet" },
});

const queryClient = new QueryClient();

/** Registers the Enoki Google wallet with dapp-kit on mount. No-op if env vars missing. */
function RegisterEnokiWallets() {
  const { client, network } = useSuiClientContext();
  useEffect(() => {
    if (!isEnokiNetwork(network)) return;
    if (!config.enokiApiKey || !config.googleClientId) return;
    const { unregister } = registerEnokiWallets({
      apiKey: config.enokiApiKey,
      providers: { google: { clientId: config.googleClientId } },
      client,
      network,
    });
    return unregister;
  }, [client, network]);
  return null;
}

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      <SuiClientProvider networks={networkConfig} defaultNetwork={config.network}>
        <RegisterEnokiWallets />
        <WalletProvider autoConnect>{children}</WalletProvider>
      </SuiClientProvider>
    </QueryClientProvider>
  );
}
