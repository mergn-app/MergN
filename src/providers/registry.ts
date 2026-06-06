import type { DocStore } from "../store/docstore";
import type { ProviderClient } from "../atoms/index";

const COLLECTION = "providers";

export interface AuthField {
  name: string;
  label: string;
  type: "text" | "password";
  placeholder?: string;
  required?: boolean;
}

export type AuthSpec =
  | { type: "none" }
  | { type: "apiKey"; fields: AuthField[] }
  | {
      type: "oauth2";
      authUrl: string;
      tokenUrl: string;
      scopes: string[];
      clientIdEnv: string;
      clientSecretEnv: string;
    };

export interface SetupStep {
  title: string;
  detail?: string;
  link?: { label: string; href: string };
  copyRedirectUrl?: boolean;
}

export interface SetupGuide {
  intro?: string;
  steps: SetupStep[];
}

export interface PublicAuth {
  type: AuthSpec["type"];
  name: string;
  fields?: AuthField[];
  scopes?: string[];
  setupGuide?: SetupGuide;
}

export interface ProviderSpec {
  id: string;
  name: string;
  scopes: string[];
  keywords: string[];
  apiDoc: string;
  env?: string;
  auth?: AuthSpec;
  setupGuide?: SetupGuide;
  egressDomain?: string;
  aiWritten?: boolean;
  // JS function body (token, fetch) => clientObject. Used by the remote code-exec
  // broker (proxy mode) to run the provider host-side without leaking the token.
  clientSource?: string;
  createClient: (token: string | undefined) => ProviderClient;
}

export interface ProviderDraft {
  id: string;
  name: string;
  keywords: string[];
  authEnv: string;
  egressDomain: string;
  apiDoc: string;
  clientSource: string;
  setupGuide?: SetupGuide;
}

const builtins = new Map<string, ProviderSpec>();

builtins.set("slack", {
  id: "slack",
  name: "Slack",
  scopes: ["chat:write", "channels:read"],
  keywords: ["slack", "message", "notify", "notification", "chat", "channel", "alert"],
  egressDomain: "slack.com",
  apiDoc:
    "give the func a 'channel' input and a 'text' input, then call: const ts = await ctx.connections.<name>.postMessage(input.channel, input.text); return { ts }. Connection: name 'slack', provider 'slack', scope 'chat:write'.",
  env: "SLACK_TOKEN",
  clientSource: `
    const send = async (a, b) => {
      const arg = (typeof a === 'object' && a !== null) ? a : null;
      const channel = arg ? arg.channel : a;
      const text = arg ? arg.text : b;
      const res = await fetch('https://slack.com/api/chat.postMessage', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ channel, text }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error('slack error: ' + data.error);
      return data.ts || '';
    };
    return new Proxy({}, { get: () => send });
  `,
  createClient: (token) => {
    const send = async (a: unknown, b?: unknown): Promise<string> => {
      const arg =
        typeof a === "object" && a !== null ? (a as Record<string, unknown>) : null;
      const channel = arg ? arg.channel : a;
      const text = arg ? arg.text : b;
      const res = await fetch("https://slack.com/api/chat.postMessage", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json; charset=utf-8",
        },
        body: JSON.stringify({ channel, text }),
      });
      const data = (await res.json()) as {
        ok: boolean;
        ts?: string;
        error?: string;
      };
      if (!data.ok) throw new Error(`slack error: ${data.error}`);
      return data.ts ?? "";
    };
    return new Proxy({}, { get: () => send });
  },
});

builtins.set("github", {
  id: "github",
  name: "GitHub",
  scopes: ["repo"],
  keywords: ["github", "git", "issue", "repo", "repository", "pull request", "pr", "commit"],
  egressDomain: "api.github.com",
  apiDoc:
    "methods: const me = await ctx.connections.<name>.getUser(); returns { login, id, name }. const issue = await ctx.connections.<name>.createIssue({ owner, repo, title, body }); returns { number, url }. Connection: name 'github', provider 'github'.",
  auth: {
    type: "oauth2",
    authUrl: "https://github.com/login/oauth/authorize",
    tokenUrl: "https://github.com/login/oauth/access_token",
    scopes: ["repo"],
    clientIdEnv: "GITHUB_CLIENT_ID",
    clientSecretEnv: "GITHUB_CLIENT_SECRET",
  },
  setupGuide: {
    intro: "GitHub needs an OAuth App that you own — it takes about a minute.",
    steps: [
      {
        title: "Open GitHub Developer Settings",
        detail: "Go to Settings → Developer settings → OAuth Apps → New OAuth App.",
        link: {
          label: "Open OAuth Apps",
          href: "https://github.com/settings/developers",
        },
      },
      {
        title: "Set the Authorization callback URL",
        detail: "Paste this exact value into the callback URL field.",
        copyRedirectUrl: true,
      },
      {
        title: "Copy your credentials",
        detail:
          "Copy the Client ID, then click 'Generate a new client secret' and copy that too. Paste both below.",
      },
    ],
  },
  clientSource: `
    const api = async (path, init) => {
      const res = await fetch('https://api.github.com' + path, {
        ...init,
        headers: {
          Authorization: 'Bearer ' + token,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'workflow-builder',
          ...((init && init.headers) || {}),
        },
      });
      const data = await res.json();
      if (!res.ok) throw new Error('github error: ' + (data.message || res.status));
      return data;
    };
    return {
      getUser: async () => {
        const u = await api('/user');
        return { login: u.login, id: u.id, name: u.name };
      },
      createIssue: async (arg) => {
        const a = arg || {};
        const issue = await api('/repos/' + a.owner + '/' + a.repo + '/issues', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: a.title, body: a.body }),
        });
        return { number: issue.number, url: issue.html_url };
      },
    };
  `,
  createClient: (token) => {
    const api = async (
      path: string,
      init?: RequestInit,
    ): Promise<Record<string, unknown>> => {
      const res = await fetch(`https://api.github.com${path}`, {
        ...init,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "User-Agent": "workflow-builder",
          ...(init?.headers ?? {}),
        },
      });
      const data = (await res.json()) as Record<string, unknown>;
      if (!res.ok)
        throw new Error(`github error: ${(data.message as string) ?? res.status}`);
      return data;
    };
    return {
      getUser: async () => {
        const u = await api("/user");
        return { login: u.login, id: u.id, name: u.name };
      },
      createIssue: async (arg: unknown) => {
        const a = (arg ?? {}) as Record<string, unknown>;
        const issue = await api(`/repos/${a.owner}/${a.repo}/issues`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: a.title, body: a.body }),
        });
        return { number: issue.number, url: issue.html_url };
      },
    };
  },
});

builtins.set("http", {
  id: "http",
  name: "HTTP",
  scopes: [],
  keywords: ["http", "https", "api", "fetch", "request", "rest", "url", "webhook", "get", "post"],
  apiDoc:
    "call: const data = await ctx.connections.<name>.get(url); (returns parsed JSON) or .post(url, jsonBody). Connection: name 'http', provider 'http', no scopes.",
  clientSource: `
    return {
      get: async (url) => {
        const res = await fetch(String(url));
        return res.json();
      },
      post: async (url, body) => {
        const res = await fetch(String(url), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        return res.json();
      },
    };
  `,
  createClient: () => ({
    get: async (url: unknown) => {
      const res = await fetch(String(url));
      return res.json();
    },
    post: async (url: unknown, body: unknown) => {
      const res = await fetch(String(url), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      return res.json();
    },
  }),
});

function guardedFetch(domain: string) {
  return async (input: unknown, init?: unknown): Promise<Response> => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input instanceof Request
            ? input.url
            : String(input);
    let host: string;
    try {
      host = new URL(url).host;
    } catch {
      throw new Error("egress blocked: invalid url");
    }
    const allowed = host === domain || host.endsWith(`.${domain}`);
    if (!allowed) {
      throw new Error(`egress blocked: ${host} (allowed: ${domain})`);
    }
    return fetch(url, init as RequestInit | undefined);
  };
}

function specFromDraft(d: ProviderDraft): ProviderSpec {
  return {
    id: d.id,
    name: d.name,
    scopes: [],
    keywords: d.keywords,
    apiDoc: d.apiDoc,
    env: d.authEnv || undefined,
    setupGuide: d.setupGuide,
    egressDomain: d.egressDomain,
    aiWritten: true,
    clientSource: d.clientSource,
    createClient: (token) => {
      const scopedFetch = d.egressDomain ? guardedFetch(d.egressDomain) : fetch;
      const factory = new Function("token", "fetch", d.clientSource);
      return factory(token, scopedFetch) as ProviderClient;
    },
  };
}

export function authOf(spec: ProviderSpec): AuthSpec {
  if (spec.auth) return spec.auth;
  if (spec.env)
    return {
      type: "apiKey",
      fields: [
        { name: "key", label: "API key", type: "password", required: true },
      ],
    };
  return { type: "none" };
}

export function publicAuth(spec: ProviderSpec): PublicAuth {
  const auth = authOf(spec);
  const guide = spec.setupGuide;
  if (auth.type === "apiKey")
    return { type: "apiKey", name: spec.name, fields: auth.fields, setupGuide: guide };
  if (auth.type === "oauth2")
    return { type: "oauth2", name: spec.name, scopes: auth.scopes, setupGuide: guide };
  return { type: "none", name: spec.name, setupGuide: guide };
}

export interface Registry {
  ensureSpace(spaceId: string): Promise<void>;
  getProvider(spaceId: string, id: string): ProviderSpec | undefined;
  searchProviders(spaceId: string, query: string): ProviderSpec[];
  registerProviderFromDraft(spaceId: string, draft: ProviderDraft): ProviderSpec;
  persistProvider(spaceId: string, draft: ProviderDraft): Promise<void>;
  getProviderDraft(spaceId: string, id: string): Promise<ProviderDraft | null>;
  needsAuth(spaceId: string, providerId: string): boolean;
  buildClientWithSecret(
    spaceId: string,
    providerId: string,
    secret: string | undefined,
  ): ProviderClient | null;
}

export function createRegistry(store: DocStore): Registry {
  const spaceDrafts = new Map<string, Map<string, ProviderSpec>>();
  const loaded = new Set<string>();

  function draftsFor(spaceId: string): Map<string, ProviderSpec> {
    let m = spaceDrafts.get(spaceId);
    if (!m) {
      m = new Map();
      spaceDrafts.set(spaceId, m);
    }
    return m;
  }

  function getProvider(spaceId: string, id: string): ProviderSpec | undefined {
    return draftsFor(spaceId).get(id) ?? builtins.get(id);
  }

  function registerProviderFromDraft(
    spaceId: string,
    draft: ProviderDraft,
  ): ProviderSpec {
    const spec = specFromDraft(draft);
    draftsFor(spaceId).set(spec.id, spec);
    return spec;
  }

  return {
    getProvider,
    registerProviderFromDraft,

    async ensureSpace(spaceId) {
      if (loaded.has(spaceId)) return;
      loaded.add(spaceId);
      const docs = (await store.list(
        spaceId,
        COLLECTION,
      )) as unknown as ProviderDraft[];
      const m = draftsFor(spaceId);
      for (const draft of docs) {
        if (builtins.has(draft.id)) continue;
        try {
          m.set(draft.id, specFromDraft(draft));
        } catch {
          continue;
        }
      }
    },

    searchProviders(spaceId, query) {
      const q = query.toLowerCase().trim();
      const all = [...builtins.values(), ...draftsFor(spaceId).values()];
      if (!q) return all;
      const terms = q.split(/\s+/);
      return all.filter((p) => {
        const hay = [p.id, p.name, p.apiDoc, ...p.keywords]
          .join(" ")
          .toLowerCase();
        return terms.some((t) => hay.includes(t));
      });
    },

    async persistProvider(spaceId, draft) {
      await store.put(
        spaceId,
        COLLECTION,
        draft.id,
        draft as unknown as Record<string, unknown>,
      );
    },

    async getProviderDraft(spaceId, id) {
      return (await store.get(
        spaceId,
        COLLECTION,
        id,
      )) as unknown as ProviderDraft | null;
    },

    needsAuth(spaceId, providerId) {
      const spec = getProvider(spaceId, providerId);
      return !!spec && authOf(spec).type !== "none";
    },

    buildClientWithSecret(spaceId, providerId, secret) {
      const spec = getProvider(spaceId, providerId);
      if (!spec) return null;
      if (authOf(spec).type !== "none" && !secret) return null;
      return spec.createClient(secret);
    },
  };
}
