/**
 * Per-group MemWalAccount lifecycle.
 *
 * Thin wrappers over @mysten-incubation/memwal/account that pre-wire the
 * deployment ids + Sui client, so callers only pass intent. One MemWalAccount
 * per group (delegate keys are account-wide, so a shared account would leak
 * across groups — see ARCHITECTURE.md §3).
 */

import {
  createAccount,
  addDelegateKey,
  removeDelegateKey,
  generateDelegateKey,
} from "@mysten-incubation/memwal/account";
import type { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { MEMWAL, type SuiNetwork } from "./constants";
import type { SuiClient } from "./sui";

/**
 * Owner signer. The prototype uses a local keypair (reduced to its bech32 secret
 * for the SDK's `suiPrivateKey` path). The Option-B build will add a `walletSigner`
 * variant for zkLogin/Enoki — the MemWal account calls accept both.
 */
type OwnerSigner = { suiPrivateKey: string };

function ownerArgs(owner: Ed25519Keypair | OwnerSigner): OwnerSigner {
  if ("suiPrivateKey" in owner) return owner;
  return { suiPrivateKey: owner.getSecretKey() };
}

export interface NewGroupAccount {
  accountId: string;
  ownerAddress: string;
  botDelegate: { privateKey: string; suiAddress: string };
  createDigest: string;
  addDelegateDigest: string;
}

/**
 * Create a fresh MemWalAccount for a group and register the bot's delegate key.
 * Two owner-signed transactions: create_account, then add_delegate_key.
 */
export async function createGroupAccount(opts: {
  network: SuiNetwork;
  suiClient: SuiClient;
  owner: Ed25519Keypair | OwnerSigner;
  botLabel?: string;
}): Promise<NewGroupAccount> {
  const { packageId, registryId } = MEMWAL[opts.network];
  const signer = ownerArgs(opts.owner);

  const account = await createAccount({
    packageId,
    registryId,
    suiClient: opts.suiClient,
    suiNetwork: opts.network,
    ...signer,
  });

  const bot = await generateDelegateKey();
  const added = await addDelegateKey({
    packageId,
    accountId: account.accountId,
    publicKey: bot.publicKey,
    label: opts.botLabel ?? "hivemind-bot",
    suiClient: opts.suiClient,
    suiNetwork: opts.network,
    ...signer,
  });

  return {
    accountId: account.accountId,
    ownerAddress: account.owner,
    botDelegate: { privateKey: bot.privateKey, suiAddress: bot.suiAddress },
    createDigest: account.digest,
    addDelegateDigest: added.digest,
  };
}

/** Register a member's delegate key (owner-signed). Used by Flow 3 `/connect`. */
export async function registerMemberDelegate(opts: {
  network: SuiNetwork;
  suiClient: SuiClient;
  owner: Ed25519Keypair | OwnerSigner;
  accountId: string;
  label: string;
}): Promise<{ privateKey: string; suiAddress: string; digest: string }> {
  const { packageId } = MEMWAL[opts.network];
  const member = await generateDelegateKey();
  const added = await addDelegateKey({
    packageId,
    accountId: opts.accountId,
    publicKey: member.publicKey,
    label: opts.label,
    suiClient: opts.suiClient,
    suiNetwork: opts.network,
    ...ownerArgs(opts.owner),
  });
  return { privateKey: member.privateKey, suiAddress: member.suiAddress, digest: added.digest };
}

export { removeDelegateKey, generateDelegateKey };
