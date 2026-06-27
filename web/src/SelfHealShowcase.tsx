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
import { useShowcaseSpacePause } from "@/hooks/useShowcaseSpacePause";

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
const STAGE_MS = 4200;
const AUTO_RING_R = 11;
const AUTO_RING_C = 2 * Math.PI * AUTO_RING_R;

type FixLineKind = "removed" | "added" | "modified";

interface FixChangeBlock {
  nodeId: string;
  category: "wire" | "input" | "provider";
  lines: { kind: FixLineKind; text: string }[];
}

const FIX_CHANGES: FixChangeBlock[] = [
  {
    nodeId: "post_discord",
    category: "wire",
    lines: [
      { kind: "removed", text: "message ← {unwired}" },
      { kind: "added", text: "message ← format_alert.message" },
      { kind: "added", text: "channelId ← format_alert.channel" },
    ],
  },
  {
    nodeId: "format_alert",
    category: "input",
    lines: [{ kind: "modified", text: "severity ← trigger.level" }],
  },
];

function SourceChip({ source }: { source: StepSource }) {
  if (source.kind === "unbound") {
    return (
      <span className="text-[10px] text-tone-rose-fg">⚠ {`{unwired}`}</span>
    );
  }
  if (source.kind === "trigger") {
    return (
      <span className="text-[10px] text-tone-amber-fg/90">
        ← <span className="text-tone-amber-fg">trigger</span>
      </span>
    );
  }
  return (
    <span className="text-[10px] text-tone-blue-fg">
      ←{" "}
      <span className="inline-flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-tone-blue/12 px-0.5 text-[9px] font-medium text-tone-blue-fg">
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
  const steps = [
    { id: "parse_event", status: "ok" as const, ms: 12 },
    { id: "format_alert", status: "ok" as const, ms: 9 },
    { id: "post_discord", status: "failed" as const, ms: 18 },
  ];
  return (
    <div className="flex h-full flex-col gap-4">
      <div>
        <div className="flex items-center gap-1.5">
          <AlertTriangle className="size-3.5 shrink-0 text-rose-500" />
          <span className="text-xs font-medium">
            {t("landing.selfHeal.runFailed")}
          </span>
          <span className="ml-auto font-mono text-[10px] text-rose-600 dark:text-rose-400">
            {t("status.failed")}
          </span>
        </div>
        <p className="mt-0.5 font-mono text-[10px] text-muted-foreground/70">
          POST /hooks/payment-alert · #run-a3f2
        </p>
        <p className="mt-0.5 text-[10px] text-muted-foreground">
          {t("landing.selfHeal.detectMeta")} · 39ms
        </p>
      </div>

      <div className="min-h-0 flex-1 divide-y divide-border/40">
        {steps.map((step) => (
          <div
            key={step.id}
            className="flex items-center gap-2 py-2 first:pt-0 last:pb-0"
          >
            <span
              className={cn(
                "size-1.5 shrink-0 rounded-full",
                step.status === "failed" ? "bg-rose-500" : "bg-emerald-500",
              )}
            />
            <span className="text-xs font-medium">{step.id.replace(/_/g, " ")}</span>
            <span className="font-mono text-[10px] text-muted-foreground/60">
              {step.id}
            </span>
            {step.status === "failed" ? (
              <span className="ml-auto font-mono text-[10px] text-rose-600 dark:text-rose-400">
                {t("status.failed")} · {step.ms}ms
              </span>
            ) : (
              <span className="ml-auto font-mono text-[10px] text-muted-foreground/50">
                {step.ms}ms
              </span>
            )}
          </div>
        ))}
      </div>

      <div className="space-y-1">
        <div className="border-l-2 border-rose-500/50 pl-2.5 font-mono text-[10px] leading-relaxed text-rose-600 dark:text-rose-400">
          {t("landing.selfHeal.detectError")}
        </div>
        <p className="pl-2.5 font-mono text-[10px] text-muted-foreground/70">
          input.message: undefined
        </p>
      </div>
    </div>
  );
}

function DiagnoseStage() {
  const { t } = useTranslation();
  return (
    <div className="flex h-full flex-col">
      <div className="mb-2 flex items-start gap-1.5 rounded-lg border border-amber-500/30 bg-amber-500/5 px-2.5 py-1.5">
        <Stethoscope className="mt-px size-3 shrink-0 text-amber-500" />
        <span className="text-[11px] leading-relaxed text-foreground/90">
          {t("landing.selfHeal.diagnosis")}
        </span>
      </div>
      <div className="flex min-h-0 flex-1 flex-col justify-center">
        <div className="rounded-xl border border-tone-amber/30 bg-tone-amber/5 px-2 py-1.5">
          <div className="flex items-center gap-1.5">
            <span className="flex items-center justify-center rounded-md bg-tone-amber/15 p-1 text-tone-amber-fg">
              <Zap className="h-3 w-3" />
            </span>
            <span className="text-[11px] font-medium text-tone-amber-fg">
              {t("trigger.title")}
            </span>
            <span className="ml-auto rounded bg-tone-amber/12 px-1 py-px font-mono text-[9px] text-tone-amber-fg">
              payload
            </span>
          </div>
        </div>

        {STEPS.map((s) => (
          <div key={s.id} className="flex flex-col items-stretch">
            <span
              className={cn(
                "mx-auto h-2.5 w-px",
                s.modified ? "bg-rose-500/60" : "bg-border",
              )}
            />
            <div
              className={cn(
                "rounded-xl border bg-card p-2",
                s.modified
                  ? "border-amber-500/40 ring-1 ring-amber-500/70"
                  : "border-border/60",
              )}
            >
              <div className="flex items-center gap-1.5">
                <span
                  className={cn(
                    "flex items-center justify-center rounded-md p-1",
                    s.pure
                      ? "bg-tone-emerald/15 text-tone-emerald-fg"
                      : "bg-tone-blue/15 text-tone-blue-fg",
                  )}
                >
                  {s.pure ? (
                    <ArrowLeftRight className="h-3 w-3" />
                  ) : (
                    <Zap className="h-3 w-3" />
                  )}
                </span>
                <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-muted px-0.5 text-[10px] font-medium text-muted-foreground">
                  {s.num}
                </span>
                <span className="truncate text-xs font-medium">{s.title}</span>
                <div className="ml-auto flex items-center gap-1.5">
                  {s.provider && (
                    <span className="font-mono text-[10px] text-muted-foreground">
                      {s.provider}
                    </span>
                  )}
                  {s.modified && (
                    <span className="inline-flex items-center rounded-full bg-rose-500/15 px-1 py-px text-[9px] font-medium text-rose-600 dark:text-rose-400">
                      <AlertTriangle className="size-2" />
                    </span>
                  )}
                </div>
              </div>
              <div className="mt-1.5 flex items-center gap-1.5 border-t border-border/60 pt-1.5 font-mono text-[10px]">
                <span className="w-5 shrink-0 text-muted-foreground/60">in</span>
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

function FixLineSign({ kind }: { kind: FixLineKind }) {
  if (kind === "removed") {
    return <span className="w-4 shrink-0 text-rose-500">−</span>;
  }
  if (kind === "added") {
    return <span className="w-4 shrink-0 text-emerald-500">+</span>;
  }
  return <span className="w-4 shrink-0 text-amber-500">~</span>;
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
  const changeCount = FIX_CHANGES.reduce((n, b) => n + b.lines.length, 0);
  const nodeCount = new Set(FIX_CHANGES.map((b) => b.nodeId)).size;

  return (
    <div className="flex h-full flex-col gap-4">
      <div>
        <div className="flex items-center gap-1.5">
          <Wrench className="size-3.5 shrink-0 text-emerald-500" />
          <span className="text-xs font-medium">{t("heal.fixTitle")}</span>
          <span className="ml-auto text-[10px] text-emerald-600 dark:text-emerald-400">
            {t("heal.confidence.high")}
          </span>
        </div>
        <p className="mt-0.5 font-mono text-[10px] text-muted-foreground">
          {nodeCount} nodes · {changeCount} {t("heal.changes").toLowerCase()}
        </p>
      </div>

      <div className="min-h-0 flex-1 space-y-3 overflow-auto font-mono text-[10px]">
        {FIX_CHANGES.map((block) => (
          <div key={`${block.nodeId}-${block.category}`}>
            <div className="flex items-center gap-2 text-[10px]">
              <span className="font-medium text-foreground/90">{block.nodeId}</span>
              <span className="rounded bg-muted px-1.5 py-px text-[9px] text-muted-foreground">
                {t(`review.cat.${block.category}`)}
              </span>
            </div>
            <div className="mt-1 space-y-0.5">
              {block.lines.map((line, i) => (
                <div key={i} className="flex items-start gap-2 py-0.5">
                  <FixLineSign kind={line.kind} />
                  <span
                    className={cn(
                      line.kind === "removed" && "text-tone-rose-fg",
                      line.kind === "added" &&
                        "text-emerald-600 dark:text-emerald-400",
                      line.kind === "modified" &&
                        "text-amber-600 dark:text-amber-400",
                    )}
                  >
                    {line.text}
                  </span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>

      <div className="mt-auto space-y-3 border-t border-border/40 pt-4">
        <div className="flex items-center gap-1.5 text-[10px] font-medium text-foreground/80">
          <ShieldAlert className="size-3 shrink-0 text-amber-500" />
          {t("landing.selfHeal.controlBanner")}
        </div>

        <div>
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
          <div className="mt-2 flex items-center gap-1.5 text-[10px] text-amber-600 dark:text-amber-400">
            <Lock className="size-3 shrink-0" /> {t("heal.reason.kill-switch")}
          </div>
        )}
        </div>
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

  const { rootRef, onPointerDown } = useShowcaseSpacePause(setAutoPlay);

  return (
    <div
      ref={rootRef}
      tabIndex={0}
      onPointerDown={onPointerDown}
      className="grid w-full grid-cols-1 overflow-hidden rounded-2xl border border-border/50 bg-card shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-primary/30 lg:grid-cols-[2fr_1fr] lg:grid-rows-[auto_1fr]"
    >
      {/* Left header — shares row with right header on lg for equal height */}
      <div className="border-b border-border/40 bg-muted/20 px-3 py-3 lg:col-start-1 lg:row-start-1 lg:border-r">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <div className="flex flex-col gap-1.5 sm:flex-1 sm:flex-row sm:gap-2">
            {STAGES.map((st, i) => {
              const Icon = st.icon;
              const active = i === stage;
              const done = i < stage;
              return (
                <button
                  key={st.id}
                  type="button"
                  onClick={() => goStage(i)}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-lg border px-2.5 py-1.5 text-left transition-colors sm:flex-1",
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
                  <span className="flex min-w-0 flex-1 items-center gap-1.5">
                    <Icon className="size-3.5 shrink-0" />
                    <span className="truncate text-xs font-medium">
                      {t(`landing.selfHeal.${st.id}`)}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
          <button
            type="button"
            onClick={() => setAutoPlay((v) => !v)}
            className="relative inline-flex h-7 w-7 shrink-0 self-end items-center justify-center rounded-full border border-border/60 bg-background text-muted-foreground transition-colors hover:text-foreground sm:self-auto"
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
      </div>
       

      {/* Left body */}
      <div className="flex h-108 flex-col border-b border-border/40 lg:col-start-1 lg:row-start-2 lg:border-b-0 lg:border-r">
        <div
          key={STAGES[stage].id}
          className="flex min-h-0 flex-1 gap-7 flex-col p-4 animate-in fade-in slide-in-from-bottom-2 duration-500"
        > 
        <p className=" text-[11px] text-muted-foreground">
          {t(`landing.selfHeal.${STAGES[stage].id}Desc`)}
        </p>
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

      {/* Right header — stretches to match left header height on lg */}
      <div className="flex items-center gap-2 border-b border-border/40 bg-muted/20 px-4 py-3 lg:col-start-2 lg:row-start-1">
        <Sparkles className="size-4 text-emerald-500" />
        <span className="text-sm font-semibold">
          {t("landing.selfHeal.controlTitle")}
        </span>
      </div>

      {/* Right body */}
      <div className="flex flex-col gap-3 p-4 lg:col-start-2 lg:row-start-2">
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
