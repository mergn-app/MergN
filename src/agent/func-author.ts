import { generateText, Output } from "ai";
import { google } from "@ai-sdk/google";
import { funcDraftZ, type FuncDraft } from "./schemas";
import { trace, type AgentMeta } from "../observability";
import type { Registry } from "../providers/registry";
import type { FuncDefinition, PortDef, Schema } from "../atoms/index";

const SYSTEM = [
  "You are an agent that authors a single 'func' for a workflow automation system.",
  "A func takes typed input and returns typed output. The body is plain JavaScript:",
  "- it reads from the `input` object (input.fieldName)",
  "- when effectful, it calls external services via ctx.connections.<name> (never touch the raw token)",
  "- it always returns an object",
  "Rules:",
  "- If there is no side effect, set pure=true, requires=[], and kind is usually 'adapter'.",
  "- If it calls an external service, set pure=false, fill requires, and pick a suitable dangerClass and idempotencyMechanism.",
  "- bodySource is the FUNCTION BODY ONLY (no function/async wrapper) and ends with 'return'.",
  "- When a provider's connection API is given below, declare a connection with that provider id and call it exactly as documented.",
].join("\n");

export interface FuncSpec {
  spaceId: string;
  intent: string;
  provider?: string;
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
  const { output: object } = await generateText({
    model: google(process.env.GEMINI_MODEL ?? "gemini-2.5-flash"),
    output: Output.object({ schema: funcDraftZ }),
    system: SYSTEM,
    prompt: [`Task: ${spec.intent}`, providerNote].join("\n"),
    experimental_telemetry: trace("author-func", { ...meta, spaceId: spec.spaceId }),
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
