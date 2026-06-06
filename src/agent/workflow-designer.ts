import { generateText, Output } from "ai";
import { google } from "@ai-sdk/google";
import { z } from "zod";
import type { Registry } from "../providers/registry";
import { authorProvider } from "./provider-author";
import { authorInputForm } from "./form-author";
import { trace, type AgentMeta } from "../observability";

export const planZ = z.object({
  name: z
    .string()
    .describe(
      "a short human title for the whole workflow (3-6 words) describing what it does, e.g. 'Stripe receipt to Slack' or 'Daily signups digest'",
    ),
  triggerKind: z
    .enum(["manual", "webhook"])
    .describe(
      "how the workflow starts. Use 'webhook' when it should run in REACTION to an external event or HTTP call — phrasing like 'when a payment succeeds', 'on a new issue', 'whenever X happens'. Use 'manual' when the user runs it themselves on demand (e.g. 'format this', 'summarize and email me') or doesn't imply an external trigger.",
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
  "Pick triggerKind: 'webhook' if the goal reacts to an external event/HTTP call ('when a payment succeeds', 'on a new issue'), otherwise 'manual'. Only these two are supported.",
  "For each step give: id (snake_case, e.g. create_customer), title, summary, effectful (true if it calls an external service), provider (for effectful steps, e.g. 'stripe','slack'), a DETAILED intent (say exactly what values the step needs and what it returns — e.g. a Slack message needs a channel and the text), outputs (its output field names), and deps (ONLY the inputs that come from an UPSTREAM step's output: input name, fromStep id, fromOutput field).",
  "Inputs NOT listed in deps are taken from the user's trigger input automatically by name. Use consistent field names across steps so they wire up.",
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
      "JS function body only. Reads from input.<field>, returns an object with exactly the required output fields, ends with 'return {...}'. No function/async wrapper.",
    ),
  dangerClass: z.enum(["benign", "costly", "catastrophic"]).optional(),
  idempotencyMechanism: z
    .enum(["provider-key", "upsert", "read-before-write", "claim", "none"])
    .optional(),
});

const BODY_SYSTEM = [
  "You write the JavaScript BODY of a single workflow step.",
  "In scope: `input` (an object) and, for effectful steps, `ctx.connections.<provider>` (a client with the given API).",
  "Read EVERY value you need from input.<field>. For values that come from the user, use natural field names (amount, email, channel, text). For values that come from an upstream step, use the input names listed as upstream-provided.",
  "Include ALL values the step needs — especially every required parameter of the external call (e.g. a Slack message needs input.channel AND input.text).",
  "Return an object containing EXACTLY the required output fields. bodySource is the body only, ends with 'return {...}', no wrapper.",
].join("\n");

async function authorStepBody(
  step: Step,
  providerApiDoc: string | undefined,
  meta?: AgentMeta,
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
  return [...set];
}

export type DesignProgress = (ev: {
  kind: "provider" | "step" | "form";
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

  const funcs = [];
  const wires = [];
  const triggerFields = new Set<string>();

  for (const step of plan.steps) {
    const stepLabel = `Writing ${step.title || step.id}`;
    onProgress?.({ kind: "step", id: step.id, label: stepLabel, status: "active" });
    const body = await authorStepBody(
      step,
      step.provider ? apiDocs[step.provider] : undefined,
      m,
    );
    const usedInputs = extractInputs(body.bodySource);
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
      } else {
        wires.push({ from: "trigger", fromOutput: name, to: step.id, toInput: name });
        triggerFields.add(name);
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
        type: "string",
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

  onProgress?.({
    kind: "form",
    id: "form",
    label: "Building input form",
    status: "active",
  });
  const inputForm = await authorInputForm(goal, [...triggerFields], m);
  onProgress?.({
    kind: "form",
    id: "form",
    label: "Building input form",
    status: "done",
  });

  return {
    name: plan.name,
    funcs,
    wires,
    triggerFields: [...triggerFields],
    trigger: { kind: plan.triggerKind },
    inputForm,
  };
}
