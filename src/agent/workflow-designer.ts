import { z } from "zod";
import { genObject } from "./generate";
import type { Registry } from "../providers/registry";
import { authorProvider } from "./provider-author";
import {
  resolveCatalog,
  catalogCandidates,
  catalogListForPrompt,
  catalogAuthorHint,
  allCatalogEntries,
  type CatalogEntry,
} from "../providers/catalog";
import { authorInputForm } from "./form-author";
import { authorPollSource } from "./poll-author";
import { reconcileWiring } from "./wiring-repair";
import { trace, type AgentMeta } from "../observability";
import { LIMITS } from "../limits";
import { extractInputs, extractOutputs, extractFileInputs } from "./extract";

export const planZ = z.object({
  name: z
    .string()
    .describe(
      "a short human title for the whole workflow (3-6 words) describing what it does, e.g. 'Stripe receipt to Slack' or 'Daily signups digest'",
    ),
  triggerKind: z
    .enum(["manual", "webhook", "schedule", "poll", "monitor"])
    .describe(
      "how the workflow starts. 'poll' = WATCH a service for NEW items and react to each one ('when a new message arrives in Discord', 'watch a channel for new messages', 'when a new email comes in', 'check X periodically for new data') — services like Discord/Slack messages, new emails, new rows CANNOT receive webhooks here, so use 'poll'. 'webhook' = runs in REACTION to an external HTTP callback the service PUSHES to us ('when a payment succeeds', 'on a new GitHub issue'). 'schedule' = runs on a TIMER or at clock times ('every 15 seconds', 'her gün 09:00', 'periodically') with no external data source. 'monitor' = an ALERT-HANDLER that runs when a MONITORING EVENT fires on some flow (an error / a flow that silently stopped / a flow that ran but did nothing / an auto-heal) — use it for 'when any/a flow fails, do X' ('log failures to a sheet', 'call my API on errors', 'notify on silent failures'); the steps read the event from the trigger input. 'manual' = the user runs it on demand ('format this', 'summarize and email me').",
    ),
  schedule: z
    .object({
      mode: z.enum(["interval", "cron"]),
      cron: z
        .string()
        .optional()
        .describe(
          "standard 5-field cron (min hour dom mon dow) when mode is 'cron'. Use the user's LOCAL wall-clock time as-is, do NOT convert to UTC. E.g. '0 9 * * *' = 09:00, '30 8 * * 1' = Monday 08:30, '21 19 * * 5' = Friday 19:21. dow: 0/7=Sunday, 1=Monday, 5=Friday",
        ),
      timezone: z
        .string()
        .optional()
        .describe(
          "IANA timezone name when the user names a locale/timezone for a cron time (put LOCAL time in cron and set this; do NOT pre-convert to UTC). 'Türkiye saati'/'Turkey' => 'Europe/Istanbul', 'New York' => 'America/New_York', 'UK' => 'Europe/London'. Omit when no timezone is mentioned (defaults to UTC).",
        ),
      intervalValue: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("the count when mode is 'interval', e.g. 15"),
      intervalUnit: z
        .enum(["second", "minute", "hour", "day"])
        .optional()
        .describe(
          "REQUIRED for mode 'interval' — set it (second/minute/hour/day) to the exact unit the user states; never upscale (a count of seconds stays 'second'). OMIT it for mode 'cron' (it is not used there).",
        ),
    })
    .optional()
    .describe(
      "REQUIRED when triggerKind is 'schedule'. For 'every N <unit>' use mode 'interval' with intervalValue=N and intervalUnit. For specific clock times use mode 'cron' with a cron expression.",
    ),
  poll: z
    .object({
      provider: z
        .string()
        .describe("provider id to poll for new items, e.g. 'discord', 'slack', 'gmail'"),
      intent: z
        .string()
        .describe(
          "what to watch and what counts as 'new', e.g. 'new messages in a Discord channel since the last check'",
        ),
      intervalValue: z.number().int().positive().describe("how often to check, count"),
      intervalUnit: z.enum(["second", "minute", "hour", "day"]),
    })
    .optional()
    .describe(
      "REQUIRED when triggerKind is 'poll'. The provider to watch, what counts as new, and how often to check. Each NEW item is fed to the workflow as its trigger input (one run per item), so design the steps to read that item's fields (e.g. input.content, input.author).",
    ),
  steps: z.array(
    z.object({
      id: z.string().describe("snake_case step id, e.g. create_customer"),
      title: z.string().describe("short human title"),
      summary: z.string().describe("one plain sentence"),
      effectful: z
        .boolean()
        .describe("true if it calls an external service, false for pure transforms"),
      provider: z
        .string()
        .optional()
        .describe(
          "provider id for effectful steps. For a known public service, use its EXACT id from the SUPPORTED SERVICES catalog given in the prompt (e.g. 'stripe', 'slack', 'openai'). NEVER invent a generic placeholder id like 'ai_service' or 'enrichment_service' — pick the matching catalog id (AI/LLM -> 'openai', enrichment -> 'clearbit'/'apollo', etc.).",
        ),
      customApi: z
        .boolean()
        .optional()
        .describe(
          "set TRUE only when this step calls the USER'S OWN custom/internal API that they explicitly described (their own endpoint/URL) — a user-specific integration, not a known public SaaS. Leave false/omitted for public services (those MUST be a catalog provider id).",
        ),
      intent: z
        .string()
        .describe(
          "what the step does, INCLUDING the values it needs and what it returns",
        ),
      outputs: z
        .array(z.string())
        .default([])
        .describe("the step's output field names"),
      deps: z
        .array(
          z.object({
            input: z.string().describe("this step's input field name"),
            fromStep: z.string().describe("the upstream step id it comes from"),
            fromOutput: z
              .string()
              .describe("the upstream step's output field name"),
          }),
        )
        .default([])
        .describe(
          "inputs that come from an UPSTREAM STEP's output. Inputs NOT listed here are taken from the user's trigger input automatically by the field name the body uses.",
        ),
      condition: z
        .object({
          onStep: z
            .string()
            .describe("an EARLIER step id whose output decides whether this step runs"),
          output: z
            .string()
            .describe("that step's output field holding the decision flag"),
          equals: z
            .string()
            .optional()
            .describe("run this step ONLY when the flag equals this exact string (e.g. 'approved')"),
          truthy: z
            .boolean()
            .optional()
            .describe("run this step ONLY when the flag is truthy (true) or falsy (false); use INSTEAD of equals for boolean flags like is_duplicate"),
        })
        .optional()
        .describe(
          "Set ONLY for an action that must run conditionally. The engine SKIPS this step (and every step that depends on it) when the condition is false — no branch node needed. Use for irreversible/one-way actions: refund only when approval_status equals 'approved', create a record only when is_duplicate is falsy (truthy:false), alert only when is_high_risk is truthy. The deciding step must list the flag in its outputs. Omit for steps that always run.",
        ),
    }),
  ),
});

export type Plan = z.infer<typeof planZ>;
type Step = Plan["steps"][number];

const PLAN_SYSTEM = [
  "You are a workflow planner for an AI-native automation product. Given the user's goal, produce a COMPLETE plan.",
  "A workflow has a built-in 'trigger' node (the run-time input) and typed steps wired together. A step input comes EITHER from a trigger field OR from an upstream step's output.",
  "Give the workflow a short human name (3-6 words) that says what it does.",
  "Pick triggerKind: 'webhook' if the goal reacts to an external event/HTTP call ('when a payment succeeds', 'on a new issue'); 'schedule' if it should run on a timer or at specific times ('every 15 seconds', 'every 5 minutes', 'daily at 9am', 'her gün', 'her X dakikada bir', 'periodically'); otherwise 'manual'.",
  "When triggerKind is 'schedule', ALSO fill `schedule`: for 'every N <unit>' use mode 'interval' with intervalValue=N AND ALWAYS intervalUnit — match the user's wording exactly: saniye/seconds=second, dakika/minutes=minute, saat/hours=hour, gün/days=day (e.g. '30 saniyede bir' => intervalValue=30, intervalUnit='second'). Never omit intervalUnit for interval mode. For specific clock times use mode 'cron' with a 5-field cron in the user's LOCAL wall-clock time and set `timezone` to the IANA zone when they name one — do NOT convert the time to UTC yourself. Examples: 'every day at 9am' => cron '0 9 * * *'; 'her cuma 19:21 Türkiye saati' => cron '21 19 * * 5', timezone 'Europe/Istanbul'.",
  "Use triggerKind 'poll' when the goal is to WATCH a service for NEW items and act on each ('when a new Discord message arrives', 'watch a channel for new messages', 'new emails'). Such services CANNOT webhook here. Fill `poll` (provider, a clear intent of what counts as new, intervalValue+intervalUnit). The steps then receive EACH new item as the trigger input — make the steps read that item's fields (e.g. input.content). Do NOT add a step that 'lists' or 'fetches' messages; the poll itself fetches new items.",
  "For a 'webhook' trigger, the step gets the ENTIRE raw request body as `input.payload` (you don't know the exact shape at design time, and it differs per service — never assume one). For 'forward/format/store the webhook data' goals, the step should just process `input.payload` as-is — do NOT invent flat trigger field names. To pull a SPECIFIC value, extract it INSIDE the step code straight from input.payload — webhook events commonly wrap the entity in an envelope, so unwrap the common shapes first (e.g. `input.payload?.data?.object ?? input.payload?.data ?? input.payload?.object ?? input.payload`) and read fields off that. NEVER create a user input that asks the end user for a PATH/field-location into the payload (e.g. a `*_path`, `*_field`, `*_key` input fed to lodash get) — the user must never type a path into the event. The user only provides DESTINATIONS/ACTIONS (a channel, a spreadsheet id, a column name), never a path into the event body. CRITICAL: the webhook body ALREADY contains the event's entity and its details — do NOT add a step that calls the provider's API to RE-FETCH data the webhook already delivered (e.g. for an 'invoice paid' / payment event, the customer name and amount are already inside input.payload; read them from there, do NOT add a 'retrieve customer' step). Default to a SINGLE step that reads what it needs from input.payload; only add an effectful step when the goal genuinely requires an external ACTION (send/write/create somewhere).",
  "For each step give: id (snake_case, e.g. create_customer), title, summary, effectful (true if it calls an external service), provider (for effectful steps, e.g. 'stripe','slack'), a DETAILED intent (say exactly what values the step needs and what it returns — e.g. a Slack message needs a channel and the text), outputs (ONLY the output field names a later step or the final action consumes, plus the step's primary result — do NOT list per-item fields for a step that processes a list, and never list an input name as an output), and deps (ONLY the inputs that come from an UPSTREAM step's output: input name, fromStep id, fromOutput field).",
  "Inputs NOT listed in deps are taken from the user's trigger input automatically by name. Use consistent field names across steps so they wire up.",
  "CONDITIONAL ACTIONS: when an action must run ONLY in some cases (refund ONLY when approved, create a record ONLY when NOT a duplicate, alert ONLY when risk is high), add a deciding step that outputs the flag (e.g. approval_status, is_duplicate, is_high_risk) and set the action step's `condition` to that step's output (equals 'approved', or truthy:false for is_duplicate, or truthy:true for is_high_risk). The engine then SKIPS the action and everything downstream of it when the condition is false — there is no branch node, so do NOT rely on code guards for this. Use condition for irreversible/one-way actions especially (refunds, charges, creating records, sending messages).",
  "When the user provides a LIST/multiple values (e.g. several channel ids, multiple emails/recipients), do NOT add a separate step to split or parse a delimited string. Instead, let the consuming step read that input DIRECTLY as an array (iterate it with for...of / forEach) — the UI gives the user a proper list editor for array inputs.",
  "FILES: when the user wants to SEND/UPLOAD a picked file to a service (e.g. 'send my file to Discord', 'email this attachment'), use a SINGLE effectful step that takes the file directly as an input and sends it. Do NOT add a separate step to 'read', 'decode', 'parse' or 'process' the file first — the file's bytes are delivered to the step automatically. Only add a processing step when the goal genuinely transforms the file's CONTENT (e.g. 'count rows in the CSV', 'extract text'). A file passed between steps stays the whole file object — never decode it to a string in one step and feed it to a step that expects a file.",
  "SUPPORTED SERVICES: the prompt includes a CATALOG of supported public services (id — name). For every effectful step that uses a known public service, set `provider` to the matching catalog id — never invent a provider name. If the user needs a public service that is NOT in the catalog, do NOT fabricate one: first try to achieve the goal using catalog services or pure/HTTP steps; only if that is genuinely impossible, name the closest provider and the system will report that integration as unsupported. Set `customApi: true` ONLY for the user's OWN custom/internal API described with its endpoint (user-specific) — those are allowed without a catalog id.",
].join("\n");

export async function planWorkflow(
  goal: string,
  meta?: AgentMeta,
): Promise<Plan> {
  // The catalog is small enough to show the planner IN FULL — best matching, no
  // keyword blind spot on paraphrased goals ("notify the team" -> slack/discord).
  // Fall back to relevance-filtering only if the catalog grows large.
  // Never suggest deprecated/dead services to the planner.
  const all = allCatalogEntries().filter((e) => e.confidence !== "deprecated");
  const entries = all.length <= 350 ? all : catalogCandidates(goal, 60);
  const prompt = entries.length
    ? `${goal}\n\nSUPPORTED SERVICES — use these EXACT provider ids for any known public service (never invent one):\n${catalogListForPrompt(entries)}`
    : goal;
  return genObject({
    schema: planZ,
    system: PLAN_SYSTEM,
    prompt,
    telemetry: trace("plan-workflow", meta),
    spaceId: meta?.spaceId,
  });
}

const stepBodyZ = z.object({
  bodySource: z
    .string()
    .describe(
      "An ES module that `export default`s `async (ctx, input) => result`. Reads from input.<field>, returns an object with exactly the required output fields. May use top-level `import` for npm packages listed in `dependencies`.",
    ),
  dependencies: z
    .array(z.string())
    .describe("npm packages this step imports directly; empty array if none.")
    .optional(),
  arrayInputs: z
    .array(z.string())
    .describe(
      "input field names you read as an ARRAY/list (i.e. input.x is iterated with map/forEach/for-of or indexed). Empty if none.",
    )
    .optional(),
  configInputs: z
    .array(z.string())
    .describe(
      "input field names that are a fixed per-step SETTING the user configures once (a destination or location, not flowing data): e.g. a spreadsheet id, sheet name, a column name, a Slack channel / Discord channel id, a Trello board/list id, an Asana project id, a Mailchimp audience id, an Airtable table name, an API/webhook URL, a numeric threshold. These are entered on the step, kept per-step (two steps can each have their OWN spreadsheet id), and never come from the trigger or an upstream step. Do NOT list here any value that is DATA flowing from input.payload or from an upstream step's output (an email, amount, name, score, the parsed item). Empty if none.",
    )
    .optional(),
  fileInputs: z
    .array(z.string())
    .describe(
      "input field names that are an UPLOADED FILE the user picks (e.g. a CSV/JSON/image to process). Such an input arrives as { name, mime, size, base64 }; read input.x.base64 (decode with Buffer.from(input.x.base64,'base64')) for bytes or .toString('utf8') for text. Empty if none.",
    )
    .optional(),
  dangerClass: z.enum(["benign", "costly", "catastrophic"]).optional(),
  idempotencyMechanism: z
    .enum(["provider-key", "upsert", "read-before-write", "claim", "none"])
    .optional(),
});

const BODY_SYSTEM = [
  "You write a single workflow step as an ES module that `export default`s `async (ctx, input) => result`.",
  "In scope: `input` (an object) and, for effectful steps, `ctx.connections.<provider>` (a client with the given API).",
  "Read EVERY value you need from input.<field>. For values that come from the user, use natural field names (amount, email, channel, text). For values that come from an upstream step, use the input names listed as upstream-provided.",
  "WEBHOOK triggers: the ENTIRE raw request body the external service POSTs is available as `input.payload` (already-parsed JSON). Do NOT invent flat trigger field names — they won't exist. To format/forward/store the webhook data, work with `input.payload` directly (e.g. `JSON.stringify(input.payload, null, 2)`, or iterate Object.entries(input.payload)). To pull a SPECIFIC value, extract it RIGHT HERE in code from input.payload. IMPORTANT: webhook events commonly WRAP the real entity in an envelope instead of placing fields at the top level. Before reading, unwrap the common envelope shapes once and read from the result: `const obj = input.payload?.data?.object ?? input.payload?.data ?? input.payload?.object ?? input.payload;` then read your fields off `obj` with a couple of sensible fallbacks. If a field looks missing at the top level, it is almost always nested one level under such an envelope — unwrap rather than assume it is absent. NEVER add a config input that makes the user supply a PATH/field-location (no `*_path`/`*_field`/`*_key` input passed to lodash get) — the user must never type a path into the event. Do the navigation in CODE, not via a user input.",
  "Include ALL values the step needs — especially every required parameter of the external call (e.g. a Slack message needs input.channel AND input.text).",
  "SETTINGS vs DATA: a fixed per-step SETTING the user configures once — a destination or location, not flowing data (a spreadsheet id, sheet name, column name, a Slack/Discord channel id, a Trello board/list id, an Asana project id, a Mailchimp audience id, an Airtable table name, an API/webhook URL, a numeric threshold) — MUST be listed in `configInputs`. Do NOT list there anything that flows from input.payload or from an upstream step (an email, amount, name, score, the parsed item). When several steps each need their own location (e.g. two steps writing to different sheets), give each its OWN config input — they are kept per-step and will not collide.",
  "Return an object with ONLY the outputs a later step or the final action actually consumes, plus the step's primary result. Do NOT echo an input straight back as an output (never return input.sheetName as an output). If the step processes a LIST/batch, return the list (or the enriched list) as ONE output — do NOT emit per-item scalar fields (category, sentiment, sla) as step outputs; those live inside the items.",
  "When a step's job is to RECORD/LOG/store many values somewhere (append a row, create an Airtable/Notion record), prefer reading from the few upstream result OBJECTS it needs rather than declaring dozens of separate scalar inputs.",
  "You may use top-level `import` for npm packages; list each in `dependencies`.",
  "If you read any input as a LIST (input.x.map/forEach/for-of or input.x[i]), list those field names in `arrayInputs` so the UI offers a list editor.",
  "A user-provided list ARRIVES AS A REAL ARRAY — iterate input.x directly with for...of/forEach. Do NOT String.split() it and do NOT expect a comma-separated string.",
  "If the step processes an UPLOADED FILE (a CSV/JSON/image/etc. the user picks), declare that input in `fileInputs`. It arrives as { name, mime, size, base64 }: for text use Buffer.from(input.x.base64,'base64').toString('utf8'), for bytes use Buffer.from(input.x.base64,'base64'). Do NOT expect a path or a URL.",
  "If the step SENDS an uploaded file to an external service (e.g. post a file to Discord/Slack/Telegram, attach to an email), the provider exposes a dedicated file-upload method that handles the multipart upload — call it and pass the WHOLE file object straight through: `await ctx.connections.discord.sendFile(input.channel_id, input.file, optionalCaption)`. The file object is { name, mime, size, base64 }. Do NOT decode it to a Buffer yourself, do NOT JSON-stringify it, and do NOT pass it as the text/content argument of a plain message method — those send JSON only and silently drop the file. Use the file method named in the provider's apiDoc.",
].join("\n");

// Method names a provider's client actually exposes — parsed from its
// clientSource factory (`async foo(`/`foo: async`). Used to constrain the
// step-body author so it can't call a method the provider doesn't have
// (the gmail.sendMail-vs-sendEmail class of hallucination).
function providerMethodNames(clientSource?: string): string[] {
  if (!clientSource) return [];
  const names = new Set<string>();
  for (const m of clientSource.matchAll(/async\s+([A-Za-z0-9_$]+)\s*\(/g))
    names.add(m[1]);
  for (const m of clientSource.matchAll(/([A-Za-z0-9_$]+)\s*:\s*async\b/g))
    names.add(m[1]);
  return [...names];
}

// Methods a step body calls on ctx.connections.<provider>.
function calledProviderMethods(bodySource: string, provider: string): string[] {
  const esc = provider.replace(/[^A-Za-z0-9_$]/g, "\\$&");
  const re = new RegExp(
    `ctx\\.connections\\.${esc}\\.([A-Za-z0-9_$]+)\\s*\\(`,
    "g",
  );
  return [...bodySource.matchAll(re)].map((m) => m[1]);
}

async function authorStepBody(
  step: Step,
  providerApiDoc: string | undefined,
  meta?: AgentMeta,
  triggerHint?: string,
  providerMethods: string[] = [],
  extraRule?: string,
): Promise<z.infer<typeof stepBodyZ>> {
  const upstream = step.deps.map((d) => d.input);
  return genObject({
    schema: stepBodyZ,
    system: BODY_SYSTEM,
    telemetry: trace("author-step-body", { ...meta, step: step.id }),
    spaceId: meta?.spaceId,
    prompt: [
      `Step: ${step.intent}`,
      `Required output fields: ${step.outputs.join(", ") || "(none)"}`,
      upstream.length
        ? `These inputs come from upstream steps (use these exact names): ${upstream.join(", ")}`
        : "",
      triggerHint ?? "",
      step.effectful && step.provider
        ? `Use ctx.connections.${step.provider}. API: ${providerApiDoc}`
        : "This is a pure transform (no external service).",
      step.effectful && step.provider && providerMethods.length
        ? `ALLOWED methods on ctx.connections.${step.provider} — call ONLY these exact names: ${providerMethods.join(", ")}. Do NOT invent or call any method outside this list.`
        : "",
      extraRule ?? "",
    ]
      .filter(Boolean)
      .join("\n\n"),
  });
}

export type DesignProgress = (ev: {
  kind: "provider" | "step" | "form" | "poll" | "wire";
  id: string;
  label: string;
  status: "active" | "done" | "failed";
}) => void;

export async function designWorkflow(
  registry: Registry,
  spaceId: string,
  plan: Plan,
  goal = "",
  onProgress?: DesignProgress,
  meta?: AgentMeta,
) {
  const m: AgentMeta = { ...meta, spaceId };
  // Each step is one authoring LLM call, so cap the count to bound the fan-out
  // of a single design_workflow (limit configured in src/limits.ts).
  if (plan.steps.length > LIMITS.maxPlanSteps)
    plan.steps = plan.steps.slice(0, LIMITS.maxPlanSteps);
  const providerIds = new Set(
    plan.steps.filter((s) => s.effectful && s.provider).map((s) => s.provider!),
  );
  if (plan.triggerKind === "poll" && plan.poll?.provider) {
    providerIds.add(plan.poll.provider);
  }
  // Classify every required provider against the trusted catalog BEFORE authoring.
  // Already-registered providers are reused; catalog services are authored grounded
  // on their REAL API (host/auth/docs); the user's own custom API (customApi) is
  // allowed; any other public service the catalog doesn't cover is refused rather
  // than fabricated — this is what stops the hallucinated-provider bug.
  const customProviders = new Set(
    plan.steps
      .filter((s) => s.effectful && s.provider && s.customApi)
      .map((s) => s.provider!),
  );
  const toAuthor: { id: string; cat?: CatalogEntry }[] = [];
  const unsupported: string[] = [];
  for (const id of providerIds) {
    if (registry.getProvider(spaceId, id)) continue; // already available
    const cat = resolveCatalog(id);
    if (cat) toAuthor.push({ id, cat });
    else if (customProviders.has(id)) toAuthor.push({ id });
    else unsupported.push(id);
  }
  if (unsupported.length) {
    // Surface each unsupported integration as a failed build step (the build
    // panel renders these) before aborting with an actionable message.
    for (const id of unsupported) {
      onProgress?.({
        kind: "provider",
        id,
        label: `Unsupported integration: ${id}`,
        status: "failed",
      });
    }
    throw new Error(
      `Unsupported integration: ${unsupported.join(", ")}. This isn't in the ` +
        `supported-services catalog yet — try a supported alternative, or describe ` +
        `your own API endpoint to add it as a custom integration.`,
    );
  }

  // OAuth is offered ONLY on managed/prod (MANAGED=1): the central OAuth app
  // client id/secret live in prod env and must never ship to self-host. On
  // self-host this is false, so providers fall back to the API-key/token flow.
  const oauthEnabled =
    process.env.MANAGED === "1" || process.env.MANAGED === "true";
  for (const { id, cat } of toAuthor) {
    const label = `Creating provider ${cat?.name ?? id}`;
    onProgress?.({ kind: "provider", id, label, status: "active" });
    // Use OAuth only when it's actually configured: managed deployment, the
    // catalog has an oauth block, AND the central app's client id is present in
    // env. Otherwise fall back to the API-key/token flow — so OAuth turns on for
    // a provider simply by setting its *_OAUTH_CLIENT_ID/SECRET in prod, with no
    // catalog edits and no half-configured "Connect" that errors out.
    const useOAuth =
      oauthEnabled && !!cat?.oauth && !!process.env[cat.oauth.clientIdEnv];
    const draft = await authorProvider(
      id,
      cat ? catalogAuthorHint(cat, useOAuth) : undefined,
      m,
      useOAuth,
    );
    // Pin egress to the catalog's known host so a drifted/guessed hostname can't
    // silently reach a fabricated endpoint (the enrichment_service-style bug).
    if (cat?.egressHost) draft.sandbox = { egressDomain: cat.egressHost };
    if (useOAuth && cat?.oauth) {
      // Wire to the platform's central OAuth app: runtime does the login + token
      // refresh + injection, so there are no user-entered credential fields.
      draft.oauth2 = cat.oauth;
      draft.credential = undefined;
      draft.setupGuide = undefined;
    }
    registry.registerProviderFromDraft(spaceId, draft);
    await registry.persistProvider(spaceId, draft);
    onProgress?.({ kind: "provider", id, label, status: "done" });
  }

  const apiDocs: Record<string, string> = {};
  const methodsByProvider: Record<string, string[]> = {};
  for (const id of providerIds) {
    const spec = registry.getProvider(spaceId, id);
    if (spec) apiDocs[id] = spec.apiDoc;
    methodsByProvider[id] = providerMethodNames(spec?.clientSource);
  }

  let pollDraft: Awaited<ReturnType<typeof authorPollSource>> | null = null;
  let triggerHint: string | undefined;
  if (plan.triggerKind === "poll" && plan.poll) {
    onProgress?.({
      kind: "poll",
      id: "poll",
      label: `Writing ${plan.poll.provider} poller`,
      status: "active",
    });
    pollDraft = await authorPollSource(
      plan.poll.provider,
      apiDocs[plan.poll.provider] ?? "",
      plan.poll.intent,
      m,
    );
    onProgress?.({
      kind: "poll",
      id: "poll",
      label: `Writing ${plan.poll.provider} poller`,
      status: "done",
    });
    triggerHint = `The trigger input is ONE ${plan.poll.provider} item per run. Read its fields by these EXACT names: ${pollDraft.itemFields.join(", ")}. They come from the trigger automatically — do NOT invent other trigger field names and do NOT treat them as upstream-step inputs.`;
  } else if (plan.triggerKind === "webhook") {
    triggerHint =
      "Read the entire raw webhook body as `input.payload` (the whole parsed JSON the service POSTed). Do NOT declare or read any other trigger field — they do not exist. To format/forward/store the data, use input.payload directly (e.g. JSON.stringify(input.payload, null, 2)). To read a specific value, extract it in code from input.payload yourself (e.g. input.payload?.data?.object?.customer_name ?? input.payload?.customer_name) — NEVER add a user input that asks for a PATH/field-location (no `*_path` input + lodash get). When unsure, try a couple of sensible paths or process the whole input.payload.";
  } else if (plan.triggerKind === "monitor") {
    triggerHint =
      "This is an alert-handler. Each run is ONE monitoring event, fed as the trigger input with these EXACT fields: input.category ('error'|'silent_failure'|'silent_success'|'recovered'|'healed'), input.severity ('info'|'warn'|'critical'), input.status, input.title, input.detail, input.sourceWorkflowId, input.sourceWorkflowName, input.at. Read those directly — do NOT invent other trigger fields and do NOT treat them as upstream-step inputs.";
  }

  const funcs = [];
  const wires = [];
  const variableFieldSet = new Set<string>();
  // Deterministic guard: a dep is a STEP→STEP edge only. The trigger emits only
  // its eventFields (e.g. `payload`); it never carries user-config values. So a
  // dep whose fromStep isn't a real step (the AI sometimes writes
  // fromStep:"trigger") is rejected — that input falls back to an event field or
  // a user form field, never a bogus trigger wire.
  const stepIds = new Set(plan.steps.map((s) => s.id));
  const eventFields =
    plan.triggerKind === "poll" && pollDraft
      ? pollDraft.itemFields
      : plan.triggerKind === "schedule"
        ? ["timestamp"]
        : plan.triggerKind === "webhook"
          ? ["payload"] // the whole raw body is trigger-fed, never a form field
          : plan.triggerKind === "monitor"
            ? ["category", "severity", "status", "title", "detail", "sourceWorkflowId", "sourceWorkflowName", "at"]
            : [];

  for (const step of plan.steps) {
    const stepLabel = `Writing ${step.title || step.id}`;
    onProgress?.({ kind: "step", id: step.id, label: stepLabel, status: "active" });
    const apiDoc = step.provider ? apiDocs[step.provider] : undefined;
    const methods = step.provider ? (methodsByProvider[step.provider] ?? []) : [];
    let body = await authorStepBody(step, apiDoc, m, triggerHint, methods);
    // Method-name guard: if the body called a provider method that doesn't exist
    // on the real client, re-author once constrained to the actual method list.
    if (step.provider && methods.length) {
      const bad = [
        ...new Set(calledProviderMethods(body.bodySource, step.provider)),
      ].filter((x) => !methods.includes(x));
      if (bad.length) {
        console.log(
          `[method-fix] ${step.id}: invalid ${step.provider} method(s) ${bad.join(", ")}; re-authoring against ${methods.join(", ")}`,
        );
        body = await authorStepBody(
          step,
          apiDoc,
          m,
          triggerHint,
          methods,
          `Your previous code called ctx.connections.${step.provider}.${bad[0]}(...) which does NOT exist on this provider. Rewrite using ONLY these methods: ${methods.join(", ")}.`,
        );
      }
    }
    const usedInputs = extractInputs(body.bodySource);
    // Trust the body's real return shape over the planner's declared outputs,
    // unioning both so a planner-declared field that the body forgot still shows.
    const stepOutputs = [
      ...new Set([...step.outputs, ...extractOutputs(body.bodySource)]),
    ];
    const arrayInputs = new Set(body.arrayInputs ?? []);
    const fileInputs = new Set([
      ...(body.fileInputs ?? []),
      ...extractFileInputs(body.bodySource),
    ]);
    const declaredConfig = new Set(body.configInputs ?? []);
    const depByInput = new Map(step.deps.map((d) => [d.input, d]));

    // per-step set of inputs that resolve to a fixed config setting (an unbound
    // input the author flagged as configInputs). Config is per-step, so two
    // steps can each have their own spreadsheet id without colliding — unlike a
    // form field, which is global by name. Wired/event inputs are flowing data
    // and can never be config.
    const stepConfig = new Set<string>();
    for (const name of usedInputs) {
      const dep = depByInput.get(name);
      if (dep && stepIds.has(dep.fromStep)) {
        wires.push({
          from: dep.fromStep,
          fromOutput: dep.fromOutput,
          to: step.id,
          toInput: name,
        });
      } else if (eventFields.includes(name)) {
        wires.push({ from: "trigger", fromOutput: name, to: step.id, toInput: name });
      } else if (declaredConfig.has(name)) {
        stepConfig.add(name); // per-step setting, not a global form field
      } else {
        variableFieldSet.add(name);
      }
    }

    funcs.push({
      id: step.id,
      title: step.title,
      summary: step.summary,
      version: 1,
      kind: step.effectful ? "library" : "adapter",
      pure: !step.effectful,
      inputs: usedInputs.map((name) => ({
        name,
        role: stepConfig.has(name) ? "config" : "input",
        type: fileInputs.has(name)
          ? "file"
          : arrayInputs.has(name)
            ? "array"
            : "string",
        required: true,
      })),
      outputSchema: {
        type: "object",
        properties: Object.fromEntries(
          stepOutputs.map((o) => [o, { type: "string" as const }]),
        ),
        required: stepOutputs,
      },
      bodySource: body.bodySource,
      dependencies: body.dependencies ?? [],
      requires:
        step.effectful && step.provider
          ? [{ name: step.provider, provider: step.provider, scopes: [] }]
          : [],
      dangerClass: step.effectful ? (body.dangerClass ?? "benign") : null,
      idempotency: step.effectful
        ? { key: "runId+funcId", mechanism: body.idempotencyMechanism ?? "none" }
        : null,
      ...(step.condition
        ? {
            gate: {
              ref: `${step.condition.onStep}.output.${step.condition.output}`,
              ...(step.condition.equals !== undefined
                ? { equals: step.condition.equals }
                : {}),
              ...(step.condition.truthy !== undefined
                ? { truthy: step.condition.truthy }
                : {}),
            },
          }
        : {}),
    });
    onProgress?.({ kind: "step", id: step.id, label: stepLabel, status: "done" });
  }

  // Validate conditional gates against the real graph: the planner can name a
  // wrong/absent decision flag. The gate's source step must exist, not be the
  // step itself, expose that output, and actually express a condition. Drop an
  // invalid gate so the step runs unconditionally instead of waiting forever on
  // a phantom node (same philosophy as the wire fromOutput validation).
  for (const f of funcs) {
    if (!f.gate) continue;
    const parts = String(f.gate.ref).split(".");
    const srcId = parts[0];
    const srcField = parts.slice(2).join(".");
    const src = funcs.find((x) => x.id === srcId);
    const srcOutputs = src ? Object.keys(src.outputSchema?.properties ?? {}) : [];
    const noCondition = f.gate.equals === undefined && f.gate.truthy === undefined;
    if (!src || srcId === f.id || !srcOutputs.includes(srcField) || noCondition) {
      console.log(`[gate] dropped invalid gate on ${f.id} (ref ${f.gate.ref})`);
      delete f.gate;
    }
  }

  // Deterministically detect step inputs the planner left unconnected (and
  // outputs left dangling), then let a focused LLM bridge them. The planner's
  // per-step `deps` are unreliable on weak models; this repair pass works from
  // the actual built graph so wiring no longer depends on the planner getting
  // every dependency right. Applied wires + recomputed form fields come back.
  onProgress?.({ kind: "wire", id: "wire", label: "Checking connections", status: "active" });
  const recon = await reconcileWiring(funcs, wires, eventFields, m);
  wires.length = 0;
  wires.push(...recon.wires);
  if (recon.added.length) {
    console.log("[wiring-repair]", recon.diagnostics.join("; "));
  }
  onProgress?.({ kind: "wire", id: "wire", label: "Checking connections", status: "done" });

  const variableFields = recon.variableFields;

  let inputForm = null;
  if (variableFields.length > 0) {
    onProgress?.({
      kind: "form",
      id: "form",
      label: "Building input form",
      status: "active",
    });
    inputForm = await authorInputForm(goal, variableFields, undefined, m);
    onProgress?.({
      kind: "form",
      id: "form",
      label: "Building input form",
      status: "done",
    });
  }

  let trigger: { kind: string; [key: string]: unknown } = {
    kind: plan.triggerKind,
  };
  if (plan.triggerKind === "schedule" && plan.schedule) {
    trigger = {
      kind: "schedule",
      enabled: true,
      schedule: {
        mode: plan.schedule.mode,
        cron: plan.schedule.cron,
        intervalValue: plan.schedule.intervalValue,
        // optional in the plan (omitted for cron); default so an interval
        // schedule never ends up with an undefined unit
        intervalUnit: plan.schedule.intervalUnit ?? "minute",
        timezone: plan.schedule.timezone,
      },
    };
  } else if (plan.triggerKind === "poll" && plan.poll && pollDraft) {
    trigger = {
      kind: "poll",
      enabled: true,
      poll: {
        provider: plan.poll.provider,
        source: pollDraft.source,
        dependencies: pollDraft.dependencies ?? [],
        paramNames: pollDraft.params ?? [],
        params: {},
        intervalValue: plan.poll.intervalValue,
        intervalUnit: plan.poll.intervalUnit,
      },
    };
  }
  if (eventFields.length) trigger.eventFields = eventFields;

  return {
    name: plan.name,
    funcs,
    wires,
    trigger,
    inputForm,
  };
}
