import { generateText, Output } from "ai";
import { google } from "@ai-sdk/google";
import { z } from "zod";
import { trace, type AgentMeta } from "../observability";

const controlZ = z.enum([
  "text",
  "textarea",
  "number",
  "toggle",
  "select",
  "date",
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
  fields: z.array(fieldZ),
});

export type InputForm = z.infer<typeof inputFormZ>;
export type FormField = z.infer<typeof fieldZ>;

const SYSTEM = [
  "You design a friendly INPUT FORM for a workflow's trigger.",
  "You get the automation goal and the EXACT list of trigger input field names the workflow reads at run time.",
  "Produce ONE field per given name (reuse the name verbatim), choosing the best control plus a human label, and a placeholder/help where useful.",
  "Controls: text (short string), textarea (long text or a message body), number (amounts, counts, money), toggle (a yes/no boolean), select (a small fixed set of choices — provide options), date.",
  "Prefer number for money/amounts; for an email use text with an email-like placeholder; use select ONLY when there is a clear small set of valid values, otherwise text.",
  "Never invent fields that are not in the list. Keep labels concise.",
].join("\n");

export async function authorInputForm(
  goal: string,
  fields: string[],
  meta?: AgentMeta,
): Promise<InputForm> {
  if (fields.length === 0) return { fields: [] };

  const { output } = await generateText({
    model: google(process.env.GEMINI_MODEL ?? "gemini-2.5-flash"),
    output: Output.object({ schema: inputFormZ }),
    system: SYSTEM,
    experimental_telemetry: trace("author-input-form", meta),
    prompt: [
      `Goal: ${goal || "(not given)"}`,
      `Trigger fields: ${fields.join(", ")}`,
    ].join("\n"),
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
