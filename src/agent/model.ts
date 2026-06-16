import { google, createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import {
  wrapLanguageModel,
  defaultSettingsMiddleware,
  type LanguageModel,
} from "ai";

// OpenAI's structured outputs run in "strict" mode, which rejects any schema
// whose `required` array doesn't list EVERY property — our schemas use optional
// fields (cron, placeholder, …). Turning strict off lets OpenAI accept them
// (gpt-4o still follows the schema). Other providers ignore this.
const openaiStrictOff = defaultSettingsMiddleware({
  settings: { providerOptions: { openai: { strictJsonSchema: false } } },
});

export interface LlmConfig {
  provider: string; // google | openai | anthropic | local
  model?: string;
  baseURL?: string;
  apiKey?: string;
}

// Self-host global override (from in-app settings, loaded at boot).
let override: LlmConfig | null = null;
// Per-space configs (managed/prod: a Pro space can bring its own model + key).
const spaceConfigs = new Map<string, LlmConfig>();

export function setLlmConfig(cfg: LlmConfig | null): void {
  override = cfg && cfg.provider ? cfg : null;
}

// Set/clear a space's own model config. A config with `provider` set is stored;
// anything else clears it (the space falls back to the built-in "MergN" model).
export function setSpaceLlmConfig(spaceId: string, cfg: LlmConfig | null): void {
  if (cfg && cfg.provider) spaceConfigs.set(spaceId, cfg);
  else spaceConfigs.delete(spaceId);
}

export function getSpaceLlmConfig(spaceId: string): LlmConfig | null {
  return spaceConfigs.get(spaceId) ?? null;
}

// True when this space brings its OWN api key — it pays for its own tokens, so it
// must bypass our rate limits / usage caps and not count toward our usage.
export function spaceUsesOwnKey(spaceId: string): boolean {
  return !!spaceConfigs.get(spaceId)?.apiKey;
}

// Resolve the active config: a space's own config first (prod Pro), then the
// self-host global override, then env (the built-in "MergN" default).
export function getLlmConfig(spaceId?: string): LlmConfig {
  if (spaceId) {
    const c = spaceConfigs.get(spaceId);
    if (c) return c;
  }
  if (override) return override;
  return {
    provider: (process.env.LLM_PROVIDER ?? "google").toLowerCase(),
    model: process.env.LLM_MODEL,
    baseURL: process.env.LLM_BASE_URL,
    apiKey: process.env.LLM_API_KEY,
  };
}

export function getModel(spaceId?: string): LanguageModel {
  const { provider, model, baseURL, apiKey } = getLlmConfig(spaceId);

  switch (provider) {
    case "local":
    case "openai-compatible": {
      const p = createOpenAICompatible({
        name: "local",
        baseURL: baseURL ?? "http://localhost:11434/v1",
        apiKey: apiKey ?? "local",
        // local servers (Ollama/LM Studio/vLLM) that speak json_schema can do
        // the structured output the agents rely on.
        supportsStructuredOutputs: true,
      });
      return p(model ?? "llama3.1");
    }
    case "openai": {
      const openai = createOpenAI({ baseURL, apiKey });
      return wrapLanguageModel({
        model: openai(model ?? "gpt-4o-mini"),
        middleware: openaiStrictOff,
      });
    }
    case "anthropic": {
      const anthropic = createAnthropic({ apiKey });
      return anthropic(model ?? "claude-3-5-sonnet-latest");
    }
    case "google":
    default: {
      const m = model ?? process.env.GEMINI_MODEL ?? "gemini-2.5-flash";
      return apiKey ? createGoogleGenerativeAI({ apiKey })(m) : google(m);
    }
  }
}
