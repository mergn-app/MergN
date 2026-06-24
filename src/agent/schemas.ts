import { z } from "zod";

export const primitiveType = z.enum([
  "string",
  "number",
  "boolean",
  "object",
  "array",
]);

export const funcDraftZ = z.object({
  id: z.string().describe("snake_case id, e.g. fn_format_signup"),
  title: z
    .string()
    .describe("short human-friendly title, 2-4 words, e.g. 'Uppercase Name'"),
  summary: z
    .string()
    .describe("one short plain-language sentence describing what the step does"),
  kind: z.enum(["library", "adapter"]),
  pure: z
    .boolean()
    .describe("true when there is no side effect / external call (pure data transform)"),
  inputs: z.array(
    z.object({
      name: z.string(),
      role: z
        .enum(["input", "config"])
        .describe("input = flowing data, config = setting"),
      type: primitiveType,
      required: z.boolean(),
    }),
  ).default([]),
  outputFields: z
    .array(z.object({ name: z.string(), type: primitiveType }))
    .default([]),
  bodySource: z
    .string()
    .describe(
      "Python source that includes `class StepInput(TypedDict)`, `class StepOutput(TypedDict)`, and `def run(ctx: Any, input: StepInput) -> StepOutput`. Read from `input`, use ctx.connections.<name> when effectful, and return a StepOutput-shaped dict. Use `import` for any package you list in `dependencies`.",
    ),
  dependencies: z
    .array(z.string())
    .default([])
    .describe(
      "PyPI packages this func imports directly (e.g. ['requests']). Empty array if none.",
    ),
  requires: z
    .array(
      z.object({
        name: z.string(),
        provider: z.string(),
        scopes: z.array(z.string()).default([]),
      }),
    )
    .default([])
    .describe("external connections; empty array for pure funcs"),
  dangerClass: z.enum(["benign", "costly", "catastrophic"]),
  idempotencyMechanism: z.enum([
    "provider-key",
    "upsert",
    "read-before-write",
    "claim",
    "none",
  ]),
});

export type FuncDraft = z.infer<typeof funcDraftZ>;
