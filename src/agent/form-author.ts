import { z } from "zod";
import { genObject } from "./generate";
import { trace, type AgentMeta } from "../observability";

const controlZ = z.enum([
  "text",
  "textarea",
  "number",
  "toggle",
  "select",
  "date",
  "array",
]);

const fieldZ = z.object({
  name: z.string().describe("MUST exactly match one of the given trigger field names"),
  label: z.string().describe("short human label, e.g. 'Customer email'"),
  control: controlZ,
  placeholder: z.string().optional(),
  help: z.string().optional().describe("one short hint, only when useful"),
  required: z.boolean().optional(),
  options: z
    .array(z.object({ label: z.string(), value: z.string() }))
    .optional()
    .describe("only for the 'select' control"),
  defaultValue: z.string().optional(),
});

export const inputFormZ = z.object({
  title: z.string().optional(),
  fields: z.array(fieldZ).default([]),
});

export type InputForm = z.infer<typeof inputFormZ>;
export type FormField = z.infer<typeof fieldZ>;

const SYSTEM = [
  "You design a friendly INPUT FORM for a workflow's trigger.",
  "You get the automation goal and the EXACT list of trigger input field names the workflow reads at run time.",
  "Produce ONE field per given name (reuse the name verbatim), choosing the best control plus a human label, and a placeholder/help where useful.",
  "Controls: text (short string), textarea (long text or a message body), number (amounts, counts, money), toggle (a yes/no boolean), select (a small fixed set of choices — provide options), date.",
  "Prefer number for money/amounts; for an email use text with an email-like placeholder; use select ONLY when there is a clear small set of valid values, otherwise text.",
  "When a field lists the step that consumes it, base the field's label and help on THAT step's domain/service — not on possibly-stale wording in the goal.",
  "Never invent fields that are not in the list. Keep labels concise.",
].join("\n");

export async function authorInputForm(
  goal: string,
  fields: string[],
  fieldHints?: Record<string, string>,
  meta?: AgentMeta,
): Promise<InputForm> {
  if (fields.length === 0) return { fields: [] };

  const hintLines = fields
    .filter((name) => fieldHints?.[name])
    .map((name) => `- ${name}: used by step "${fieldHints![name]}"`)
    .join("\n");

  const output = await genObject({
    schema: inputFormZ,
    system: SYSTEM,
    telemetry: trace("author-input-form", meta),
    spaceId: meta?.spaceId,
    prompt: [
      `Goal: ${goal || "(not given)"}`,
      `Trigger fields: ${fields.join(", ")}`,
      hintLines ? `Consuming steps (label each field for its step's domain):\n${hintLines}` : "",
    ]
      .filter(Boolean)
      .join("\n"),
  });

  const known = new Set(fields);
  const byName = new Map(
    output.fields.filter((f) => known.has(f.name)).map((f) => [f.name, f]),
  );
  const finalFields: FormField[] = fields.map(
    (name) =>
      byName.get(name) ?? { name, label: name, control: "text" as const },
  );
  return { title: output.title, fields: finalFields };
}
