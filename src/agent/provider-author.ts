import { generateText, Output } from "ai";
import { google } from "@ai-sdk/google";
import { z } from "zod";
import type { ProviderDraft } from "../providers/registry";
import { trace, type AgentMeta } from "../observability";

export const providerDraftZ = z.object({
  id: z.string().describe("lowercase short id, e.g. 'notion'"),
  name: z.string().describe("display name, e.g. 'Notion'"),
  keywords: z.array(z.string()).describe("search keywords for this provider"),
  authEnv: z
    .string()
    .describe(
      "env var name holding the API token/key, e.g. 'NOTION_TOKEN'. Empty string only if the API needs no auth.",
    ),
  egressDomain: z
    .string()
    .describe("the single API hostname this provider talks to, e.g. 'api.notion.com'"),
  apiDoc: z
    .string()
    .describe(
      "how a func should call this connection: the methods, their args, and what each returns. Reference ctx.connections.<name>.<method>(...).",
    ),
  clientSource: z
    .string()
    .describe(
      "JS function BODY that receives a `token` variable and returns an object of async methods that call the real API with fetch using the token. Ends with 'return { ... }'. No function/async wrapper.",
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
  "A provider is a typed client over a real HTTP API. Funcs call it via ctx.connections.<name>.<method>(...).",
  "clientSource is a JavaScript function BODY that receives a `token` and returns an object of async methods. Each method calls the real API with fetch and the token (e.g. headers: { Authorization: `Bearer ${token}` }). It must end with 'return { ... }' and have NO function/async wrapper.",
  "Use only API-key / bearer style auth (a single token). authEnv is the env var name for that token; use empty string only if the API truly needs none.",
  "egressDomain is the single hostname the client talks to.",
  "Use your knowledge of the service's real REST API. Keep methods focused on the few most common actions. Each method must be async and return parsed JSON.",
  "Also author a setupGuide: the concrete steps a user follows to get the credential for THIS specific service. Name the exact dashboard/console, the exact settings page (give a real deep link in step.link.href when you know it), which value to copy (the API key / token), and which scopes or permissions to enable. Be specific to the service, not generic. Do not set copyRedirectUrl for API-key providers.",
].join("\n");

const REPAIR_SYSTEM = [
  "You repair the clientSource of an external-service provider for a workflow system.",
  "You are given the current provider (its clientSource, apiDoc) and an error from a real API call.",
  "Fix the clientSource so the call succeeds. Keep the SAME id, name, authEnv, egressDomain, and the SAME method names — only fix the implementation.",
  "Common fixes: request body encoding (e.g. Stripe wants application/x-www-form-urlencoded, with arrays as key[]=value, or use automatic_payment_methods[enabled]=true), headers, field names, endpoints, response parsing.",
  "clientSource is a JS function BODY that receives `token` and `fetch`, returns an object of async methods, ends with 'return { ... }', no wrapper.",
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
  const { output } = await generateText({
    model: google(process.env.GEMINI_MODEL ?? "gemini-2.5-flash"),
    output: Output.object({ schema: providerRepairZ }),
    system: REPAIR_SYSTEM,
    experimental_telemetry: trace("repair-provider", { ...meta, provider: draft.id }),
    prompt: [
      `Provider id: ${draft.id}`,
      `Service: ${draft.name}`,
      `egressDomain: ${draft.egressDomain}`,
      `apiDoc: ${draft.apiDoc}`,
      `Current clientSource:\n${draft.clientSource}`,
      `Error from a real call: ${error}`,
      callSite
        ? `The failing step calls this provider exactly like this — make your method signature and parameter reading match this call site:\n${callSite}`
        : "",
      sampleInput
        ? `The failing step's resolved input values were: ${sampleInput}`
        : "",
      "Return the full provider with a fixed clientSource (keep id, name, keywords, authEnv, egressDomain and method names), plus a changeNote.",
    ]
      .filter(Boolean)
      .join("\n\n"),
  });
  const { changeNote, ...rest } = output;
  return {
    draft: { ...rest, id: draft.id, setupGuide: rest.setupGuide ?? draft.setupGuide },
    changeNote,
  };
}

export async function authorProvider(
  service: string,
  docs?: string,
  meta?: AgentMeta,
): Promise<ProviderDraft> {
  const { output } = await generateText({
    model: google(process.env.GEMINI_MODEL ?? "gemini-2.5-flash"),
    output: Output.object({ schema: providerDraftZ }),
    system: SYSTEM,
    experimental_telemetry: trace("author-provider", { ...meta, service }),
    prompt: [`Service: ${service}`, docs ? `API docs / notes: ${docs}` : ""].join(
      "\n",
    ),
  });
  return {
    ...output,
    id: output.id.toLowerCase().replace(/[^a-z0-9_-]/g, "_"),
  };
}
