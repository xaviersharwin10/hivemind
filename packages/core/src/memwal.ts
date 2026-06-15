/**
 * MemWal client wrapper — the bot (and members) read/write memory through here.
 * Memory is text-only; files live on Walrus and are referenced by blob id.
 */

import { MemWal } from "@mysten-incubation/memwal";
import { MEMWAL, DEFAULT_NAMESPACE, type SuiNetwork } from "./constants";

export interface MemwalClientOpts {
  /** Delegate private key (hex) — bot delegate, or a member delegate. */
  key: string;
  accountId: string;
  network?: SuiNetwork;
  serverUrl?: string;
  namespace?: string;
}

export function makeMemwal(opts: MemwalClientOpts): MemWal {
  const network = opts.network ?? "testnet";
  return MemWal.create({
    key: opts.key,
    accountId: opts.accountId,
    serverUrl: opts.serverUrl ?? MEMWAL[network].relayerUrl,
    namespace: opts.namespace ?? DEFAULT_NAMESPACE,
  });
}
