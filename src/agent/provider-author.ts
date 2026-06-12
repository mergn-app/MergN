import { z } from "zod";
import { genObject } from "./generate";
import type { ProviderDraft } from "../providers/registry";
import { trace, type AgentMeta } from "../observability";

export const providerDraftZ = z.object({
  id: z.string().describe("lowercase short id, e.g. 'notion'"),
  name: z.string().describe("display name, e.g. 'Notion'"),
  keywords: z.array(z.string()).describe("search keywords for this provider"),
  authEnv: z
    .string()
    .describe(
      "env var name holding the credential — an API token/key (e.g. 'NOTION_TOKEN') or a database connection string (e.g. 'DATABASE_URL'). Empty string only if the service needs no auth.",
    ),
  sandbox: z
    .object({
      egressDomain: z
        .string()
        .optional()
        .describe(
          "A FIXED, publicly-known host known at authoring time — the hostname of a SaaS API that is the same for every user (e.g. 'api.notion.com', 'slack.com'). Leave unset when the host comes from the user's credential; use egressFromField instead.",
        ),
      egressFromField: z
        .string()
        .optional()
        .describe(
          "The NAME of the credential field that holds the host, used when the host is user-specific (databases, caches, self-hosted services, custom base URLs). The runtime parses the host from the user's value at connect time. That value MUST be a bare hostname (e.g. 'db.example.com') or a standard scheme URL / connection string (e.g. 'postgres://user:pass@host:5432/db'). If the service's native credential format is not parseable that way (key-value strings, region-derived endpoints), add a dedicated 'host' field to credential.fields and point this at it. INVARIANT: only use egressFromField when the credential is fully user-supplied; never derive the host from a credential carrying a platform/shared secret.",
        ),
    })
    .describe(
      "Execution/isolation policy: the single host the VM's network egress is locked to. Set EXACTLY ONE of egressDomain (fixed SaaS host) or egressFromField (host comes from the user's credential). Runtime policy, not user-facing form data.",
    ),
  apiDoc: z
    .string()
    .describe(
      "how a func should call this connection: the methods, their args, and what each returns. Reference ctx.connections.<name>.<method>(...).",
    ),
  clientSource: z
    .string()
    .describe(
      "An ES module that `export default`s a factory `(cred, fetch) => ({ ...asyncMethods })`. `cred` is an object keyed by the names you declare in `credential.fields` (e.g. `cred.apiKey`, `cred.connectionString`, or `cred.host`/`cred.port`/`cred.user`/`cred.password`/`cred.database`). Use top-level `import` for any npm package you list in `dependencies`. Each method calls the real API with the injected `fetch` and values from `cred`, returning parsed JSON. Example: \"export default (cred, fetch) => ({ async send(arg) { ... use cred.apiKey ... return data; } });\"",
    ),
  credential: z
    .object({
      kind: z.enum(["oauth"]).optional(),
      fields: z.array(
        z.object({
          name: z
            .string()
            .describe("field key the factory reads from `cred`, e.g. 'apiKey'"),
          label: z.string().describe("human label shown in the form"),
          type: z.enum(["text", "password", "number"]),
          placeholder: z.string().optional(),
          help: z.string().optional(),
          required: z.boolean().optional(),
          secret: z.boolean().optional(),
        }),
      ),
    })
    .describe(
      "The credential fields this provider needs: one field per secret/config value the client consumes. Either a single secret (e.g. `apiKey` or `connectionString`) or a set of host/port/user/password/database values. Mark secrets type:'password' (and secret:true); mark non-secret config as 'text' or 'number'. The factory reads each value as cred.<name>.",
    ),
  dependencies: z
    .array(z.string())
    .describe(
      "npm packages this provider imports (e.g. ['stripe'] or ['@aws-sdk/client-s3@^3']). Empty array if it only uses the injected fetch.",
    ),
  setupGuide: z
    .object({
      intro: z
        .string()
        .optional()
        .describe("one short sentence framing what the user needs to do"),
      steps: z
        .array(
          z.object({
            title: z.string().describe("short imperative step title"),
            detail: z
              .string()
              .optional()
              .describe("one line of concrete instruction"),
            link: z
              .object({ label: z.string(), href: z.string() })
              .optional()
              .describe("a deep link to the exact page (e.g. the API keys page)"),
            copyRedirectUrl: z
              .boolean()
              .optional()
              .describe("set true only for an OAuth callback-URL step"),
          }),
        )
        .describe("ordered steps to obtain the credential"),
    })
    .optional()
    .describe(
      "How a user gets this provider's credential: where to sign in, the exact settings page (with a link), which value to copy, and any scopes to enable.",
    ),
});

const SYSTEM = [
  "You author an external service 'provider' for a workflow automation system.",
  "A provider is a typed client over a real service. Funcs call it via ctx.connections.<name>.<method>(...).",
  "clientSource is an ES module that `export default`s a factory `(cred, fetch) => ({ ...asyncMethods })`. You MAY use top-level `import` for npm client libraries — list every imported package in `dependencies`. Prefer the injected `fetch` for simple HTTP; use a library when it is clearly the right tool.",
  "The factory receives the credential as `cred`, an object keyed by the field names you declare in `credential.fields`. You MUST co-author `credential.fields` and the clientSource that consumes them: declare one field per secret/config value the client needs. For an HTTP API that is usually a single `apiKey` (used in headers, e.g. Authorization: `Bearer ${cred.apiKey}`). For a database it is a single `connectionString`, or a set of `host`/`port`/`user`/`password`/`database`. Read each value as `cred.<fieldName>`.",
  "For each credential field: mark secrets type:'password' and secret:true (api keys, passwords, connection strings); mark non-secret config as type:'text' (host, user, database) or type:'number' (port). Give a clear label and required:true for values the client cannot work without.",
  "If the service is a database, datastore, cache, or message broker — anything with an official client library (Postgres, MySQL, Redis, MongoDB, NATS, etc.) — write a REAL client using that driver over the connection string. Do NOT substitute the vendor's management REST API. The methods should run actual operations (queries, commands). Example for Postgres: declare credential.fields [{ name:'connectionString', label:'Connection string', type:'password', secret:true, required:true }], then: import pg from 'pg'; export default (cred, fetch) => ({ async query(sql, params) { const c = new pg.Client(cred.connectionString); await c.connect(); try { return (await c.query(sql, params)).rows; } finally { await c.end(); } } }); with dependencies: ['pg'].",
  "authEnv is the env var name holding the primary credential (e.g. NOTION_TOKEN for an API key, DATABASE_URL for a connection string), kept for back-compat; use empty string only if the service truly needs none.",
  "sandbox locks the VM's network egress to a SINGLE host. Set EXACTLY ONE of: (a) sandbox.egressDomain — a fixed host known now, for a public SaaS API (e.g. 'api.notion.com'); or (b) sandbox.egressFromField — the name of the credential field that holds the host, when the host is user-specific (databases, caches, self-hosted, custom base URLs). For Postgres/MySQL/Redis/Mongo and anything whose host lives in a connection string, use egressFromField pointing at that field (e.g. 'connectionString'); the runtime parses the host from the user's value. The referenced value must be a bare hostname or a standard scheme URL — if it cannot be parsed that way, add a dedicated 'host' field to credential.fields and point egressFromField at it. INVARIANT: never use egressFromField on a credential that carries a platform/shared secret; those must use a fixed egressDomain.",
  "Use your knowledge of the service's real API or wire protocol. Keep methods focused on the few most common actions. Each method must be async.",
  "Also author a setupGuide: the concrete steps a user follows to get the credential for THIS specific service. Name the exact dashboard/console, the exact settings page (give a real deep link in step.link.href when you know it), which value to copy (the API key / token), and which scopes or permissions to enable. Be specific to the service, not generic. Do not set copyRedirectUrl for API-key providers.",
].join("\n");

const REPAIR_SYSTEM = [
  "You repair the clientSource of an external-service provider for a workflow system.",
  "You are given the current provider (its clientSource, apiDoc) and an error from a real API call.",
  "Fix the clientSource so the call succeeds. Keep the SAME id, name, authEnv, sandbox, credential.fields, and the SAME method names — only fix the implementation.",
  "Common fixes: request body encoding (e.g. Stripe wants application/x-www-form-urlencoded, with arrays as key[]=value, or use automatic_payment_methods[enabled]=true), headers, field names, endpoints, response parsing.",
  "clientSource is an ES module that `export default`s a factory `(cred, fetch) => ({ ...asyncMethods })`, where `cred` is keyed by credential.fields names (e.g. cred.apiKey, cred.connectionString). Keep dependencies in sync with any top-level imports.",
].join("\n");

const providerRepairZ = providerDraftZ.extend({
  changeNote: z
    .string()
    .describe("one short sentence on what you changed and why"),
});

export async function repairProvider(
  draft: ProviderDraft,
  error: string,
  callSite?: string,
  sampleInput?: string,
  meta?: AgentMeta,
): Promise<{ draft: ProviderDraft; changeNote: string }> {
  const output = await genObject({
    schema: providerRepairZ,
    system: REPAIR_SYSTEM,
    telemetry: trace("repair-provider", { ...meta, provider: draft.id }),
    prompt: [
      `Provider id: ${draft.id}`,
      `Service: ${draft.name}`,
      `egress: ${draft.sandbox?.egressFromField ? "from credential field '" + draft.sandbox.egressFromField + "'" : (draft.sandbox?.egressDomain ?? "")}`,
      `apiDoc: ${draft.apiDoc}`,
      `Current clientSource:\n${draft.clientSource}`,
      `Error from a real call: ${error}`,
      callSite
        ? `The failing step calls this provider exactly like this — make your method signature and parameter reading match this call site:\n${callSite}`
        : "",
      sampleInput
        ? `The failing step's resolved input values were: ${sampleInput}`
        : "",
      "Return the full provider with a fixed clientSource (keep id, name, keywords, authEnv, sandbox and method names), plus a changeNote.",
    ]
      .filter(Boolean)
      .join("\n\n"),
  });
  const { changeNote, ...rest } = output;
  return {
    draft: {
      ...rest,
      id: draft.id,
      setupGuide: rest.setupGuide ?? draft.setupGuide,
      credential: rest.credential ?? draft.credential,
      sandbox: rest.sandbox ?? draft.sandbox,
    },
    changeNote,
  };
}

export async function authorProvider(
  service: string,
  docs?: string,
  meta?: AgentMeta,
): Promise<ProviderDraft> {
  const output = await genObject({
    schema: providerDraftZ,
    system: SYSTEM,
    telemetry: trace("author-provider", { ...meta, service }),
    prompt: [`Service: ${service}`, docs ? `API docs / notes: ${docs}` : ""].join(
      "\n",
    ),
  });
  return {
    ...output,
    id: output.id.toLowerCase().replace(/[^a-z0-9_-]/g, "_"),
  };
}
