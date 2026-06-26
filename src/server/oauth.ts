import { randomUUID } from "node:crypto";
import type { DocStore } from "../store/docstore";
import type { Vault } from "../store/vault";
import { authOf, type Registry } from "../providers/registry";

const APPS = "oauthapps";

interface OAuthAppDoc {
  provider: string;
  clientId: string;
  clientSecretRef: string;
  authUrl?: string;
  tokenUrl?: string;
  scopes?: string[];
}

export interface OAuthTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: string;
  scopes?: string[];
}

export interface ResolvedOAuth {
  clientId: string;
  clientSecret: string;
  authUrl: string;
  tokenUrl: string;
  scopes: string[];
  authParams: Record<string, string>;
  tokenAuthStyle: "body" | "basic";
}

export interface OAuth {
  saveOAuthApp(
    spaceId: string,
    provider: string,
    input: {
      clientId: string;
      clientSecret: string;
      authUrl?: string;
      tokenUrl?: string;
      scopes?: string[];
    },
  ): Promise<void>;
  deleteOAuthApp(spaceId: string, provider: string): Promise<void>;
  oauthStatus(
    spaceId: string,
    provider: string,
  ): Promise<{ configured: boolean; needsEndpoints: boolean }>;
  startOAuth(spaceId: string, provider: string): Promise<{ url: string }>;
  completeOAuth(
    state: string,
    code: string,
  ): Promise<{ spaceId: string; provider: string; tokens: OAuthTokens }>;
  refreshOAuthToken(
    spaceId: string,
    provider: string,
    refreshToken: string,
  ): Promise<OAuthTokens>;
}

export function redirectUri(): string {
  const base = process.env.APP_URL ?? "http://localhost:5173";
  return `${base.replace(/\/$/, "")}/api/oauth/callback`;
}

async function postToken(
  tokenUrl: string,
  params: Record<string, string>,
  basicAuth?: string,
): Promise<OAuthTokens> {
  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
    Accept: "application/json",
  };
  // Some providers (Notion, Spotify, Zoom…) require the client id/secret as an
  // HTTP Basic header on the token endpoint instead of in the body.
  if (basicAuth)
    headers.Authorization =
      "Basic " + Buffer.from(basicAuth).toString("base64");
  const res = await fetch(tokenUrl, {
    method: "POST",
    headers,
    body: new URLSearchParams(params).toString(),
  });
  const data = (await res.json()) as Record<string, unknown>;
  if (!res.ok || data.error)
    throw new Error(
      `token exchange failed: ${(data.error_description ?? data.error ?? res.status) as string}`,
    );
  const accessToken = data.access_token as string | undefined;
  if (!accessToken) throw new Error("no access_token in token response");
  const expiresIn =
    typeof data.expires_in === "number" ? data.expires_in : undefined;
  return {
    accessToken,
    refreshToken: (data.refresh_token as string | undefined) ?? undefined,
    expiresAt: expiresIn
      ? new Date(Date.now() + expiresIn * 1000).toISOString()
      : undefined,
    scopes:
      typeof data.scope === "string"
        ? data.scope.split(/[ ,]+/).filter(Boolean)
        : undefined,
  };
}

export function createOAuth(deps: {
  store: DocStore;
  vault: Vault;
  registry: Registry;
}): OAuth {
  const { store, vault, registry } = deps;

  const pending = new Map<
    string,
    { spaceId: string; provider: string; createdAt: number }
  >();
  const TTL = 10 * 60_000;

  function sweep(): void {
    const now = Date.now();
    for (const [k, v] of pending) if (now - v.createdAt > TTL) pending.delete(k);
  }

  async function getOAuthApp(
    spaceId: string,
    provider: string,
  ): Promise<OAuthAppDoc | null> {
    return (await store.get(spaceId, APPS, provider)) as unknown as OAuthAppDoc | null;
  }

  async function resolveOAuthConfig(
    spaceId: string,
    provider: string,
  ): Promise<ResolvedOAuth> {
    const spec = registry.getProvider(spaceId, provider);
    if (!spec) throw new Error(`unknown provider: ${provider}`);
    const auth = authOf(spec);
    if (auth.type !== "oauth2")
      throw new Error(`provider ${provider} is not oauth2`);
    const app = await getOAuthApp(spaceId, provider);

    const clientId = process.env[auth.clientIdEnv] || app?.clientId || "";
    const clientSecret =
      process.env[auth.clientSecretEnv] ||
      (app?.clientSecretRef
        ? ((await vault.get(spaceId, app.clientSecretRef)) ?? "")
        : "");
    const authUrl = auth.authUrl || app?.authUrl || "";
    const tokenUrl = auth.tokenUrl || app?.tokenUrl || "";
    const scopes = auth.scopes.length ? auth.scopes : (app?.scopes ?? []);

    const missing: string[] = [];
    if (!clientId) missing.push("client ID");
    if (!clientSecret) missing.push("client secret");
    if (!authUrl) missing.push("authorize URL");
    if (!tokenUrl) missing.push("token URL");
    if (missing.length)
      throw new Error(`OAuth app not configured: missing ${missing.join(", ")}`);

    const authParams =
      auth.type === "oauth2" ? (auth.authParams ?? {}) : {};
    const tokenAuthStyle: "body" | "basic" =
      auth.type === "oauth2" ? (auth.tokenAuthStyle ?? "body") : "body";

    return {
      clientId,
      clientSecret,
      authUrl,
      tokenUrl,
      scopes,
      authParams,
      tokenAuthStyle,
    };
  }

  return {
    async saveOAuthApp(spaceId, provider, input) {
      const existing = await getOAuthApp(spaceId, provider);
      if (existing?.clientSecretRef)
        await vault.remove(spaceId, existing.clientSecretRef);
      const clientSecretRef = await vault.put(spaceId, input.clientSecret);
      const doc: OAuthAppDoc = {
        provider,
        clientId: input.clientId,
        clientSecretRef,
        authUrl: input.authUrl,
        tokenUrl: input.tokenUrl,
        scopes: input.scopes,
      };
      await store.put(
        spaceId,
        APPS,
        provider,
        doc as unknown as Record<string, unknown>,
      );
    },

    async deleteOAuthApp(spaceId, provider) {
      const app = await getOAuthApp(spaceId, provider);
      if (app?.clientSecretRef)
        await vault.remove(spaceId, app.clientSecretRef);
      await store.remove(spaceId, APPS, provider);
    },

    async oauthStatus(spaceId, provider) {
      const spec = registry.getProvider(spaceId, provider);
      if (!spec) return { configured: false, needsEndpoints: false };
      const auth = authOf(spec);
      if (auth.type !== "oauth2")
        return { configured: false, needsEndpoints: false };
      const app = await getOAuthApp(spaceId, provider);
      const needsEndpoints =
        !(auth.authUrl && auth.tokenUrl) && !(app?.authUrl && app?.tokenUrl);
      try {
        await resolveOAuthConfig(spaceId, provider);
        return { configured: true, needsEndpoints };
      } catch {
        return { configured: false, needsEndpoints };
      }
    },

    async startOAuth(spaceId, provider) {
      const cfg = await resolveOAuthConfig(spaceId, provider);
      sweep();
      const state = randomUUID();
      pending.set(state, { spaceId, provider, createdAt: Date.now() });
      const u = new URL(cfg.authUrl);
      u.searchParams.set("client_id", cfg.clientId);
      u.searchParams.set("redirect_uri", redirectUri());
      u.searchParams.set("scope", cfg.scopes.join(" "));
      u.searchParams.set("state", state);
      u.searchParams.set("response_type", "code");
      // Provider-specific extras (e.g. Google access_type=offline+prompt=consent,
      // Dropbox token_access_type=offline) come from the catalog's oauth config.
      for (const [k, v] of Object.entries(cfg.authParams))
        u.searchParams.set(k, v);
      return { url: u.toString() };
    },

    async completeOAuth(state, code) {
      const p = pending.get(state);
      if (!p) throw new Error("invalid or expired state");
      pending.delete(state);
      const cfg = await resolveOAuthConfig(p.spaceId, p.provider);
      const basic = cfg.tokenAuthStyle === "basic";
      const params: Record<string, string> = {
        code,
        redirect_uri: redirectUri(),
        grant_type: "authorization_code",
      };
      if (!basic) {
        params.client_id = cfg.clientId;
        params.client_secret = cfg.clientSecret;
      }
      const tokens = await postToken(
        cfg.tokenUrl,
        params,
        basic ? `${cfg.clientId}:${cfg.clientSecret}` : undefined,
      );
      return { spaceId: p.spaceId, provider: p.provider, tokens };
    },

    async refreshOAuthToken(spaceId, provider, refreshToken) {
      const cfg = await resolveOAuthConfig(spaceId, provider);
      const basic = cfg.tokenAuthStyle === "basic";
      const params: Record<string, string> = {
        refresh_token: refreshToken,
        grant_type: "refresh_token",
      };
      if (!basic) {
        params.client_id = cfg.clientId;
        params.client_secret = cfg.clientSecret;
      }
      return postToken(
        cfg.tokenUrl,
        params,
        basic ? `${cfg.clientId}:${cfg.clientSecret}` : undefined,
      );
    },
  };
}
