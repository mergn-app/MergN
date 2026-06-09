import { useState } from "react";
import { useTranslation } from "react-i18next";
import { createPortal } from "react-dom";
import type { ActivationState } from "./queries";
import {
  Bell,
  Check,
  Clock,
  Copy,
  Play,
  RefreshCw,
  Webhook,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type {
  TriggerConfig,
  TriggerKind,
  IntervalUnit,
  ScheduleTriggerConfig,
  PollTriggerConfig,
} from "./types";
import { getSpace } from "./space";

const KINDS: {
  kind: TriggerKind;
  icon: typeof Play;
  soon?: boolean;
}[] = [
  { kind: "manual", icon: Play },
  { kind: "webhook", icon: Webhook },
  { kind: "schedule", icon: Clock },
  { kind: "poll", icon: RefreshCw },
  { kind: "event", icon: Bell, soon: true },
];

const UNITS: IntervalUnit[] = ["second", "minute", "hour", "day"];

const inputClass =
  "w-full rounded-lg border border-border/60 bg-background-subtle px-2.5 py-1.5 text-[12px] text-foreground/90 outline-none focus:border-border";

function withDefaults(kind: TriggerKind, current: TriggerConfig): TriggerConfig {
  if (kind === "schedule") {
    return {
      kind,
      enabled: current.enabled ?? true,
      schedule:
        current.schedule ?? { mode: "interval", intervalValue: 5, intervalUnit: "minute" },
    };
  }
  if (kind === "poll") {
    return {
      kind,
      enabled: current.enabled ?? true,
      poll:
        current.poll ?? { provider: "", intervalValue: 5, intervalUnit: "minute", params: {} },
    };
  }
  return { kind };
}

function CopyChip({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        navigator.clipboard?.writeText(value);
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      }}
      className="flex w-full items-center gap-2 rounded-lg border border-border/60 bg-background-subtle px-2.5 py-1.5 text-left font-mono text-[11px] text-foreground/80 transition-colors hover:border-border"
    >
      <span className="min-w-0 flex-1 truncate">{value}</span>
      {copied ? (
        <Check className="h-3.5 w-3.5 shrink-0 text-emerald-400" />
      ) : (
        <Copy className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      )}
    </button>
  );
}

function EnabledToggle({
  enabled,
  onToggle,
  busy,
}: {
  enabled: boolean;
  onToggle: (v: boolean) => void;
  busy?: boolean;
}) {
  return (
    <button
      type="button"
      disabled={busy}
      onClick={() => onToggle(!enabled)}
      className={cn(
        "flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-[12px] transition-colors disabled:opacity-50",
        enabled
          ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
          : "border-border/60 bg-background-subtle text-muted-foreground",
      )}
    >
      <span
        className={cn(
          "size-2 rounded-full",
          enabled ? "bg-emerald-400" : "bg-muted-foreground/50",
        )}
      />
      {enabled ? "Active" : "Paused"}
    </button>
  );
}

function IntervalFields({
  value,
  unit,
  onValue,
  onUnit,
}: {
  value: number;
  unit: IntervalUnit;
  onValue: (v: number) => void;
  onUnit: (u: IntervalUnit) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-[11px] text-muted-foreground">Every</span>
      <input
        type="number"
        min={1}
        value={value}
        onChange={(e) => onValue(Math.max(1, Number(e.target.value) || 1))}
        className={cn(inputClass, "w-20")}
      />
      <select
        value={unit}
        onChange={(e) => onUnit(e.target.value as IntervalUnit)}
        className={cn(inputClass, "w-28")}
      >
        {UNITS.map((u) => (
          <option key={u} value={u}>
            {u}
          </option>
        ))}
      </select>
    </div>
  );
}

function ScheduleConfig({
  config,
  onChange,
}: {
  config: ScheduleTriggerConfig;
  onChange: (patch: Partial<ScheduleTriggerConfig>) => void;
}) {
  return (
    <div className="space-y-2.5">
      <div className="flex gap-1.5">
        {(["interval", "cron"] as const).map((mode) => (
          <button
            key={mode}
            type="button"
            onClick={() => onChange({ mode })}
            className={cn(
              "rounded-lg border px-2.5 py-1 text-[12px] transition-colors",
              config.mode === mode
                ? "border-amber-500/40 bg-amber-500/10 text-amber-300"
                : "border-border/60 text-muted-foreground hover:border-border",
            )}
          >
            {mode === "interval" ? "Interval" : "Cron"}
          </button>
        ))}
      </div>

      {config.mode === "interval" ? (
        <IntervalFields
          value={config.intervalValue ?? 5}
          unit={config.intervalUnit ?? "minute"}
          onValue={(intervalValue) => onChange({ intervalValue })}
          onUnit={(intervalUnit) => onChange({ intervalUnit })}
        />
      ) : (
        <div className="space-y-1.5">
          <input
            value={config.cron ?? ""}
            placeholder="*/5 * * * *"
            onChange={(e) => onChange({ cron: e.target.value })}
            className={cn(inputClass, "font-mono")}
          />
          <input
            value={config.timezone ?? ""}
            placeholder="UTC"
            onChange={(e) => onChange({ timezone: e.target.value })}
            className={inputClass}
          />
        </div>
      )}
    </div>
  );
}

function PollConfig({
  config,
  onChange,
  onParam,
}: {
  config: PollTriggerConfig;
  onChange: (patch: Partial<PollTriggerConfig>) => void;
  onParam: (key: string, value: string) => void;
}) {
  const params = config.params ?? {};
  if (!config.source) {
    return (
      <p className="text-xs leading-relaxed text-amber-300/90">
        Ask the assistant to set up polling (e.g. "poll Discord for new messages").
      </p>
    );
  }
  return (
    <div className="space-y-2.5">
      <div className="flex items-center gap-2 text-[12px] text-muted-foreground">
        <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-foreground/80">
          {config.provider}
        </span>
        <span>poller</span>
      </div>

      <IntervalFields
        value={config.intervalValue}
        unit={config.intervalUnit}
        onValue={(intervalValue) => onChange({ intervalValue })}
        onUnit={(intervalUnit) => onChange({ intervalUnit })}
      />

      {(config.paramNames ?? []).map((name) => (
        <input
          key={name}
          value={String(params[name] ?? "")}
          placeholder={name}
          onChange={(e) => onParam(name, e.target.value)}
          className={inputClass}
        />
      ))}
    </div>
  );
}

export function TriggerDialog({
  trigger,
  onChange,
  workflowId,
  dirty,
  activation,
  busy,
  onToggleActivation,
  onClose,
}: {
  trigger: TriggerConfig;
  onChange: (t: TriggerConfig) => void;
  workflowId: string | null;
  dirty: boolean;
  activation: ActivationState | "loading";
  busy: boolean;
  onToggleActivation: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const webhookUrl = workflowId
    ? `${window.location.origin}/api/hooks/${getSpace()}/${workflowId}`
    : null;

  const schedule =
    trigger.schedule ?? { mode: "interval", intervalValue: 5, intervalUnit: "minute" };
  const poll =
    trigger.poll ?? { provider: "http", intervalValue: 5, intervalUnit: "minute", params: {} };

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-2xl border bg-card p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center gap-2">
          <span className="text-sm font-semibold">{t("trigger.title")}</span>
          <span className="text-xs text-muted-foreground">
            {t("trigger.subtitle")}
          </span>
          <button
            onClick={onClose}
            className="ml-auto text-muted-foreground hover:text-foreground"
          >
            ✕
          </button>
        </div>

        <div className="space-y-1.5">
          {KINDS.map((k) => {
            const active = trigger.kind === k.kind;
            const Icon = k.icon;
            return (
              <button
                key={k.kind}
                disabled={k.soon}
                onClick={() => onChange(withDefaults(k.kind, trigger))}
                className={cn(
                  "flex w-full items-center gap-3 rounded-xl border px-3 py-2.5 text-left transition-colors",
                  active
                    ? "border-amber-500/40 bg-amber-500/5"
                    : "border-border/50 hover:border-border hover:bg-secondary",
                  k.soon && "cursor-not-allowed opacity-50 hover:bg-transparent",
                )}
              >
                <span
                  className={cn(
                    "flex size-8 shrink-0 items-center justify-center rounded-lg",
                    active
                      ? "bg-amber-500/15 text-amber-400"
                      : "bg-muted text-muted-foreground",
                  )}
                >
                  <Icon className="h-4 w-4" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5 text-[13px] font-medium">
                    {t(`trigger.kind.${k.kind}`)}
                    {k.soon && (
                      <span className="rounded bg-muted px-1 py-0.5 text-[9px] uppercase tracking-wide text-muted-foreground/70">
                        {t("common.soon")}
                      </span>
                    )}
                  </span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {t(`trigger.desc.${k.kind}`)}
                  </span>
                </span>
                {active && <Check className="h-4 w-4 shrink-0 text-amber-400" />}
              </button>
            );
          })}
        </div>

        {trigger.kind === "webhook" && (
          <div className="mt-4 space-y-2 border-t border-border/50 pt-4">
            <div className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/70">
              {t("trigger.endpoint")}
            </div>
            {webhookUrl ? (
              <>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  {t("trigger.webhookInfo")}
                </p>
                <CopyChip value={webhookUrl} />
                <CopyChip value={`curl -X POST ${webhookUrl} -d '{}'`} />
              </>
            ) : (
              <p className="text-xs leading-relaxed text-amber-300/90">
                {t("trigger.saveFirst")}
              </p>
            )}
          </div>
        )}

        {(trigger.kind === "schedule" || trigger.kind === "poll") && (
          <div className="mt-4 space-y-3 border-t border-border/50 pt-4">
            <div className="flex items-center justify-between">
              <div className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/70">
                {trigger.kind === "schedule" ? "Schedule" : "Polling"}
              </div>
              {activation === "loading" ? (
                <span className="text-[11px] text-muted-foreground">…</span>
              ) : activation === "none" ? (
                <span className="text-[11px] text-amber-300/90">Save to activate</span>
              ) : (
                <EnabledToggle
                  enabled={activation === "active"}
                  onToggle={onToggleActivation}
                  busy={busy}
                />
              )}
            </div>

            {trigger.kind === "schedule" ? (
              <ScheduleConfig
                config={schedule}
                onChange={(patch) =>
                  onChange({ ...trigger, schedule: { ...schedule, ...patch } })
                }
              />
            ) : (
              <PollConfig
                config={poll}
                onChange={(patch) =>
                  onChange({ ...trigger, poll: { ...poll, ...patch } })
                }
                onParam={(key, value) =>
                  onChange({
                    ...trigger,
                    poll: { ...poll, params: { ...(poll.params ?? {}), [key]: value } },
                  })
                }
              />
            )}
          </div>
        )}

        {dirty && trigger.kind !== "manual" && (
          <div className="mt-4 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
            {t("trigger.applyHint")}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
