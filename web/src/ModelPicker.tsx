import { useState, useRef, useEffect } from "react";
import { useTranslation, Trans } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { ChevronUp, Loader2, Sparkles, X } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  useLlmSettings,
  saveLlmSettings,
  probeLlm,
  type LlmSettings,
  type LlmProbe,
} from "./queries";
import { useAuth } from "./authContext";
import { getSpace } from "./space";
import {
  ModelNameErrorHelp,
  shouldShowModelNameHelp,
} from "./llm-model-help";

const ALL_PROVIDERS = [
  { value: "mergn", label: "MergN (built-in)" },
  { value: "google", label: "Google (Gemini)" },
  { value: "openai", label: "OpenAI" },
  { value: "anthropic", label: "Anthropic (Claude)" },
  { value: "local", label: "Local (Ollama / LM Studio / vLLM)" },
];

function providersFor(managed: boolean | null) {
  if (managed === true) return ALL_PROVIDERS;
  return ALL_PROVIDERS.filter((p) => p.value !== "mergn");
}

function initialProvider(current: LlmSettings, managed: boolean | null) {
  const p = current.provider || "";
  if (managed === true) return p || "mergn";
  if (p && p !== "mergn") return p;
  return "google";
}

const MODEL_PLACEHOLDER: Record<string, string> = {
  google: "gemini-2.5-flash",
  openai: "gpt-4o",
  anthropic: "claude-3-5-sonnet-latest",
  local: "qwen2.5:14b",
};

function LlmForm({
  current,
  managed,
  onRefresh,
  onClose,
}: {
  current: LlmSettings;
  managed: boolean | null;
  onRefresh: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const providers = providersFor(managed);
  const [provider, setProvider] = useState(() =>
    initialProvider(current, managed),
  );
  const [model, setModel] = useState(current.model || "");
  const [baseURL, setBaseURL] = useState(current.baseURL || "");
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [probing, setProbing] = useState(false);
  const [probe, setProbe] = useState<LlmProbe | null>(null);
  const [error, setError] = useState<string | null>(null);

  const isLocal = provider === "local";
  const isMergn = managed === true && provider === "mergn";
  const fieldCls =
    "w-full rounded-lg border border-border/60 bg-background-subtle px-2 py-1 text-xs outline-none focus:border-border";

  const save = async () => {
    setSaving(true);
    setError(null);
    setProbe(null);
    try {
      const saveResult = await saveLlmSettings({
        provider,
        model: model.trim() || undefined,
        baseURL: baseURL || undefined,
        apiKey: apiKey || undefined,
      });
      onRefresh();
      if (saveResult.modelRejected) {
        setSaving(false);
        setError(saveResult.error ?? "Model not found");
        return;
      }
      setSaving(false);
      setProbing(true);
      let probeFetchError: string | null = null;
      const probeResult = await probeLlm().catch((e) => {
        probeFetchError = e instanceof Error ? e.message : String(e);
        return null;
      });
      setProbing(false);
      if (probeFetchError) {
        setError(probeFetchError);
        return;
      }
      if (probeResult) {
        setProbe(probeResult);
        if (shouldShowModelNameHelp(provider, model, null, probeResult)) return;
        if (!probeResult.weak) setTimeout(onClose, 900);
      } else {
        onClose();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSaving(false);
      setProbing(false);
    }
  };

  const modelNameHelp = shouldShowModelNameHelp(provider, model, error, probe);

  return (
    <div className="space-y-2">
      <Select value={provider} onValueChange={setProvider}>
        <SelectTrigger size="sm" className="w-full bg-background-subtle text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {providers.map((p) => (
            <SelectItem key={p.value} value={p.value}>
              {p.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {isMergn ? (
        <p className="rounded-lg bg-secondary/50 px-2 py-1.5 text-[11px] text-muted-foreground">
          {t("llm.mergnBuiltIn")}
        </p>
      ) : (
        <>
          <input
            className={fieldCls}
            value={model}
            onChange={(e) => {
              setModel(e.target.value);
              setError(null);
              setProbe(null);
            }}
            placeholder={MODEL_PLACEHOLDER[provider] ?? t("llm.modelOptionalHint")}
          />
          <p className="px-0.5 text-[10px] text-muted-foreground/70">
            {t("llm.modelOptionalHint")}
          </p>
          {isLocal ? (
            <input
              className={`${fieldCls} font-mono`}
              value={baseURL}
              onChange={(e) => setBaseURL(e.target.value)}
              placeholder="http://host.docker.internal:11434/v1"
            />
          ) : (
            <input
              type="password"
              className={`${fieldCls} font-mono`}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={current.hasApiKey ? t("llm.keyUnchanged") : "sk-…"}
            />
          )}
          <p className="px-0.5 text-[10px] text-muted-foreground/70">
            {t("llm.ownKeyHint")}
          </p>
        </>
      )}

      {modelNameHelp ? (
        <ModelNameErrorHelp provider={provider} />
      ) : error ? (
        <p className="text-[11px] text-destructive">{error}</p>
      ) : null}

      <button
        type="button"
        onClick={save}
        disabled={saving || probing}
        className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-foreground px-2 py-1.5 text-xs font-medium text-background transition-opacity hover:opacity-90 disabled:opacity-50"
      >
        {(saving || probing) && <Loader2 className="size-3 animate-spin" />}
        {probing ? t("llm.probing") : t("common.save")}
      </button>

      {probe?.weak && probe.local && !modelNameHelp && (
        <div className="space-y-1 rounded-lg border border-amber-500/40 bg-amber-500/10 px-2 py-1.5 text-[11px] text-amber-200">
          <p className="font-medium">{t("llm.weakLocalTitle")}</p>
          <p className="text-amber-200/80">
            {probe.structured
              ? t("llm.weakLocalStructuredWrong")
              : t("llm.weakLocalNoSchema")}{" "}
            {t("llm.weakLocalAdvice")}
          </p>
        </div>
      )}
      {probe?.weak && !probe.local && !modelNameHelp && (
        <div className="space-y-1 rounded-lg border border-amber-500/40 bg-amber-500/10 px-2 py-1.5 text-[11px] text-amber-200">
          <p className="font-medium">{t("llm.weakCloudTitle")}</p>
          <p className="text-amber-200/80">{t("llm.weakCloudBody")}</p>
        </div>
      )}
      {probe && !probe.weak && (
        <p className="text-[11px] text-emerald-400">
          {t("llm.probeSuccess", { ms: probe.latencyMs })}
        </p>
      )}
    </div>
  );
}

const EMPTY: LlmSettings = {
  provider: "",
  model: "",
  baseURL: "",
  hasApiKey: false,
  configured: false,
  locked: false,
};

export function ModelPicker() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { user, openBilling, managed } = useAuth();
  const { data } = useLlmSettings();
  const [open, setOpen] = useState(false);
  const autoOpened = useRef(false);

  // close on Escape only — NOT on outside click (you may tab away to copy a key).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  // first thing a new user must do: pick a model. Shove the form open once.
  useEffect(() => {
    if (data && !data.configured && !data.locked && !autoOpened.current) {
      autoOpened.current = true;
      setOpen(true);
    }
  }, [data]);

  // Anonymous (logged-out) view in managed deployments: don't prompt to pick a
  // model — the user must sign in first. In self-host (DISABLE_AUTH) the auth
  // context synthesizes a LOCAL_USER, so the picker still renders there.
  if (!user) return null;
  // the deployment forces its model (DISABLE_LLM_SETTINGS) → no picker at all
  if (data?.lockReason === "instance") return null;

  // a Free space can use MergN but must upgrade to bring its own model/key
  const planLocked = data?.lockReason === "plan";
  const configured = !!data?.configured;
  const current = data ?? EMPTY;

  return (
    <div className="relative px-3 pb-2">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "flex items-center gap-1.5 rounded-lg text-xs transition-colors",
          configured
            ? "px-2 py-1 text-muted-foreground hover:bg-secondary"
            : cn(
                "w-full justify-center px-3 py-2 font-medium text-amber-300 ring-1 ring-amber-500/50 bg-amber-500/15 hover:bg-amber-500/25",
                !open && "animate-pulse",
              ),
        )}
      >
        {configured ? (
          <>
            <span className="max-w-44 truncate font-mono">
              {data!.model || data!.provider}
            </span>
            <ChevronUp
              className={cn("size-3 transition-transform", open && "rotate-180")}
            />
          </>
        ) : (
          <>
            <Sparkles className="size-3.5 shrink-0" />
            <span>{t("llm.pickToStart")}</span>
            <ChevronUp
              className={cn("size-3 transition-transform", open && "rotate-180")}
            />
          </>
        )}
      </button>

      {open && (
        <div className="absolute bottom-full left-3 right-3 z-50 mb-1 rounded-xl border border-border/60 bg-background p-3 shadow-xl">
          <div className="mb-2 flex items-center">
            <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">
              {t("llm.selectModel")}
            </span>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="ml-auto text-muted-foreground transition-colors hover:text-foreground"
            >
              <X className="size-3.5" />
            </button>
          </div>
          {planLocked ? (
            <div className="space-y-2">
              <p className="rounded-lg bg-secondary/50 px-2 py-1.5 text-[11px] text-muted-foreground">
                <Trans
                  i18nKey="llm.planLockedBody"
                  components={{
                    bold: <b className="text-foreground" />,
                  }}
                />
              </p>
              <button
                type="button"
                onClick={() => {
                  const sid = getSpace();
                  if (sid) {
                    setOpen(false);
                    openBilling(sid);
                  }
                }}
                className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-foreground px-2 py-1.5 text-xs font-medium text-background transition-opacity hover:opacity-90"
              >
                <Sparkles className="size-3.5" /> {t("llm.upgradeToPro")}
              </button>
            </div>
          ) : (
            <LlmForm
              current={current}
              managed={managed}
              onRefresh={() =>
                qc.invalidateQueries({ queryKey: ["llm-settings"] })
              }
              onClose={() => setOpen(false)}
            />
          )}
        </div>
      )}
    </div>
  );
}
