import type { DocStore } from "../store/docstore";

const COLLECTION = "providers";

export interface AuthField {
  name: string;
  label: string;
  type: "text" | "password" | "number";
  placeholder?: string;
  required?: boolean;
  help?: string;
  secret?: boolean;
}

export interface Credential {
  kind?: "oauth";
  fields: AuthField[];
}

export interface SandboxPolicy {
  egressDomain?: string;
  egressFromField?: string;
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
      authParams?: Record<string, string>;
      tokenAuthStyle?: "body" | "basic";
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
  credential?: Credential;
  setupGuide?: SetupGuide;
  sandbox?: SandboxPolicy;
  aiWritten?: boolean;
  clientSource?: string;
  dependencies?: string[];
}

export interface ProviderDraft {
  id: string;
  name: string;
  keywords: string[];
  authEnv: string;
  sandbox: SandboxPolicy;
  apiDoc: string;
  clientSource: string;
  dependencies?: string[];
  credential?: Credential;
  setupGuide?: SetupGuide;
  // Set (managed/prod only) when this provider authenticates via the platform's
  // central OAuth2 app. The runtime injects cred.accessToken (auto-refreshed);
  // no per-user credential fields. Client id/secret come from env (clientIdEnv/
  // clientSecretEnv), so they live only in prod and never ship to self-host.
  oauth2?: {
    authUrl: string;
    tokenUrl: string;
    scopes: string[];
    clientIdEnv: string;
    clientSecretEnv: string;
    authParams?: Record<string, string>;
    tokenAuthStyle?: "body" | "basic";
  };
}

const builtins = new Map<string, ProviderSpec>();

// Built-in providers are intentionally minimal: only a generic auth-less HTTP
// client. Every real integration (Slack, Discord, Google, …) is authored by the
// AI on demand — so each gets a consistent, service-specific credential form +
// setup guide, and can be edited/repaired via update_provider/repair_provider.
builtins.set("http", {
  id: "http",
  name: "HTTP",
  scopes: [],
  keywords: ["http", "https", "api", "fetch", "request", "rest", "url", "webhook", "get", "post"],
  apiDoc:
    "call: const data = await ctx.connections.<name>.get(url); (returns parsed JSON) or .post(url, jsonBody). Connection: name 'http', provider 'http', no scopes.",
  dependencies: [],
  clientSource: `
    export default (cred, fetch) => ({
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
    });
  `,
});

function specFromDraft(d: ProviderDraft): ProviderSpec {
  return {
    id: d.id,
    name: d.name,
    scopes: [],
    keywords: d.keywords,
    apiDoc: d.apiDoc,
    env: d.authEnv || undefined,
    credential: d.credential,
    setupGuide: d.setupGuide,
    sandbox: d.sandbox,
    aiWritten: true,
    clientSource: d.clientSource,
    dependencies: d.dependencies ?? [],
    auth: d.oauth2 ? { type: "oauth2", ...d.oauth2 } : undefined,
  };
}

function humanize(env: string): string {
  const cleaned = env.replace(/[_-]+/g, " ").trim().toLowerCase();
  if (!cleaned) return "API key";
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

export function authOf(spec: ProviderSpec): AuthSpec {
  if (spec.auth?.type === "oauth2") return spec.auth;
  if (spec.credential?.fields?.length)
    return { type: "apiKey", fields: spec.credential.fields };
  if (spec.env)
    return {
      type: "apiKey",
      fields: [
        {
          name: "value",
          label: humanize(spec.env),
          type: "password",
          required: true,
        },
      ],
    };
  return { type: "none" };
}

export function publicAuth(spec: ProviderSpec): PublicAuth {
  const auth = authOf(spec);
  const guide = spec.setupGuide;
  if (auth.type === "apiKey")
    return {
      type: "apiKey",
      name: spec.name,
      fields: auth.fields.map((f) => ({
        name: f.name,
        label: f.label,
        type: f.type,
        placeholder: f.placeholder,
        required: f.required,
        help: f.help,
        secret: f.secret,
      })),
      setupGuide: guide,
    };
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
  };
}
