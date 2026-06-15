/**
 * Sui client + keypair helpers.
 *
 * For the Flow 1 prototype the group owner is a local Ed25519 keypair.
 * In production (Option B) this is replaced by a zkLogin/Enoki signer — the
 * MemWal account calls take the signer the same way, so only this layer changes.
 */

import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { MEMWAL, type SuiNetwork } from "./constants";

/**
 * Sui SDK v2.16+ renamed the classic JSON-RPC client to `SuiJsonRpcClient`
 * (the old `SuiClient` export was removed from `@mysten/sui/client`).
 * It exposes the `signAndExecuteTransaction` / `waitForTransaction` / `getBalance`
 * methods MemWal's account contract calls expect.
 */
export type SuiClient = SuiJsonRpcClient;

export function makeSuiClient(network: SuiNetwork): SuiClient {
  return new SuiJsonRpcClient({ network, url: MEMWAL[network].fullnodeUrl });
}

/** Load an owner keypair from a bech32 `suiprivkey1...` string. */
export function keypairFromSecret(suiPrivateKey: string): Ed25519Keypair {
  return Ed25519Keypair.fromSecretKey(suiPrivateKey);
}

/** Generate a brand-new owner keypair. Returns the bech32 secret to persist. */
export function newOwnerKeypair(): { keypair: Ed25519Keypair; secret: string; address: string } {
  const keypair = new Ed25519Keypair();
  return {
    keypair,
    secret: keypair.getSecretKey(),
    address: keypair.getPublicKey().toSuiAddress(),
  };
}

export async function getBalanceMist(client: SuiClient, address: string): Promise<bigint> {
  const { totalBalance } = await client.getBalance({ owner: address });
  return BigInt(totalBalance);
}

/**
 * Top up an address from the testnet faucet. Best-effort: faucets rate-limit and
 * occasionally 429. Returns true on success, false otherwise (caller can fall back
 * to a manual faucet).
 */
export async function tryFaucet(network: SuiNetwork, address: string): Promise<boolean> {
  if (network !== "testnet") return false;
  try {
    const { getFaucetHost, requestSuiFromFaucetV2 } = await import("@mysten/sui/faucet");
    await requestSuiFromFaucetV2({ host: getFaucetHost("testnet"), recipient: address });
    return true;
  } catch {
    return false;
  }
}
