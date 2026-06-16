import { useState, useRef, useEffect } from "react";
import { useTranslation } from "react-i18next";
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

const PROVIDERS = [
  { value: "mergn", label: "MergN (built-in)" },
  { value: "google", label: "Google (Gemini)" },
  { value: "openai", label: "OpenAI" },
  { value: "anthropic", label: "Anthropic (Claude)" },
  { value: "local", label: "Local (Ollama / LM Studio / vLLM)" },
];

const MODEL_PLACEHOLDER: Record<string, string> = {
  google: "gemini-2.5-flash",
  openai: "gpt-4o",
  anthropic: "claude-3-5-sonnet-latest",
  local: "qwen2.5:14b",
};

function LlmForm({
  current,
  onRefresh,
  onClose,
}: {
  current: LlmSettings;
  onRefresh: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [provider, setProvider] = useState(current.provider || "mergn");
  const [model, setModel] = useState(current.model || "");
  const [baseURL, setBaseURL] = useState(current.baseURL || "");
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [probing, setProbing] = useState(false);
  const [probe, setProbe] = useState<LlmProbe | null>(null);
  const [error, setError] = useState<string | null>(null);

  const isLocal = provider === "local";
  const isMergn = provider === "mergn";
  const fieldCls =
    "w-full rounded-lg border border-border/60 bg-background-subtle px-2 py-1 text-xs outline-none focus:border-border";

  const save = async () => {
    setSaving(true);
    setError(null);
    setProbe(null);
    try {
      await saveLlmSettings({
        provider,
        model: model || undefined,
        baseURL: baseURL || undefined,
        apiKey: apiKey || undefined,
      });
      onRefresh();
      // verify the freshly-saved model can actually do structured output
      setSaving(false);
      setProbing(true);
      const result = await probeLlm().catch(() => null);
      setProbing(false);
      if (result) {
        setProbe(result);
        // happy path (capable model): close shortly; weak model: stay open with the warning
        if (!result.weak) setTimeout(onClose, 900);
      } else {
        onClose();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSaving(false);
      setProbing(false);
    }
  };

  return (
    <div className="space-y-2">
      <Select value={provider} onValueChange={setProvider}>
        <SelectTrigger size="sm" className="w-full bg-background-subtle text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {PROVIDERS.map((p) => (
            <SelectItem key={p.value} value={p.value}>
              {p.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {isMergn ? (
        <p className="rounded-lg bg-secondary/50 px-2 py-1.5 text-[11px] text-muted-foreground">
          MergN's built-in model. No API key needed — usage counts toward your plan.
        </p>
      ) : (
        <>
          <input
            className={fieldCls}
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder={MODEL_PLACEHOLDER[provider] ?? ""}
          />
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
            Your own key — usage is billed to you, not counted toward your plan limits.
          </p>
        </>
      )}

      {error && <p className="text-[11px] text-destructive">{error}</p>}

      <button
        type="button"
        onClick={save}
        disabled={saving || probing}
        className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-foreground px-2 py-1.5 text-xs font-medium text-background transition-opacity hover:opacity-90 disabled:opacity-50"
      >
        {(saving || probing) && <Loader2 className="size-3 animate-spin" />}
        {probing ? "Model test ediliyor…" : t("common.save")}
      </button>

      {probe?.weak && probe.local && (
        <div className="space-y-1 rounded-lg border border-amber-500/40 bg-amber-500/10 px-2 py-1.5 text-[11px] text-amber-200">
          <p className="font-medium">⚠ Bu model builder için zayıf görünüyor</p>
          <p className="text-amber-200/80">
            {probe.structured
              ? "Yapılandırılmış çıktıyı üretti ama yanlış (talimatı tam izleyemedi)."
              : "Gerekli JSON şemasını üretemedi."}{" "}
            Builder her adımı şema-zorlamalı üretir; küçük/yerel modeller çoğu zaman
            bunu yapamaz. Daha güçlü bir model önerilir: <b>Llama 3.1 70B</b> /{" "}
            <b>Qwen 2.5 32B+</b> ya da bir bulut modeli (Gemini / GPT-4o / Claude).
          </p>
        </div>
      )}
      {probe?.weak && !probe.local && (
        <div className="space-y-1 rounded-lg border border-amber-500/40 bg-amber-500/10 px-2 py-1.5 text-[11px] text-amber-200">
          <p className="font-medium">⚠ Model testi başarısız</p>
          <p className="text-amber-200/80">
            Bu sağlayıcı yanıt vermedi — büyük olasılıkla anahtar, kota veya
            faturalandırma sorunu.{" "}
            {probe.error ? <span className="opacity-80">({probe.error})</span> : null}
          </p>
        </div>
      )}
      {probe && !probe.weak && (
        <p className="text-[11px] text-emerald-400">
          ✓ Model yapılandırılmış çıktıyı geçti ({probe.latencyMs} ms)
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
  const { user } = useAuth();
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
                You're on <b className="text-foreground">MergN</b>, the built-in model.
                Upgrade to Pro to use your own model and API key — your own usage isn't
                counted toward your plan limits.
              </p>
              <a
                href="/billing"
                className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-foreground px-2 py-1.5 text-xs font-medium text-background transition-opacity hover:opacity-90"
              >
                <Sparkles className="size-3.5" /> Upgrade to Pro
              </a>
            </div>
          ) : (
            <LlmForm
              current={current}
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
