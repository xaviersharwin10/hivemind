/**
 * MemWal deployment constants.
 *
 * Source: github.com/MystenLabs/MemWal — apps/app/.env.example (verified 2026-06-13).
 * These are the on-chain package + registry object ids the account contract calls
 * (`{packageId}::account::create_account(registry, clock)`).
 */

export type SuiNetwork = "testnet" | "mainnet";

interface MemWalDeployment {
  packageId: string;
  registryId: string;
  /** Default managed relayer for this network (staging = testnet). */
  relayerUrl: string;
  fullnodeUrl: string;
}

export const MEMWAL: Record<SuiNetwork, MemWalDeployment> = {
  testnet: {
    packageId: "0xcf6ad755a1cdff7217865c796778fabe5aa399cb0cf2eba986f4b582047229c6",
    registryId: "0xe80f2feec1c139616a86c9f71210152e2a7ca552b20841f2e192f99f75864437",
    relayerUrl: "https://relayer-staging.memory.walrus.xyz",
    fullnodeUrl: "https://fullnode.testnet.sui.io:443",
  },
  mainnet: {
    packageId: "0xcee7a6fd8de52ce645c38332bde23d4a30fd9426bc4681409733dd50958a24c6",
    registryId: "0x0da982cefa26864ae834a8a0504b904233d49e20fcc17c373c8bed99c75a7edd",
    relayerUrl: "https://relayer.memory.walrus.xyz",
    fullnodeUrl: "https://fullnode.mainnet.sui.io:443",
  },
};

interface HiveMindDeployment {
  /** Our own published Move package (`hivemind::registry`). */
  packageId: string;
  /** The shared `Registry` singleton object (chat_id → Group). */
  registryId: string;
}

/**
 * HiveMind's own on-chain registry — the group→account index and verifiable
 * artifact manifest. Source of truth replacing the local JSON registry.
 *
 * Published to Sui testnet 2026-06-14 (tx AkTTyWLzwg6UdrWLtYchHu3S8YwtQbUWnezRbTnrcJQY).
 */
export const HIVEMIND: Record<SuiNetwork, HiveMindDeployment> = {
  testnet: {
    packageId: "0xe9a1e57c815cb1f2bd8c54d1c5973b0f9c565e5c3fbacffae8d47c7052896d8e",
    registryId: "0xb058138ce5a2fd3542c25e7ce2e58e9e6848aa747cee996182b43cfb8b347daa",
  },
  // Not yet published to mainnet.
  mainnet: { packageId: "", registryId: "" },
};

/** The well-known shared `Clock` object (`0x6`). */
export const SUI_CLOCK = "0x0000000000000000000000000000000000000000000000000000000000000006";

/**
 * Fallback namespace. Real onboarding sets a per-group namespace (the chat id) so
 * one creator's multiple groups keep separate memory pools (and separate Seal keys)
 * under the single MemWalAccount their address is allowed to own.
 */
export const DEFAULT_NAMESPACE = "main";

/** Contract hard limit: max delegate keys per MemWalAccount. */
export const MAX_DELEGATE_KEYS = 20;

/**
 * The hosted enclave's STABLE delegate identity (Path B / claude.ai TEE).
 *
 * One identity for the whole enclave: groups that enable claude.ai authorize this
 * address on their MemWalAccount (via add_delegate_key), so the attested enclave
 * can recall their memory. The private key lives ONLY inside the enclave
 * (Seal-provisioned); only the public key/address is public here.
 */
export const ENCLAVE_DELEGATE = {
  address: "0x0aba86be9899f0f1c192367fee04763acd903bab78b89c6a2bd596ce5842b278",
  publicKeyHex: "171bf061991b7657c0921b594ab723f8aa19bb78840bb16d143b06031691882f",
} as const;
