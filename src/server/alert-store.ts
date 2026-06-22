import { randomUUID } from "node:crypto";
import type { DocStore } from "../store/docstore";
import type { Vault } from "../store/vault";
import type { ChannelKind, ChannelSecret } from "./alert-channels";
import type { Severity, AlertCategory } from "./alert-router";

// Per-space alert channels. Non-secret config lives in the DocStore; the secret
// (bot token / webhook URL / recipient) is encrypted in the vault and referenced
// by vaultRef — same pattern as workflow connections.
const COLLECTION = "alert_channels";

export interface AlertChannelMeta {
  id: string;
  kind: ChannelKind;
  label?: string;
  minSeverity?: Severity; // only deliver alerts at/above this (default: all)
  categories?: AlertCategory[]; // only these event kinds (default: all)
  enabled: boolean;
  createdAt: string;
}

interface AlertChannelDoc extends AlertChannelMeta {
  spaceId: string;
  vaultRef: string;
}

export interface AlertChannelStore {
  list(spaceId: string): Promise<AlertChannelMeta[]>;
  // returns the (decrypted) secret + meta for delivery
  resolve(spaceId: string): Promise<Array<{ meta: AlertChannelMeta; secret: ChannelSecret }>>;
  add(
    spaceId: string,
    input: {
      kind: ChannelKind;
      label?: string;
      minSeverity?: Severity;
      categories?: AlertCategory[];
      secret: ChannelSecret;
    },
  ): Promise<AlertChannelMeta>;
  setEnabled(spaceId: string, id: string, enabled: boolean): Promise<void>;
  remove(spaceId: string, id: string): Promise<void>;
}

const toMeta = (d: AlertChannelDoc): AlertChannelMeta => ({
  id: d.id,
  kind: d.kind,
  label: d.label,
  minSeverity: d.minSeverity,
  categories: d.categories,
  enabled: d.enabled,
  createdAt: d.createdAt,
});

export function createAlertChannelStore(store: DocStore, vault: Vault): AlertChannelStore {
  const all = async (spaceId: string): Promise<AlertChannelDoc[]> =>
    (await store.list(spaceId, COLLECTION)) as unknown as AlertChannelDoc[];

  return {
    async list(spaceId) {
      return (await all(spaceId)).map(toMeta);
    },

    async resolve(spaceId) {
      const out: Array<{ meta: AlertChannelMeta; secret: ChannelSecret }> = [];
      for (const d of await all(spaceId)) {
        if (!d.enabled) continue;
        const raw = await vault.get(spaceId, d.vaultRef).catch(() => null);
        if (!raw) continue; // secret missing/unreadable → skip (don't crash delivery)
        try {
          out.push({ meta: toMeta(d), secret: JSON.parse(raw) as ChannelSecret });
        } catch {
          // corrupt secret → skip
        }
      }
      return out;
    },

    async add(spaceId, input) {
      const id = randomUUID();
      const vaultRef = await vault.put(spaceId, JSON.stringify(input.secret));
      const doc: AlertChannelDoc = {
        id,
        spaceId,
        kind: input.kind,
        label: input.label,
        minSeverity: input.minSeverity,
        categories: input.categories,
        enabled: true,
        vaultRef,
        createdAt: new Date().toISOString(),
      };
      await store.put(spaceId, COLLECTION, id, doc as unknown as Record<string, unknown>);
      return toMeta(doc);
    },

    async setEnabled(spaceId, id, enabled) {
      const doc = (await store.get(spaceId, COLLECTION, id)) as unknown as AlertChannelDoc | null;
      if (!doc) return;
      await store.put(spaceId, COLLECTION, id, { ...doc, enabled } as unknown as Record<string, unknown>);
    },

    async remove(spaceId, id) {
      const doc = (await store.get(spaceId, COLLECTION, id)) as unknown as AlertChannelDoc | null;
      if (doc?.vaultRef) await vault.remove(spaceId, doc.vaultRef).catch(() => {});
      await store.remove(spaceId, COLLECTION, id);
    },
  };
}
