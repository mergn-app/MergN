import { useTranslation } from "react-i18next";
import type { LlmProbe } from "./queries";

const MODEL_DOCS: Record<string, string> = {
  google: "https://ai.google.dev/gemini-api/docs/models/gemini",
  openai: "https://platform.openai.com/docs/models",
  anthropic: "https://docs.anthropic.com/en/docs/about-claude/models",
};

const MODEL_EXAMPLES: Record<string, string> = {
  google: "gemini-2.5-flash",
  openai: "gpt-4o",
  anthropic: "claude-3-5-sonnet-latest",
  local: "qwen2.5:14b",
};

export function isLikelyModelNameError(message: string): boolean {
  const m = message.toLowerCase();
  return [
    "model",
    "not found",
    "404",
    "invalid",
    "does not exist",
    "unknown",
    "unsupported",
    "no such",
  ].some((s) => m.includes(s));
}

export function shouldShowModelNameHelp(
  provider: string,
  model: string,
  saveError: string | null,
  probe: LlmProbe | null,
): boolean {
  if (!model.trim()) return false;
  if (provider === "mergn") return false;
  if (saveError && isLikelyModelNameError(saveError)) return true;
  if (probe?.error && isLikelyModelNameError(probe.error)) return true;
  if (probe?.weak && !probe.structured && model.trim()) return true;
  return false;
}

export function ModelNameErrorHelp({ provider }: { provider: string }) {
  const { t } = useTranslation();
  const docs = MODEL_DOCS[provider];
  const example = MODEL_EXAMPLES[provider];

  return (
    <div className="space-y-1.5 rounded-lg border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-[11px] text-destructive">
      <p className="font-medium">{t("llm.modelInvalidHelp")}</p>
      {example ? (
        <p className="text-destructive/90">
          {t("llm.modelNameFormatHint", { example })}
        </p>
      ) : null}
      {docs ? (
        <p>
          <a
            href={docs}
            target="_blank"
            rel="noopener noreferrer"
            className="underline underline-offset-2 hover:text-destructive/80"
          >
            {t("llm.modelDocsLink")}
          </a>
        </p>
      ) : null}
      <p className="text-destructive/90">{t("llm.modelDefaultHint")}</p>
    </div>
  );
}
