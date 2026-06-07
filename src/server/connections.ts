import { randomUUID } from "node:crypto";
import type { DocStore } from "../store/docstore";
import type { Vault } from "../store/vault";
import type { OAuth } from "./oauth";

const COLLECTION = "connections";

export interface ConnectionDoc {
  id: string;
  provider: string;
  kind: "apiKey" | "oauth2";
  account?: string;
  scopes: string[];
  vaultRef: string;
  refreshRef?: string;
  expiresAt?: string;
  createdAt: string;
}

export interface ConnectionMeta {
  id: string;
  provider: string;
  account?: string;
  createdAt: string;
}

function toMeta(c: ConnectionDoc): ConnectionMeta {
  return { id: c.id, provider: c.provider, account: c.account, createdAt: c.createdAt };
}

function expiringSoon(expiresAt?: string): boolean {
  if (!expiresAt) return false;
  return Date.parse(expiresAt) - Date.now() < 60_000;
}

export interface Connections {
  listConnections(spaceId: string): Promise<ConnectionMeta[]>;
  createApiKeyConnection(
    spaceId: string,
    provider: string,
    cred: Record<string, string>,
    account?: string,
  ): Promise<ConnectionMeta>;
  createOAuthConnection(
    spaceId: string,
    provider: string,
    tokens: {
      accessToken: string;
      refreshToken?: string;
      expiresAt?: string;
      scopes?: string[];
      account?: string;
    },
  ): Promise<ConnectionMeta>;
  updateConnection(
    spaceId: string,
    id: string,
    patch: { account?: string },
  ): Promise<ConnectionMeta>;
  deleteConnection(spaceId: string, id: string): Promise<void>;
  getAccessToken(
    spaceId: string,
    provider: string,
    connectionId?: string,
  ): Promise<string | null>;
  getCredential(
    spaceId: string,
    provider: string,
    connectionId?: string,
  ): Promise<Record<string, string> | null>;
}

export function createConnections(deps: {
  store: DocStore;
  vault: Vault;
  oauth: OAuth;
}): Connections {
  const { store, vault, oauth } = deps;

  async function firstConnectionFor(
    spaceId: string,
    provider: string,
  ): Promise<ConnectionDoc | null> {
    const docs = (await store.list(spaceId, COLLECTION)) as unknown as ConnectionDoc[];
    const matches = docs
      .filter((c) => c.provider === provider)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    return matches[0] ?? null;
  }

  async function connectionFor(
    spaceId: string,
    provider: string,
    connectionId?: string,
  ): Promise<ConnectionDoc | null> {
    if (connectionId) {
      const doc = (await store.get(spaceId, COLLECTION, connectionId)) as unknown as
        | ConnectionDoc
        | null;
      if (doc && doc.provider === provider) return doc;
    }
    return firstConnectionFor(spaceId, provider);
  }

  return {
    async listConnections(spaceId) {
      const docs = (await store.list(spaceId, COLLECTION)) as unknown as ConnectionDoc[];
      return docs.map(toMeta).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    },

    async createApiKeyConnection(spaceId, provider, cred, account) {
      const vaultRef = await vault.put(spaceId, JSON.stringify(cred));
      const doc: ConnectionDoc = {
        id: randomUUID(),
        provider,
        kind: "apiKey",
        account,
        scopes: [],
        vaultRef,
        createdAt: new Date().toISOString(),
      };
      await store.put(spaceId, COLLECTION, doc.id, doc as unknown as Record<string, unknown>);
      return toMeta(doc);
    },

    async createOAuthConnection(spaceId, provider, tokens) {
      const vaultRef = await vault.put(spaceId, tokens.accessToken);
      const refreshRef = tokens.refreshToken
        ? await vault.put(spaceId, tokens.refreshToken)
        : undefined;
      const doc: ConnectionDoc = {
        id: randomUUID(),
        provider,
        kind: "oauth2",
        account: tokens.account,
        scopes: tokens.scopes ?? [],
        vaultRef,
        refreshRef,
        expiresAt: tokens.expiresAt,
        createdAt: new Date().toISOString(),
      };
      await store.put(spaceId, COLLECTION, doc.id, doc as unknown as Record<string, unknown>);
      return toMeta(doc);
    },

    async updateConnection(spaceId, id, patch) {
      const doc = (await store.get(spaceId, COLLECTION, id)) as unknown as
        | ConnectionDoc
        | null;
      if (!doc) throw new Error("connection not found");
      const account = patch.account?.trim() || undefined;
      const next: ConnectionDoc = { ...doc, account };
      await store.put(
        spaceId,
        COLLECTION,
        id,
        next as unknown as Record<string, unknown>,
      );
      return toMeta(next);
    },

    async deleteConnection(spaceId, id) {
      const doc = (await store.get(spaceId, COLLECTION, id)) as unknown as ConnectionDoc | null;
      if (doc?.vaultRef) await vault.remove(spaceId, doc.vaultRef);
      if (doc?.refreshRef) await vault.remove(spaceId, doc.refreshRef);
      await store.remove(spaceId, COLLECTION, id);
    },

    async getAccessToken(spaceId, provider, connectionId) {
      const conn = await connectionFor(spaceId, provider, connectionId);
      if (!conn) return null;
      return resolveToken(spaceId, provider, conn);
    },

    async getCredential(spaceId, provider, connectionId) {
      const conn = await connectionFor(spaceId, provider, connectionId);
      if (!conn) return null;

      if (conn.kind === "apiKey") {
        const raw = await vault.get(spaceId, conn.vaultRef);
        if (raw == null) return null;
        try {
          const parsed = JSON.parse(raw);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            return parsed as Record<string, string>;
          }
          return { value: raw };
        } catch {
          return { value: raw };
        }
      }

      const accessToken = await resolveToken(spaceId, provider, conn);
      return accessToken == null ? null : { accessToken };
    },
  };

  async function resolveToken(
    spaceId: string,
    provider: string,
    conn: ConnectionDoc,
  ): Promise<string | null> {
    if (
      conn.kind === "oauth2" &&
      conn.refreshRef &&
      expiringSoon(conn.expiresAt)
    ) {
      const refreshToken = await vault.get(spaceId, conn.refreshRef);
      if (refreshToken) {
        try {
          const next = await oauth.refreshOAuthToken(
            spaceId,
            provider,
            refreshToken,
          );
          const updated: ConnectionDoc = {
            ...conn,
            expiresAt: next.expiresAt ?? conn.expiresAt,
          };
          await vault.remove(spaceId, conn.vaultRef);
          updated.vaultRef = await vault.put(spaceId, next.accessToken);
          if (next.refreshToken) {
            await vault.remove(spaceId, conn.refreshRef);
            updated.refreshRef = await vault.put(spaceId, next.refreshToken);
          }
          await store.put(
            spaceId,
            COLLECTION,
            updated.id,
            updated as unknown as Record<string, unknown>,
          );
          return next.accessToken;
        } catch {
          return vault.get(spaceId, conn.vaultRef);
        }
      }
    }

    return vault.get(spaceId, conn.vaultRef);
  }
}
