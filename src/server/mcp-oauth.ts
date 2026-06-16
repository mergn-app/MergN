import { randomBytes, createHash } from "node:crypto";
import type { DocStore } from "../store/docstore";

// OAuth 2.1 Authorization Server for the REMOTE MCP endpoint.
//
// This is what lets hosted chat clients (claude.ai web, ChatGPT connectors,
// Gemini) connect to /mcp WITHOUT a hand-pasted bearer token: they discover the
// metadata, dynamically register (RFC 7591), run an authorization-code + PKCE
// flow against /authorize + /token, and send the resulting access token to /mcp.
//
// User authentication during /authorize is delegated to the app's existing
// better-auth session (the user must be signed into MergN in the same browser);
// we only mint MCP access tokens bound to a (userId, spaceId). CLI clients that
// accept a manual token keep using the simpler mcp-tokens.ts path — both verify
// to the same { userId, spaceId } shape at /mcp.
const NS = "_mcp";
const C_CLIENTS = "oauth_clients";
const C_CODES = "oauth_codes";
const C_TOKENS = "oauth_tokens";
const C_REFRESH = "oauth_refresh";

const CODE_TTL_MS = 10 * 60 * 1000; // 10 min — single use
const ACCESS_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const REFRESH_TTL_MS = 180 * 24 * 60 * 60 * 1000; // 180 days

const sha256 = (raw: string) => createHash("sha256").update(raw).digest("hex");
const b64urlSha256 = (raw: string) =>
  createHash("sha256").update(raw).digest("base64url");
const rand = (n = 24) => randomBytes(n).toString("base64url");

export interface OAuthClient {
  client_id: string;
  client_name?: string;
  redirect_uris: string[];
  token_endpoint_auth_method: "none";
  created_at: string;
}

export interface AuthorizeRequest {
  client_id: string;
  redirect_uri: string;
  response_type: string;
  code_challenge: string;
  code_challenge_method: string;
  state?: string;
  scope?: string;
  resource?: string;
}

// Thrown for protocol errors that must redirect back to the client with an
// `error` query param (RFC 6749 §4.1.2.1). Bare validation (bad client / bad
// redirect_uri) must NOT redirect and is signalled with `redirectable: false`.
export class OAuthError extends Error {
  constructor(
    readonly code: string,
    readonly description: string,
    readonly redirectable = true,
  ) {
    super(description);
  }
}

export interface McpOAuth {
  metadataProtectedResource(issuer: string): Record<string, unknown>;
  metadataAuthorizationServer(issuer: string): Record<string, unknown>;
  registerClient(body: unknown): Promise<OAuthClient>;
  /** Validate an /authorize request and resolve its client. Throws OAuthError. */
  prepareAuthorize(query: Record<string, string | undefined>): Promise<{
    client: OAuthClient;
    req: AuthorizeRequest;
  }>;
  /** Mint a single-use authorization code after the user approves. */
  issueCode(req: AuthorizeRequest, userId: string, spaceId: string): Promise<string>;
  /** Exchange code/refresh at /token. Throws OAuthError. */
  exchangeToken(body: Record<string, string | undefined>): Promise<{
    access_token: string;
    token_type: "Bearer";
    expires_in: number;
    refresh_token: string;
    scope: string;
  }>;
  /** Verify an access token presented at /mcp. */
  verifyAccessToken(raw: string): Promise<{ userId: string; spaceId: string } | null>;
}

export function createMcpOAuth(store: DocStore): McpOAuth {
  const getClient = async (id: string) =>
    (await store.get(NS, C_CLIENTS, id)) as unknown as OAuthClient | null;

  return {
    metadataProtectedResource(issuer) {
      return {
        resource: `${issuer}/mcp`,
        authorization_servers: [issuer],
        bearer_methods_supported: ["header"],
        scopes_supported: ["mcp"],
      };
    },

    metadataAuthorizationServer(issuer) {
      return {
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        registration_endpoint: `${issuer}/register`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
        scopes_supported: ["mcp"],
      };
    },

    async registerClient(body) {
      const b = (body ?? {}) as Record<string, unknown>;
      const redirect_uris = Array.isArray(b.redirect_uris)
        ? (b.redirect_uris as unknown[]).filter(
            (u): u is string => typeof u === "string" && /^https?:\/\//.test(u),
          )
        : [];
      if (redirect_uris.length === 0)
        throw new OAuthError("invalid_redirect_uri", "redirect_uris required", false);
      const client: OAuthClient = {
        client_id: "mcpc_" + rand(18),
        client_name: typeof b.client_name === "string" ? b.client_name : undefined,
        redirect_uris,
        token_endpoint_auth_method: "none",
        created_at: new Date().toISOString(),
      };
      await store.put(
        NS,
        C_CLIENTS,
        client.client_id,
        client as unknown as Record<string, unknown>,
      );
      return client;
    },

    async prepareAuthorize(query) {
      const client_id = query.client_id ?? "";
      const redirect_uri = query.redirect_uri ?? "";
      const client = client_id ? await getClient(client_id) : null;
      // Bad client / redirect → cannot safely redirect; surface to the user.
      if (!client)
        throw new OAuthError("invalid_client", "unknown client_id", false);
      if (!redirect_uri || !client.redirect_uris.includes(redirect_uri))
        throw new OAuthError(
          "invalid_redirect_uri",
          "redirect_uri not registered for this client",
          false,
        );
      // From here, errors are redirectable to redirect_uri.
      if (query.response_type !== "code")
        throw new OAuthError("unsupported_response_type", "only code is supported");
      if (query.code_challenge_method !== "S256")
        throw new OAuthError("invalid_request", "PKCE S256 required");
      if (!query.code_challenge)
        throw new OAuthError("invalid_request", "code_challenge required");
      const req: AuthorizeRequest = {
        client_id,
        redirect_uri,
        response_type: "code",
        code_challenge: query.code_challenge,
        code_challenge_method: "S256",
        state: query.state,
        scope: query.scope ?? "mcp",
        resource: query.resource,
      };
      return { client, req };
    },

    async issueCode(req, userId, spaceId) {
      const code = rand(24);
      await store.put(NS, C_CODES, code, {
        code,
        client_id: req.client_id,
        redirect_uri: req.redirect_uri,
        code_challenge: req.code_challenge,
        user_id: userId,
        space_id: spaceId,
        scope: req.scope ?? "mcp",
        resource: req.resource,
        expires_at: new Date(Date.now() + CODE_TTL_MS).toISOString(),
      });
      return code;
    },

    async exchangeToken(body) {
      const grant = body.grant_type;
      if (grant === "authorization_code") {
        const code = body.code ?? "";
        const doc = (await store.get(NS, C_CODES, code)) as unknown as {
          client_id: string;
          redirect_uri: string;
          code_challenge: string;
          user_id: string;
          space_id: string;
          scope: string;
          expires_at: string;
        } | null;
        if (!doc) throw new OAuthError("invalid_grant", "unknown or used code");
        await store.remove(NS, C_CODES, code); // single use
        if (new Date(doc.expires_at).getTime() < Date.now())
          throw new OAuthError("invalid_grant", "code expired");
        if (body.client_id && body.client_id !== doc.client_id)
          throw new OAuthError("invalid_grant", "client_id mismatch");
        if (body.redirect_uri && body.redirect_uri !== doc.redirect_uri)
          throw new OAuthError("invalid_grant", "redirect_uri mismatch");
        const verifier = body.code_verifier ?? "";
        if (!verifier || b64urlSha256(verifier) !== doc.code_challenge)
          throw new OAuthError("invalid_grant", "PKCE verification failed");
        return issueTokens(store, doc.user_id, doc.space_id, doc.client_id, doc.scope);
      }
      if (grant === "refresh_token") {
        const raw = body.refresh_token ?? "";
        const doc = (await store.get(NS, C_REFRESH, sha256(raw))) as unknown as {
          user_id: string;
          space_id: string;
          client_id: string;
          scope: string;
          expires_at: string;
        } | null;
        if (!doc) throw new OAuthError("invalid_grant", "unknown refresh_token");
        if (new Date(doc.expires_at).getTime() < Date.now()) {
          await store.remove(NS, C_REFRESH, sha256(raw));
          throw new OAuthError("invalid_grant", "refresh_token expired");
        }
        await store.remove(NS, C_REFRESH, sha256(raw)); // rotate
        return issueTokens(store, doc.user_id, doc.space_id, doc.client_id, doc.scope);
      }
      throw new OAuthError("unsupported_grant_type", "unsupported grant_type");
    },

    async verifyAccessToken(raw) {
      if (!raw) return null;
      const doc = (await store.get(NS, C_TOKENS, sha256(raw))) as unknown as {
        user_id: string;
        space_id: string;
        expires_at: string;
      } | null;
      if (!doc) return null;
      if (new Date(doc.expires_at).getTime() < Date.now()) {
        await store.remove(NS, C_TOKENS, sha256(raw));
        return null;
      }
      return { userId: doc.user_id, spaceId: doc.space_id };
    },
  };
}

async function issueTokens(
  store: DocStore,
  userId: string,
  spaceId: string,
  clientId: string,
  scope: string,
) {
  const access = "mrgn_at_" + rand(24);
  const refresh = "mrgn_rt_" + rand(24);
  await store.put(NS, C_TOKENS, sha256(access), {
    hash: sha256(access),
    user_id: userId,
    space_id: spaceId,
    client_id: clientId,
    scope,
    expires_at: new Date(Date.now() + ACCESS_TTL_MS).toISOString(),
  });
  await store.put(NS, C_REFRESH, sha256(refresh), {
    hash: sha256(refresh),
    user_id: userId,
    space_id: spaceId,
    client_id: clientId,
    scope,
    expires_at: new Date(Date.now() + REFRESH_TTL_MS).toISOString(),
  });
  return {
    access_token: access,
    token_type: "Bearer" as const,
    expires_in: Math.floor(ACCESS_TTL_MS / 1000),
    refresh_token: refresh,
    scope,
  };
}
