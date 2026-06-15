import { genObject } from "./generate";
import { funcDraftZ, type FuncDraft } from "./schemas";
import { trace, type AgentMeta } from "../observability";
import type { Registry } from "../providers/registry";
import type { FuncDefinition, PortDef, Schema } from "../atoms/index";

const SYSTEM = [
  "You are an agent that authors a single 'func' for a workflow automation system.",
  "A func takes typed input and returns typed output. bodySource is an ES module:",
  "- it `export default`s `async (ctx, input) => result`",
  "- it reads from the `input` object (input.fieldName)",
  "- when effectful, it calls external services via ctx.connections.<name> (never touch the raw token)",
  "- it always returns an object",
  "- it MAY use top-level `import` for npm packages; list every imported package in `dependencies`",
  "Rules:",
  "- If there is no side effect, set pure=true, requires=[], and kind is usually 'adapter'.",
  "- If it calls an external service, set pure=false, fill requires, and pick a suitable dangerClass and idempotencyMechanism.",
  "- When a provider's connection API is given below, declare a connection with that provider id and call it exactly as documented.",
  "- For each input you read as a LIST (input.x is iterated/mapped/indexed), declare its type as 'array' so the UI offers a list editor.",
  "- TRIGGER/EVENT DATA: when the step consumes data from the workflow's trigger (a webhook payload, a polled item, the incoming event), read it the way the trigger note below describes. NEVER invent a flat input name for event data (e.g. input.customerName for a value that lives inside a webhook payload), and NEVER create a config input that asks the end user for a PATH/field-location into the event (no `*_path`/`*_field` input fed to lodash get). Extract specific values from the event object in code. The user only supplies destinations/actions (a channel, a spreadsheet id), never a path into the event body.",
].join("\n");

export interface FuncSpec {
  spaceId: string;
  intent: string;
  provider?: string;
  // describes how this workflow's trigger feeds event data (webhook->input.payload,
  // poll->item fields, schedule->input.timestamp), so an edited step reads it the
  // same way the original designer did.
  triggerHint?: string;
}

export interface AuthoredFuncResult {
  def: FuncDefinition;
  title: string;
  summary: string;
}

export async function authorFunc(
  registry: Registry,
  spec: FuncSpec,
  meta?: AgentMeta,
): Promise<AuthoredFuncResult> {
  const prov = spec.provider
    ? registry.getProvider(spec.spaceId, spec.provider)
    : undefined;
  const providerNote = prov
    ? `This step uses the '${prov.id}' provider (scopes: ${prov.scopes.join(", ") || "none"}). Connection API: ${prov.apiDoc}`
    : "";
  const object = await genObject({
    schema: funcDraftZ,
    system: SYSTEM,
    prompt: [`Task: ${spec.intent}`, providerNote, spec.triggerHint ?? ""]
      .filter(Boolean)
      .join("\n"),
    telemetry: trace("author-func", { ...meta, spaceId: spec.spaceId }),
    spaceId: spec.spaceId ?? meta?.spaceId,
  });
  return {
    def: toFuncDefinition(object),
    title: object.title,
    summary: object.summary,
  };
}

function toSchema(type: string): Schema {
  switch (type) {
    case "string":
      return { type: "string" };
    case "number":
      return { type: "number" };
    case "boolean":
      return { type: "boolean" };
    case "array":
      return { type: "array" };
    default:
      return { type: "object" };
  }
}

function toFuncDefinition(d: FuncDraft): FuncDefinition {
  const inputs: PortDef[] = d.inputs.map((p) => ({
    name: p.name,
    role: p.role,
    schema: toSchema(p.type),
    required: p.required,
  }));

  const outputSchema: Schema = {
    type: "object",
    properties: Object.fromEntries(
      d.outputFields.map((f) => [f.name, toSchema(f.type)]),
    ),
    required: d.outputFields.map((f) => f.name),
  };

  const body = {
    language: "javascript" as const,
    source: d.bodySource,
    dependencies: d.dependencies ?? [],
    generatedBy: { agent: "func-author", prompt: d.id },
  };

  if (d.pure) {
    return {
      id: d.id,
      version: 1,
      kind: d.kind,
      pure: true,
      inputs,
      outputSchema,
      body,
    };
  }

  return {
    id: d.id,
    version: 1,
    kind: d.kind,
    pure: false,
    inputs,
    outputSchema,
    body,
    requires: d.requires,
    effect: {
      retryable: true,
      dangerClass: d.dangerClass,
      idempotency: { key: "runId+funcId", mechanism: d.idempotencyMechanism },
    },
  };
}
