import { generateText, Output } from "ai";
import { z } from "zod";
import { getModel, getLlmConfig } from "./model";
import { recordTokens } from "../store/usage-cap";
import { assertLlmBudget, recordSpaceTokens } from "./llm-budget";

// Transient failures from structured-output generation: the model returned
// nothing parseable ("No object/output generated"), or a rate/5xx/network blip.
// These are exactly the errors that succeed on a second attempt.
// Hard ceiling on a single LLM call so a hung provider can't stall a build/chat
// forever. On timeout the call aborts, surfaces as a transient error, and is
// retried (or fails cleanly) instead of hanging the request.
const CALL_TIMEOUT_MS = Number(process.env.LLM_CALL_TIMEOUT_MS ?? 90_000);

function isTransient(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  const name = e instanceof Error ? e.name : "";
  return (
    /TimeoutError|AbortError/.test(name) ||
    /no (object|output) generated|rate.?limit|429|5\d\d|overloaded|timeout|timed out|abort|ECONN|fetch failed|terminated|socket/i.test(
      msg,
    )
  );
}

// When a small/local model keeps failing to produce valid structured output,
// turn the cryptic SDK error into an actionable suggestion to switch models.
function enrich(e: unknown): unknown {
  const cfg = getLlmConfig();
  const local = cfg.provider === "local" || cfg.provider === "openai-compatible";
  const msg = e instanceof Error ? e.message : String(e);
  // Provider rejected the request entirely (billing / quota / key / permission) —
  // applies to any provider. Turn the opaque vendor message into a clear action.
  if (
    /denied|dunning|billing|quota|exhausted|forbidden|unauthorized|invalid.{0,12}key|permission|\b403\b|RESOURCE_EXHAUSTED/i.test(
      msg,
    )
  ) {
    return new Error(
      `The AI model provider ('${cfg.provider}') rejected the request — likely a billing, quota, or API-key problem. ` +
        `Fix it in Settings → AI model, or pick a different provider (Anthropic / OpenAI / local). [original: ${msg}]`,
    );
  }
  if (local && /no (object|output) generated|schema|json|parse/i.test(msg)) {
    return new Error(
      `The selected model ('${cfg.model ?? cfg.provider}') could not produce the structured output the builder needs. ` +
        `Small/local models often can't follow the required JSON schema — switch to a stronger model in Settings → AI model ` +
        `(Llama 3.1 70B / Qwen 2.5 32B+, or a cloud model like Gemini/GPT-4o/Claude). [original: ${msg}]`,
    );
  }
  return e;
}

async function withRetry<T>(fn: () => Promise<T>, tries = 3, baseMs = 800): Promise<T> {
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i === tries - 1 || !isTransient(e)) throw enrich(e);
      await new Promise((r) => setTimeout(r, baseMs * 2 ** i));
    }
  }
  throw new Error("unreachable");
}

type Telemetry = Parameters<typeof generateText>[0]["experimental_telemetry"];

/**
 * Structured-output generation with retry. Every authoring agent funnels through
 * here so a flaky empty completion is retried instead of crashing the whole
 * design/build. Returns the validated object for the given zod schema.
 */
export async function genObject<S extends z.ZodTypeAny>(args: {
  schema: S;
  prompt: string;
  system?: string;
  telemetry?: Telemetry;
  spaceId?: string;
}): Promise<z.infer<S>> {
  // Refuse BEFORE spending when the space is over its token budget or the
  // deployment global cap is reached — bounds runaway authoring fan-out.
  await assertLlmBudget(args.spaceId);
  return withRetry(async () => {
    const { output, usage } = await generateText({
      model: getModel(),
      output: Output.object({ schema: args.schema }),
      system: args.system,
      prompt: args.prompt,
      experimental_telemetry: args.telemetry,
      abortSignal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    });
    const t = usage?.totalTokens ?? 0;
    void recordTokens(t); // deployment-wide global cap
    recordSpaceTokens(args.spaceId, t); // per-space billing/quota (real spend)
    return output as z.infer<S>;
  });
}
