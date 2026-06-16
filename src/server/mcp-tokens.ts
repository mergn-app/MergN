import { randomBytes, createHash } from "node:crypto";
import type { DocStore } from "../store/docstore";

// Per-user bearer tokens for the REMOTE MCP endpoint. A token is bound to one
// space (the one it was created in). Only the hash is stored; the raw token is
// shown once. Stored in a global collection so verify() is a single lookup.
const NS = "_mcp";
const COLLECTION = "tokens";

export interface McpToken {
  id: string;
  userId: string;
  spaceId: string;
  name: string;
  createdAt: string;
  lastUsedAt?: string;
}

const hash = (raw: string) => createHash("sha256").update(raw).digest("hex");

export interface McpTokenStore {
  create(userId: string, spaceId: string, name: string): Promise<{ token: string; meta: McpToken }>;
  verify(raw: string): Promise<McpToken | null>;
  list(spaceId: string): Promise<McpToken[]>;
  revoke(spaceId: string, id: string): Promise<boolean>;
}

export function createMcpTokenStore(store: DocStore): McpTokenStore {
  return {
    async create(userId, spaceId, name) {
      const raw = "mrgn_" + randomBytes(24).toString("base64url");
      const h = hash(raw);
      const meta: McpToken = {
        id: h.slice(0, 12),
        userId,
        spaceId,
        name: name || "MCP token",
        createdAt: new Date().toISOString(),
      };
      await store.put(NS, COLLECTION, h, { ...meta, hash: h } as unknown as Record<string, unknown>);
      return { token: raw, meta };
    },
    async verify(raw) {
      if (!raw) return null;
      const doc = (await store.get(NS, COLLECTION, hash(raw))) as unknown as McpToken | null;
      return doc ?? null;
    },
    async list(spaceId) {
      const all = (await store.list(NS, COLLECTION)) as unknown as McpToken[];
      return all
        .filter((t) => t.spaceId === spaceId)
        .map((t) => ({ id: t.id, userId: t.userId, spaceId: t.spaceId, name: t.name, createdAt: t.createdAt, lastUsedAt: t.lastUsedAt }));
    },
    async revoke(spaceId, id) {
      const all = (await store.list(NS, COLLECTION)) as unknown as (McpToken & { hash?: string })[];
      const t = all.find((x) => x.id === id && x.spaceId === spaceId);
      if (!t) return false;
      await store.remove(NS, COLLECTION, t.hash ?? hash("")); // hash stored on the doc
      return true;
    },
  };
}
