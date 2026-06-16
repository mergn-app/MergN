import { generateText, Output } from "ai";
import { z } from "zod";
import { getModel } from "./model";

const probeZ = z.object({
  ok: z.boolean().describe("always true"),
  sum: z.number().describe("the sum of the two numbers named in the prompt"),
  label: z.string().describe("a single lowercase word, exactly: ping"),
});

export interface ProbeResult {
  // the model returned a schema-valid object at all (can follow JSON schema)
  structured: boolean;
  // the object's values were also correct (basic instruction-following)
  accurate: boolean;
  latencyMs: number;
  error?: string;
}

/**
 * One-shot capability probe for the CURRENTLY configured model. The whole
 * builder depends on structured (JSON-schema) output; small local models often
 * can't produce it. This runs a tiny forced-schema task with NO retries so the
 * result reflects the model's raw capability, and reports whether it both
 * followed the schema (`structured`) and got the values right (`accurate`).
 */
export async function probeModel(spaceId?: string): Promise<ProbeResult> {
  const start = Date.now();
  try {
    const { output } = await generateText({
      model: getModel(spaceId),
      output: Output.object({ schema: probeZ }),
      system: "Return ONLY the requested structured object, nothing else.",
      prompt: "Set ok=true, sum = 17 + 25, label = 'ping'.",
      maxRetries: 0,
    });
    const structured =
      !!output &&
      typeof output.ok === "boolean" &&
      typeof output.sum === "number" &&
      typeof output.label === "string";
    const accurate = structured && output.sum === 42 && output.ok === true;
    return { structured, accurate, latencyMs: Date.now() - start };
  } catch (e) {
    return {
      structured: false,
      accurate: false,
      latencyMs: Date.now() - start,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}
