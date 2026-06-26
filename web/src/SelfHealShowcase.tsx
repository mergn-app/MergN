import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Wrench,
  Check,
  Ban,
  RotateCcw,
  Sparkles,
  ShieldAlert,
  Lock,
  Search,
  Stethoscope,
  Zap,
  ArrowLeftRight,
  AlertTriangle,
  Pause,
  Play,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";

// A compact, faithful replica of the real self-heal surface. The right panel
// ("You stay in control") is fixed; the left panel walks through the real
// lifecycle — Detect → Diagnose → Fix — as three animated stages. The whole
// point: every change waits for the user, and the user can stop healing.

type FixMode = "notify" | "propose" | "auto";
type Decision = "proposed" | "applied" | "rejected";

type StepSource =
  | { kind: "trigger" }
  | { kind: "step"; num: number; title: string }
  | { kind: "unbound" };

interface Step {
  id: string;
  num: number;
  title: string;
  pure: boolean;
  provider?: string;
  modified?: boolean;
  input: { name: string; source: StepSource };
  output: string;
}

// The culprit (post_discord) receives an unbound `message` — the failure the
// fix repairs by wiring it from Format Alert.
const STEPS: Step[] = [
  {
    id: "parse_event",
    num: 1,
    title: "Parse Event",
    pure: true,
    input: { name: "payload", source: { kind: "trigger" } },
    output: "amount",
  },
  {
    id: "format_alert",
    num: 2,
    title: "Format Alert",
    pure: true,
    input: {
      name: "amount",
      source: { kind: "step", num: 1, title: "Parse Event" },
    },
    output: "message",
  },
  {
    id: "post_discord",
    num: 3,
    title: "Post Discord",
    pure: false,
    provider: "discord",
    modified: true,
    input: { name: "message", source: { kind: "unbound" } },
    output: "messageId",
  },
];

const STAGES: { id: "detect" | "diagnose" | "fix"; icon: LucideIcon }[] = [
  { id: "detect", icon: Search },
  { id: "diagnose", icon: Stethoscope },
  { id: "fix", icon: Wrench },
];
const STAGE_MS = 3200;
const AUTO_RING_R = 11;
const AUTO_RING_C = 2 * Math.PI * AUTO_RING_R;

function SourceChip({ source }: { source: StepSource }) {
  if (source.kind === "unbound") {
    return (
      <span className="text-tone-rose-fg">⚠ {`{unwired}`}</span>
    );
  }
  if (source.kind === "trigger") {
    return (
      <span className="text-tone-amber-fg/90">
        ← <span className="text-tone-amber-fg">trigger</span>
      </span>
    );
  }
  return (
    <span className="text-tone-blue-fg">
      ←{" "}
      <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-tone-blue/12 px-1 text-[10px] font-medium text-tone-blue-fg">
        {source.num}
      </span>{" "}
      {source.title}
    </span>
  );
}

function Switch({
  on,
  onChange,
  disabled,
  tone = "emerald",
}: {
  on: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  tone?: "emerald" | "rose";
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => onChange(!on)}
      className={cn(
        "flex h-5 w-9 shrink-0 items-center rounded-full p-0.5 transition-colors disabled:opacity-40",
        on
          ? tone === "rose"
            ? "bg-rose-500/80"
            : "bg-emerald-500/80"
          : "bg-muted-foreground/30",
      )}
    >
      <span
        className={cn(
          "size-4 rounded-full bg-background shadow-sm ring-1 ring-black/5 transition-transform",
          on && "translate-x-4",
        )}
      />
    </button>
  );
}

function Segmented({
  value,
  options,
  onChange,
}: {
  value: FixMode;
  options: { value: FixMode; label: string }[];
  onChange: (v: FixMode) => void;
}) {
  return (
    <div className="inline-flex rounded-lg bg-muted p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          className={cn(
            "rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
            value === o.value
              ? "bg-background text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

// ── Stage content ──────────────────────────────────────────────────────────

function DetectStage() {
  const { t } = useTranslation();
  return (
    <div className="rounded-2xl border border-rose-500/30 bg-rose-500/5 p-4">
      <div className="flex items-center gap-2">
        <AlertTriangle className="size-4 text-rose-500" />
        <span className="text-sm font-medium">
          {t("landing.selfHeal.runFailed")}
        </span>
        <span className="ml-auto rounded-full bg-rose-500/15 px-2 py-0.5 text-[10px] font-medium text-rose-600 dark:text-rose-400">
          {t("status.failed")}
        </span>
      </div>
      <div className="mt-1 text-[11px] text-muted-foreground">
        {t("landing.selfHeal.detectMeta")}
      </div>
      <div className="mt-3 space-y-1.5">
        {["parse_event", "format_alert", "post_discord"].map((id, i) => (
          <div
            key={id}
            className={cn(
              "flex items-center gap-2.5 rounded-xl border px-2.5 py-1.5 text-[13px]",
              i === 2
                ? "border-rose-500/40 bg-rose-500/5"
                : "border-border/40 bg-background/50",
            )}
          >
            <span
              className={cn(
                "size-2 shrink-0 rounded-full",
                i === 2 ? "bg-rose-500" : "bg-emerald-500",
              )}
            />
            <span className="font-mono text-foreground/80">{id}</span>
            {i === 2 && (
              <span className="ml-auto font-mono text-[11px] text-rose-600 dark:text-rose-400">
                {t("status.failed")}
              </span>
            )}
          </div>
        ))}
      </div>
      <div className="mt-3 rounded-lg border border-rose-500/30 bg-background px-3 py-2 font-mono text-[11px] text-rose-600 dark:text-rose-400">
        {t("landing.selfHeal.detectError")}
      </div>
    </div>
  );
}

function DiagnoseStage() {
  const { t } = useTranslation();
  return (
    <div>
      <div className="mb-3 flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/5 px-3 py-2">
        <Stethoscope className="mt-0.5 size-3.5 shrink-0 text-amber-500" />
        <span className="text-xs leading-relaxed text-foreground/90">
          {t("landing.selfHeal.diagnosis")}
        </span>
      </div>
      <div className="flex flex-col">
        <div className="rounded-2xl border border-tone-amber/30 bg-tone-amber/5 px-3 py-2">
          <div className="flex items-center gap-2">
            <span className="flex items-center justify-center rounded-lg bg-tone-amber/15 p-1.5 text-tone-amber-fg">
              <Zap className="h-3.5 w-3.5" />
            </span>
            <span className="text-xs font-medium text-tone-amber-fg">
              {t("trigger.title")}
            </span>
            <span className="ml-auto rounded-md bg-tone-amber/12 px-1.5 py-0.5 font-mono text-[10px] text-tone-amber-fg">
              payload
            </span>
          </div>
        </div>

        {STEPS.map((s) => (
          <div key={s.id} className="flex flex-col items-stretch">
            <span
              className={cn(
                "mx-auto h-4 w-px",
                s.modified ? "bg-rose-500/60" : "bg-border",
              )}
            />
            <div
              className={cn(
                "rounded-2xl border bg-card p-3",
                s.modified
                  ? "border-amber-500/40 ring-2 ring-amber-500/70"
                  : "border-border/60",
              )}
            >
              <div className="flex items-center gap-2">
                <span
                  className={cn(
                    "flex items-center justify-center rounded-xl p-1.5",
                    s.pure
                      ? "bg-tone-emerald/15 text-tone-emerald-fg"
                      : "bg-tone-blue/15 text-tone-blue-fg",
                  )}
                >
                  {s.pure ? (
                    <ArrowLeftRight className="h-3.5 w-3.5" />
                  ) : (
                    <Zap className="h-3.5 w-3.5" />
                  )}
                </span>
                <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-muted px-1 text-[11px] font-medium text-muted-foreground">
                  {s.num}
                </span>
                <span className="truncate text-sm font-medium">{s.title}</span>
                <div className="ml-auto flex items-center gap-2">
                  {s.provider && (
                    <span className="font-mono text-[11px] text-muted-foreground">
                      {s.provider}
                    </span>
                  )}
                  {s.modified && (
                    <span className="inline-flex items-center gap-1 rounded-full bg-rose-500/15 px-1.5 py-0.5 text-[10px] font-medium text-rose-600 dark:text-rose-400">
                      <AlertTriangle className="size-2.5" />
                    </span>
                  )}
                </div>
              </div>
              <div className="mt-2.5 flex items-center gap-2 border-t border-border/60 pt-2.5 font-mono text-[11px]">
                <span className="w-6 shrink-0 text-muted-foreground/60">in</span>
                <span className="text-foreground/90">{s.input.name}</span>
                <span className="ml-auto">
                  <SourceChip source={s.input.source} />
                </span>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function FixStage({
  decision,
  setDecision,
  locked,
  onInteract,
}: {
  decision: Decision;
  setDecision: (d: Decision) => void;
  locked: boolean;
  onInteract: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div>
      <div className="rounded-2xl border border-border/50 bg-background-subtle/30 p-4">
        <div className="flex items-center gap-2">
          <Wrench className="size-4 text-emerald-500" />
          <span className="text-sm font-medium">{t("heal.fixTitle")}</span>
          <span className="ml-auto rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-medium text-emerald-600 dark:text-emerald-400">
            {t("heal.confidence.high")}
          </span>
        </div>

        <div className="mt-3 font-mono text-[11px] text-foreground/80">
          post_discord · message
        </div>
        <div className="mt-2 space-y-1.5">
          <div className="flex items-center gap-2 rounded-lg border border-rose-500/30 bg-rose-500/5 px-3 py-2 font-mono text-[11px]">
            <span className="w-10 shrink-0 text-rose-600 dark:text-rose-400">
              {t("review.removed")}
            </span>
            <span className="text-tone-rose-fg">⚠ message {`{unwired}`}</span>
          </div>
          <div className="flex items-center gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 font-mono text-[11px]">
            <span className="w-10 shrink-0 text-emerald-600 dark:text-emerald-400">
              {t("review.added")}
            </span>
            <span className="text-emerald-600 dark:text-emerald-400">
              message ← Format Alert
            </span>
          </div>
        </div>
      </div>

      <div className="mt-3 flex items-center gap-1.5 text-[11px] font-medium text-foreground/80">
        <ShieldAlert className="size-3.5 text-amber-500" />
        {t("landing.selfHeal.controlBanner")}
      </div>

      <div className="mt-2">
        {decision === "proposed" ? (
          <div className="flex items-center justify-end gap-2">
            <button
              onClick={() => {
                onInteract();
                setDecision("rejected");
              }}
              disabled={locked}
              className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40"
            >
              <Ban className="size-3.5" /> {t("heal.reject")}
            </button>
            <button
              onClick={() => {
                onInteract();
                setDecision("applied");
              }}
              disabled={locked}
              className="flex items-center gap-1.5 rounded-lg bg-emerald-500/90 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-500 disabled:opacity-40"
            >
              <Check className="size-3.5" /> {t("heal.approve")}
            </button>
          </div>
        ) : (
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-muted-foreground">
              {decision === "applied"
                ? t("landing.selfHeal.applied")
                : t("landing.selfHeal.rejected")}
            </span>
            <button
              onClick={() => {
                onInteract();
                setDecision("proposed");
              }}
              className="flex items-center gap-1.5 rounded-lg border border-border/50 px-3 py-1.5 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <RotateCcw className="size-3.5" /> {t("heal.undo")}
            </button>
          </div>
        )}
        {locked && (
          <div className="mt-2 flex items-center gap-1.5 rounded-lg bg-amber-500/10 px-2.5 py-1.5 text-[11px] text-amber-600 dark:text-amber-400">
            <Lock className="size-3" /> {t("heal.reason.kill-switch")}
          </div>
        )}
      </div>
    </div>
  );
}

export function SelfHealShowcase() {
  const { t } = useTranslation();
  const [stage, setStage] = useState(0);
  const [autoPlay, setAutoPlay] = useState(true);
  const [decision, setDecision] = useState<Decision>("proposed");
  const [mode, setMode] = useState<FixMode>("propose");
  const [healEnabled, setHealEnabled] = useState(true);
  const [autoReplay, setAutoReplay] = useState(false);
  const [killSwitch, setKillSwitch] = useState(false);

  const locked = killSwitch || !healEnabled;

  useEffect(() => {
    if (!autoPlay) return;
    const id = setInterval(() => {
      setStage((s) => {
        const next = (s + 1) % STAGES.length;
        if (next === 0) setDecision("proposed");
        return next;
      });
    }, STAGE_MS);
    return () => clearInterval(id);
  }, [autoPlay]);

  const goStage = (i: number) => {
    setAutoPlay(false);
    setStage(i);
    if (STAGES[i].id !== "fix") setDecision("proposed");
  };

  return (
    <div className="grid w-full grid-cols-1 overflow-hidden rounded-2xl border border-border/50 bg-card shadow-sm lg:grid-cols-[2fr_1fr]">
      {/* Left: the Detect → Diagnose → Fix lifecycle, animated */}
      <div className="flex min-h-[420px] flex-col border-b border-border/40 lg:border-b-0 lg:border-r">
        {/* stepper */}
        <div className="border-b border-border/40 bg-muted/20 px-3 pt-3">
          <div className="flex items-center gap-2">
            {STAGES.map((st, i) => {
              const Icon = st.icon;
              const active = i === stage;
              const done = i < stage;
              return (
                <button
                  key={st.id}
                  onClick={() => goStage(i)}
                  className={cn(
                    "flex flex-1 items-center gap-2 rounded-lg border px-2.5 py-1.5 text-left transition-colors",
                    active
                      ? "border-primary/40 bg-background text-foreground"
                      : "border-border/50 bg-background/40 text-muted-foreground hover:text-foreground",
                  )}
                >
                  <span
                    className={cn(
                      "flex size-5 shrink-0 items-center justify-center rounded-full text-[11px] font-medium",
                      active
                        ? "bg-primary/15 text-primary"
                        : done
                          ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
                          : "bg-muted text-muted-foreground",
                    )}
                  >
                    {done ? <Check className="size-3" /> : i + 1}
                  </span>
                  <span className="flex items-center gap-1.5 truncate text-xs font-medium">
                    <Icon className="size-3.5 shrink-0" />
                    <span className="truncate">
                      {t(`landing.selfHeal.${st.id}`)}
                    </span>
                  </span>
                </button>
              );
            })}
            <button
              type="button"
              onClick={() => setAutoPlay((v) => !v)}
              className="relative inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-border/60 bg-background text-muted-foreground transition-colors hover:text-foreground"
              title={
                autoPlay
                  ? t("landing.autoRotate.pause", { defaultValue: "Pause rotation" })
                  : t("landing.autoRotate.resume", { defaultValue: "Resume rotation" })
              }
            >
              {autoPlay && (
                <svg
                  viewBox="0 0 28 28"
                  className="pointer-events-none absolute inset-0 h-full w-full -rotate-90"
                  aria-hidden="true"
                >
                  <circle
                    cx="14"
                    cy="14"
                    r={AUTO_RING_R}
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    className="text-border/60"
                  />
                  <circle
                    key={stage}
                    cx="14"
                    cy="14"
                    r={AUTO_RING_R}
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeDasharray={AUTO_RING_C}
                    className="landing-rotate-ring text-primary"
                    style={
                      {
                        "--ring-c": AUTO_RING_C,
                        "--ring-duration": `${STAGE_MS}ms`,
                      } as React.CSSProperties
                    }
                  />
                </svg>
              )}
              {autoPlay ? (
                <Pause className="h-3.5 w-3.5" />
              ) : (
                <Play className="h-3.5 w-3.5" />
              )}
            </button>
          </div>
          <div className="px-0.5 pb-2 pt-2 text-[11px] text-muted-foreground">
            {t(`landing.selfHeal.${STAGES[stage].id}Desc`)}
          </div>
        </div>

        {/* animated stage content */}
        <div className="min-h-0 flex-1 overflow-auto p-4">
          <div
            key={STAGES[stage].id}
            className="animate-in fade-in slide-in-from-bottom-2 duration-500"
          >
            {STAGES[stage].id === "detect" && <DetectStage />}
            {STAGES[stage].id === "diagnose" && <DiagnoseStage />}
            {STAGES[stage].id === "fix" && (
              <FixStage
                decision={decision}
                setDecision={setDecision}
                locked={locked}
                onInteract={() => setAutoPlay(false)}
              />
            )}
          </div>
        </div>
      </div>

      {/* Right: the control panel (fixed) */}
      <div className="flex min-h-[300px] flex-col gap-3 p-4">
        <div className="flex items-center gap-2">
          <Sparkles className="size-4 text-emerald-500" />
          <span className="text-sm font-semibold">
            {t("landing.selfHeal.controlTitle")}
          </span>
        </div>

        <section className="rounded-xl border border-border/40 bg-background-subtle/30 p-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="text-sm font-medium">{t("settings.heal")}</div>
              <div className="mt-0.5 text-xs text-muted-foreground">
                {t("settings.healHint")}
              </div>
            </div>
            <Switch on={healEnabled} onChange={setHealEnabled} />
          </div>

          <div className="mt-2 border-t border-border/40 pt-2">
            <div
              className={cn(
                "flex items-start justify-between gap-3 py-1.5",
                !healEnabled && "opacity-50",
              )}
            >
              <div className="min-w-0">
                <div className="text-sm font-medium">{t("settings.mode")}</div>
                <div className="mt-0.5 text-xs text-muted-foreground">
                  {t("settings.modeHint")}
                </div>
              </div>
            </div>
            <div
              className={cn(!healEnabled && "pointer-events-none opacity-50")}
            >
              <Segmented
                value={mode}
                onChange={setMode}
                options={[
                  { value: "notify", label: t("settings.modeNotify") },
                  { value: "propose", label: t("settings.modePropose") },
                  { value: "auto", label: t("settings.modeAuto") },
                ]}
              />
            </div>
            {mode === "auto" && (
              <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
                {t("landing.selfHeal.guardrails")}
              </p>
            )}
          </div>

          <div
            className={cn(
              "mt-1 flex items-start justify-between gap-3 border-t border-border/40 pt-2",
              !healEnabled && "opacity-50",
            )}
          >
            <div className="min-w-0">
              <div className="text-sm font-medium">
                {t("settings.autoReplay")}
              </div>
              <div className="mt-0.5 text-xs text-muted-foreground">
                {t("settings.autoReplayHint")}
              </div>
            </div>
            <Switch
              on={autoReplay}
              disabled={!healEnabled}
              onChange={setAutoReplay}
            />
          </div>
        </section>

        <section
          className={cn(
            "rounded-xl border p-3",
            killSwitch
              ? "border-rose-500/40 bg-rose-500/5"
              : "border-border/40 bg-background-subtle/30",
          )}
        >
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-start gap-2">
              <ShieldAlert className="mt-0.5 size-4 text-muted-foreground" />
              <div className="min-w-0">
                <div className="text-sm font-medium">{t("governance.kill")}</div>
                <div className="mt-0.5 text-xs text-muted-foreground">
                  {t("governance.killHint")}
                </div>
              </div>
            </div>
            <Switch tone="rose" on={killSwitch} onChange={setKillSwitch} />
          </div>
        </section>
      </div>
    </div>
  );
}
