import { generateText, Output } from "ai";
import { google } from "@ai-sdk/google";
import { z } from "zod";
import type { Registry } from "../providers/registry";
import { authorProvider } from "./provider-author";
import { authorInputForm } from "./form-author";
import { authorPollSource } from "./poll-author";
import { trace, type AgentMeta } from "../observability";

export const planZ = z.object({
  name: z
    .string()
    .describe(
      "a short human title for the whole workflow (3-6 words) describing what it does, e.g. 'Stripe receipt to Slack' or 'Daily signups digest'",
    ),
  triggerKind: z
    .enum(["manual", "webhook", "schedule", "poll"])
    .describe(
      "how the workflow starts. 'poll' = WATCH a service for NEW items and react to each one ('when a new message arrives in Discord', 'watch a channel for new messages', 'when a new email comes in', 'check X periodically for new data') — services like Discord/Slack messages, new emails, new rows CANNOT receive webhooks here, so use 'poll'. 'webhook' = runs in REACTION to an external HTTP callback the service PUSHES to us ('when a payment succeeds', 'on a new GitHub issue'). 'schedule' = runs on a TIMER or at clock times ('every 15 seconds', 'her gün 09:00', 'periodically') with no external data source. 'manual' = the user runs it on demand ('format this', 'summarize and email me').",
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
        .describe(
          "the unit when mode is 'interval' — ALWAYS set it (second/minute/hour/day) to match the user's wording. For cron mode it is ignored; just use 'minute'.",
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
        .describe("provider id for effectful steps, e.g. 'stripe', 'slack'"),
      intent: z
        .string()
        .describe(
          "what the step does, INCLUDING the values it needs and what it returns",
        ),
      outputs: z.array(z.string()).describe("the step's output field names"),
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
        .describe(
          "inputs that come from an UPSTREAM STEP's output. Inputs NOT listed here are taken from the user's trigger input automatically by the field name the body uses.",
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
  "For each step give: id (snake_case, e.g. create_customer), title, summary, effectful (true if it calls an external service), provider (for effectful steps, e.g. 'stripe','slack'), a DETAILED intent (say exactly what values the step needs and what it returns — e.g. a Slack message needs a channel and the text), outputs (its output field names), and deps (ONLY the inputs that come from an UPSTREAM step's output: input name, fromStep id, fromOutput field).",
  "Inputs NOT listed in deps are taken from the user's trigger input automatically by name. Use consistent field names across steps so they wire up.",
  "When the user provides a LIST/multiple values (e.g. several channel ids, multiple emails/recipients), do NOT add a separate step to split or parse a delimited string. Instead, let the consuming step read that input DIRECTLY as an array (iterate it with for...of / forEach) — the UI gives the user a proper list editor for array inputs.",
].join("\n");

export async function planWorkflow(
  goal: string,
  meta?: AgentMeta,
): Promise<Plan> {
  const { output } = await generateText({
    model: google(process.env.GEMINI_MODEL ?? "gemini-2.5-flash"),
    output: Output.object({ schema: planZ }),
    system: PLAN_SYSTEM,
    prompt: goal,
    experimental_telemetry: trace("plan-workflow", meta),
  });
  return output;
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
  dangerClass: z.enum(["benign", "costly", "catastrophic"]).optional(),
  idempotencyMechanism: z
    .enum(["provider-key", "upsert", "read-before-write", "claim", "none"])
    .optional(),
});

const BODY_SYSTEM = [
  "You write a single workflow step as an ES module that `export default`s `async (ctx, input) => result`.",
  "In scope: `input` (an object) and, for effectful steps, `ctx.connections.<provider>` (a client with the given API).",
  "Read EVERY value you need from input.<field>. For values that come from the user, use natural field names (amount, email, channel, text). For values that come from an upstream step, use the input names listed as upstream-provided.",
  "Include ALL values the step needs — especially every required parameter of the external call (e.g. a Slack message needs input.channel AND input.text).",
  "Return an object containing EXACTLY the required output fields. You may use top-level `import` for npm packages; list each in `dependencies`.",
  "If you read any input as a LIST (input.x.map/forEach/for-of or input.x[i]), list those field names in `arrayInputs` so the UI offers a list editor.",
  "A user-provided list ARRIVES AS A REAL ARRAY — iterate input.x directly with for...of/forEach. Do NOT String.split() it and do NOT expect a comma-separated string.",
].join("\n");

async function authorStepBody(
  step: Step,
  providerApiDoc: string | undefined,
  meta?: AgentMeta,
  triggerHint?: string,
): Promise<z.infer<typeof stepBodyZ>> {
  const upstream = step.deps.map((d) => d.input);
  const { output } = await generateText({
    model: google(process.env.GEMINI_MODEL ?? "gemini-2.5-flash"),
    output: Output.object({ schema: stepBodyZ }),
    system: BODY_SYSTEM,
    experimental_telemetry: trace("author-step-body", { ...meta, step: step.id }),
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
    ]
      .filter(Boolean)
      .join("\n\n"),
  });
  return output;
}

function extractInputs(src: string): string[] {
  const set = new Set<string>();
  for (const m of src.matchAll(/\binput\.([A-Za-z_$][\w$]*)/g)) set.add(m[1]);
  for (const m of src.matchAll(/\binput\s*\[\s*["'`]([^"'`]+)["'`]\s*\]/g))
    set.add(m[1]);
  for (const m of src.matchAll(
    /(?:const|let|var)\s*\{([^}]*)\}\s*=\s*input\b/g,
  )) {
    for (const part of m[1].split(",")) {
      const key = part.trim().split(":")[0].split("=")[0].trim();
      if (key && !key.startsWith("...") && /^[A-Za-z_$][\w$]*$/.test(key))
        set.add(key);
    }
  }
  return [...set];
}

export type DesignProgress = (ev: {
  kind: "provider" | "step" | "form" | "poll";
  id: string;
  label: string;
  status: "active" | "done";
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
  const providerIds = new Set(
    plan.steps.filter((s) => s.effectful && s.provider).map((s) => s.provider!),
  );
  if (plan.triggerKind === "poll" && plan.poll?.provider) {
    providerIds.add(plan.poll.provider);
  }
  const apiDocs: Record<string, string> = {};
  for (const id of providerIds) {
    let spec = registry.getProvider(spaceId, id);
    if (!spec) {
      onProgress?.({
        kind: "provider",
        id,
        label: `Creating provider ${id}`,
        status: "active",
      });
      const draft = await authorProvider(id, undefined, m);
      spec = registry.registerProviderFromDraft(spaceId, draft);
      await registry.persistProvider(spaceId, draft);
      onProgress?.({
        kind: "provider",
        id,
        label: `Creating provider ${id}`,
        status: "done",
      });
    }
    apiDocs[id] = spec.apiDoc;
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
  }

  const funcs = [];
  const wires = [];
  const variableFieldSet = new Set<string>();
  const eventFields =
    plan.triggerKind === "poll" && pollDraft
      ? pollDraft.itemFields
      : plan.triggerKind === "schedule"
        ? ["timestamp"]
        : [];

  for (const step of plan.steps) {
    const stepLabel = `Writing ${step.title || step.id}`;
    onProgress?.({ kind: "step", id: step.id, label: stepLabel, status: "active" });
    const body = await authorStepBody(
      step,
      step.provider ? apiDocs[step.provider] : undefined,
      m,
      triggerHint,
    );
    const usedInputs = extractInputs(body.bodySource);
    const arrayInputs = new Set(body.arrayInputs ?? []);
    const depByInput = new Map(step.deps.map((d) => [d.input, d]));

    for (const name of usedInputs) {
      const dep = depByInput.get(name);
      if (dep) {
        wires.push({
          from: dep.fromStep,
          fromOutput: dep.fromOutput,
          to: step.id,
          toInput: name,
        });
      } else if (eventFields.includes(name)) {
        wires.push({ from: "trigger", fromOutput: name, to: step.id, toInput: name });
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
        role: "input",
        type: arrayInputs.has(name) ? "array" : "string",
        required: true,
      })),
      outputSchema: {
        type: "object",
        properties: Object.fromEntries(
          step.outputs.map((o) => [o, { type: "string" as const }]),
        ),
        required: step.outputs,
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
    });
    onProgress?.({ kind: "step", id: step.id, label: stepLabel, status: "done" });
  }

  const variableFields = [...variableFieldSet];

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
        intervalUnit: plan.schedule.intervalUnit,
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
