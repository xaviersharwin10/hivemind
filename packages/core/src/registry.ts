/**
 * Group registry — maps a chat (Telegram chat id, or a prototype group id) to its
 * MemWalAccount + bot delegate. JSON file for the prototype; swap for sqlite/postgres
 * in the bot service.
 *
 * NOTE (Option B): in production no owner private key is stored — the group creator
 * owns the account via zkLogin/Enoki. The prototype persists `ownerSecret` only so a
 * local keypair owner survives re-runs (one address = one account).
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { DEFAULT_NAMESPACE } from "./constants";

export interface GroupRecord {
  groupId: string;
  ownerAddress: string;
  /** PROTOTYPE ONLY — bech32 owner secret. Removed in the Option-B (zkLogin) build. */
  ownerSecret?: string;
  accountId: string;
  botDelegateKey: string;
  /** Our on-chain `hivemind::registry` Group object id for this chat (if registered). */
  onchainGroupId?: string;
  namespace: string;
  members: { label: string; suiAddress: string; addedAt: number }[];
  createdAt: number;
}

type RegistryFile = Record<string, GroupRecord>;

export class Registry {
  constructor(private readonly path: string) {}

  private async load(): Promise<RegistryFile> {
    try {
      return JSON.parse(await readFile(this.path, "utf8")) as RegistryFile;
    } catch {
      return {};
    }
  }

  private async save(data: RegistryFile): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, JSON.stringify(data, null, 2));
  }

  async get(groupId: string): Promise<GroupRecord | undefined> {
    return (await this.load())[groupId];
  }

  async upsert(record: Omit<GroupRecord, "namespace" | "members" | "createdAt"> & Partial<GroupRecord>): Promise<GroupRecord> {
    const data = await this.load();
    const existing = data[record.groupId];
    const defaults = { namespace: DEFAULT_NAMESPACE, members: [], createdAt: Date.now() };
    const merged: GroupRecord = { ...defaults, ...existing, ...record };
    data[record.groupId] = merged;
    await this.save(data);
    return merged;
  }

  async addMember(groupId: string, member: GroupRecord["members"][number]): Promise<void> {
    const data = await this.load();
    const rec = data[groupId];
    if (!rec) throw new Error(`No group record for ${groupId}`);
    rec.members.push(member);
    await this.save(data);
  }
}
