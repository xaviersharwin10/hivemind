/**
 * On-chain artifact recording for the bot.
 *
 * When a file is ingested, the bot appends it to the group's on-chain manifest
 * (`hivemind::registry::record_artifact`). The bot signs with the group's bot
 * delegate key — which the owner authorized as the group `writer` at onboarding —
 * and Enoki sponsors the gas, so this needs no funded bot wallet.
 *
 * Best-effort by design: the caller wraps it so a chain hiccup never blocks the
 * Walrus + MemWal ingestion that already succeeded.
 */

import { EnokiClient } from "@mysten/enoki";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import {
  type SuiNetwork,
  makeSuiClient,
  buildRecordArtifactTx,
  hivemindMoveTargets,
  hexToBytes,
} from "@hivemind/core";

export interface RecordArtifactArgs {
  groupId: string;
  botDelegateKey: string;
  blobId: string;
  name: string;
  mime: string;
  sha256: Uint8Array;
  sealed: boolean;
}

export interface ArtifactRecorder {
  record(args: RecordArtifactArgs): Promise<string>;
}

export function makeArtifactRecorder(apiKey: string, network: SuiNetwork): ArtifactRecorder {
  const enoki = new EnokiClient({ apiKey });
  const suiClient = makeSuiClient(network);
  return {
    async record(o) {
      const keypair = Ed25519Keypair.fromSecretKey(hexToBytes(o.botDelegateKey));
      const sender = keypair.getPublicKey().toSuiAddress();
      const tx = buildRecordArtifactTx({
        network,
        groupId: o.groupId,
        blobId: o.blobId,
        name: o.name,
        mime: o.mime,
        sha256: o.sha256,
        sealed: o.sealed,
      });
      const kindBytes = await tx.build({ client: suiClient as never, onlyTransactionKind: true });
      const sponsored = await enoki.createSponsoredTransaction({
        network,
        transactionKindBytes: Buffer.from(kindBytes).toString("base64"),
        sender,
        allowedAddresses: [sender],
        allowedMoveCallTargets: hivemindMoveTargets(network),
      });
      const { signature } = await keypair.signTransaction(Buffer.from(sponsored.bytes, "base64"));
      const { digest } = await enoki.executeSponsoredTransaction({ digest: sponsored.digest, signature });
      return digest;
    },
  };
}
