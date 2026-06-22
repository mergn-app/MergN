import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Settings, ShieldAlert, Sparkles, Lock, Bell, Trash2, Plus, Send, Workflow } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  useFlowSettings,
  useUpdateFlowSettings,
  useEligibility,
  useKillSwitch,
  useToggleKillSwitch,
  useAuditLog,
  useMonitorHandlers,
  useAlertChannels,
  useAddAlertChannel,
  usePatchAlertChannel,
  useRemoveAlertChannel,
  useTestAlert,
  useAlertHandlers,
  useAddAlertHandler,
  usePatchAlertHandler,
  useRemoveAlertHandler,
  type FixMode,
  type ChannelKind,
} from "./queries";

const overlay = "fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4";
const sheet = "flex max-h-[85vh] w-full max-w-md flex-col overflow-hidden rounded-2xl border border-border/50 bg-card";
const card = "rounded-xl border border-border/40 bg-background-subtle/30 p-3";

// per-channel credential fields (matches the server's ChannelSecret shapes)
const CHANNEL_FIELDS: Record<ChannelKind, { name: string; label: string; placeholder: string }[]> = {
  telegram: [
    { name: "botToken", label: "Bot token", placeholder: "123456:ABC-..." },
    { name: "chatId", label: "Chat ID", placeholder: "-1001234567890" },
  ],
  slack: [{ name: "webhookUrl", label: "Incoming webhook URL", placeholder: "https://hooks.slack.com/services/..." }],
  discord: [
    { name: "botToken", label: "Bot token", placeholder: "MTA..." },
    { name: "channelId", label: "Channel ID", placeholder: "1122334455" },
  ],
  email: [{ name: "to", label: "E-posta", placeholder: "ops@example.com" }],
  webhook: [{ name: "url", label: "POST URL", placeholder: "https://example.com/hook" }],
};
const KIND_LABEL: Record<ChannelKind, string> = { telegram: "Telegram", slack: "Slack", discord: "Discord", email: "E-posta", webhook: "Webhook" };
const KINDS = Object.keys(CHANNEL_FIELDS) as ChannelKind[];

// ── reusable controls (match the existing alerts toggle / tab styling) ──
function Switch({ on, onChange, disabled, tone = "emerald" }: {
  on: boolean; onChange: (v: boolean) => void; disabled?: boolean; tone?: "emerald" | "rose";
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => onChange(!on)}
      className={cn(
        "flex h-5 w-9 shrink-0 items-center rounded-full p-0.5 transition-colors disabled:opacity-40",
        on ? (tone === "rose" ? "bg-rose-500/80" : "bg-emerald-500/80") : "bg-muted-foreground/30",
      )}
    >
      <span className={cn("size-4 rounded-full bg-background shadow-sm ring-1 ring-black/5 transition-transform", on && "translate-x-4")} />
    </button>
  );
}

function Row({ title, hint, children, disabled }: { title: string; hint?: string; children: ReactNode; disabled?: boolean }) {
  return (
    <div className={cn("flex items-start justify-between gap-3 py-2", disabled && "opacity-50")}>
      <div className="min-w-0">
        <div className="text-sm font-medium">{title}</div>
        {hint && <div className="mt-0.5 text-xs text-muted-foreground">{hint}</div>}
      </div>
      <div className="shrink-0 pt-0.5">{children}</div>
    </div>
  );
}

function Segmented<T extends string>({ value, options, onChange, disabled }: {
  value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; disabled?: boolean;
}) {
  return (
    <div className={cn("inline-flex rounded-lg bg-muted p-0.5", disabled && "pointer-events-none opacity-50")}>
      {options.map((o) => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          className={cn(
            "rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
            value === o.value ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Header({ icon, title, onClose }: { icon: ReactNode; title: string; onClose: () => void }) {
  const { t } = useTranslation();
  return (
    <header className="flex items-center gap-2 border-b border-border/40 px-4 py-3">
      {icon}
      <span className="flex-1 text-sm font-medium">{title}</span>
      <button onClick={onClose} className="rounded-lg px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground">
        {t("settings.close")}
      </button>
    </header>
  );
}

// ── Per-flow settings (the ⚙ gear) ──
export function FlowSettingsModal({ workflowId, onClose }: { workflowId: string; onClose: () => void }) {
  const { t } = useTranslation();
  const s = useFlowSettings(workflowId).data ?? { enabled: false, fixMode: "propose" as FixMode, autoReplay: false };
  const elig = useEligibility(workflowId).data;
  const update = useUpdateFlowSettings(workflowId);

  const gated = !!elig && !elig.canHeal;
  const gateText =
    elig?.reason === "kill-switch" ? t("settings.gatedKill") : elig?.reason === "disabled" ? t("settings.gatedDisabled") : t("settings.gatedPlan");
  const set = (patch: Partial<{ enabled: boolean; fixMode: FixMode; autoReplay: boolean }>) => update.mutate(patch);

  return (
    <div className={overlay} onClick={onClose}>
      <div className={sheet} onClick={(e) => e.stopPropagation()}>
        <Header icon={<Settings className="size-4 text-muted-foreground" />} title={t("settings.title")} onClose={onClose} />
        <div className="min-h-0 flex-1 space-y-3 overflow-auto p-4">
          {/* Self-healing */}
          <section className={card}>
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-start gap-2">
                <Sparkles className="mt-0.5 size-4 text-emerald-500" />
                <div>
                  <div className="text-sm font-medium">{t("settings.heal")}</div>
                  <div className="mt-0.5 text-xs text-muted-foreground">{t("settings.healHint")}</div>
                </div>
              </div>
              <Switch on={s.enabled} disabled={gated || update.isPending} onChange={(v) => set({ enabled: v })} />
            </div>

            {gated && (
              <div className="mt-2 flex items-center gap-1.5 rounded-lg bg-amber-500/10 px-2.5 py-1.5 text-[11px] text-amber-600 dark:text-amber-400">
                <Lock className="size-3" /> {gateText}
              </div>
            )}

            <div className="mt-1 border-t border-border/40 pt-1">
              <Row title={t("settings.mode")} hint={t("settings.modeHint")} disabled={!s.enabled || gated}>
                <Segmented<FixMode>
                  value={s.fixMode}
                  disabled={!s.enabled || gated || update.isPending}
                  onChange={(v) => set({ fixMode: v })}
                  options={[
                    { value: "notify", label: t("settings.modeNotify") },
                    { value: "propose", label: t("settings.modePropose") },
                    { value: "auto", label: t("settings.modeAuto") },
                  ]}
                />
              </Row>
              <Row title={t("settings.autoReplay")} hint={t("settings.autoReplayHint")} disabled={!s.enabled || gated}>
                <Switch on={s.autoReplay} disabled={!s.enabled || gated || update.isPending} onChange={(v) => set({ autoReplay: v })} />
              </Row>
            </div>
          </section>

          {/* Alerts — ADD only (channels + handler flows). The lists live on the
              monitoring page's bell card. */}
          <AlertConfigSection />
        </div>
      </div>
    </div>
  );
}

// ── Alert config: add a channel + add a handler flow (lists are on monitoring) ──
function AlertConfigSection() {
  const { t } = useTranslation();
  const flows = useMonitorHandlers().data ?? []; // only "monitor"-trigger flows are eligible
  const handlers = useAlertHandlers().data ?? [];
  const addChannel = useAddAlertChannel();
  const addHandler = useAddAlertHandler();

  const [kind, setKind] = useState<ChannelKind>("slack");
  const [label, setLabel] = useState("");
  const [secret, setSecret] = useState<Record<string, string>>({});
  const fields = CHANNEL_FIELDS[kind];
  const ready = fields.every((f) => (secret[f.name] ?? "").trim());

  const handlerIds = new Set(handlers.map((h) => h.workflowId));
  const candidates = flows.filter((f) => !handlerIds.has(f.id));
  const [pick, setPick] = useState("");

  return (
    <>
      {/* add a channel */}
      <section className={card}>
        <div className="mb-2 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/70">
          <Bell className="size-3" /> {t("alert.addChannel")}
        </div>
        <div className="flex flex-wrap gap-1">
          {KINDS.map((k) => (
            <button
              key={k}
              onClick={() => { setKind(k); setSecret({}); }}
              className={cn("rounded-lg px-2.5 py-1 text-xs font-medium transition-colors", kind === k ? "bg-background text-foreground shadow-sm ring-1 ring-border/60" : "bg-muted text-muted-foreground hover:text-foreground")}
            >
              {KIND_LABEL[k]}
            </button>
          ))}
        </div>
        <div className="mt-2 space-y-1.5">
          {fields.map((f) => (
            <input
              key={f.name}
              value={secret[f.name] ?? ""}
              onChange={(e) => setSecret((s) => ({ ...s, [f.name]: e.target.value }))}
              placeholder={`${f.label} — ${f.placeholder}`}
              className="w-full rounded-lg border border-border/50 bg-background px-2.5 py-1.5 text-xs outline-none focus:border-border"
            />
          ))}
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder={t("alert.label")}
            className="w-full rounded-lg border border-border/50 bg-background px-2.5 py-1.5 text-xs outline-none focus:border-border"
          />
          <button
            onClick={() => ready && addChannel.mutate({ kind, label: label.trim() || undefined, secret }, { onSuccess: () => { setLabel(""); setSecret({}); } })}
            disabled={!ready || addChannel.isPending}
            className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-40"
          >
            <Plus className="size-3.5" /> {t("alert.add")}
          </button>
        </div>
      </section>

      {/* add a handler flow (dropdown) */}
      <section className={card}>
        <div className="mb-2 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/70">
          <Workflow className="size-3" /> {t("alert.addHandler")}
        </div>
        <div className="flex gap-1.5">
          <select
            value={pick}
            onChange={(e) => setPick(e.target.value)}
            className="min-w-0 flex-1 rounded-lg border border-border/50 bg-background px-2.5 py-1.5 text-xs outline-none focus:border-border"
          >
            <option value="">{t("alert.pickFlow")}</option>
            {candidates.map((f) => (
              <option key={f.id} value={f.id}>{f.name}</option>
            ))}
          </select>
          <button
            onClick={() => pick && addHandler.mutate(pick, { onSuccess: () => setPick("") })}
            disabled={!pick || addHandler.isPending}
            className="flex shrink-0 items-center gap-1 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-40"
          >
            <Plus className="size-3.5" /> {t("alert.add")}
          </button>
        </div>
        <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground/70">{t("alert.handlersHint")}</p>
      </section>
    </>
  );
}

// ── Lists (shown on the monitoring bell card): channels + handler flows, each
// with its own enable/disable toggle + remove. ──
export function ChannelList() {
  const { t } = useTranslation();
  const channels = useAlertChannels().data ?? [];
  const patch = usePatchAlertChannel();
  const remove = useRemoveAlertChannel();
  const test = useTestAlert();
  return (
    <div>
      <div className="mb-1 flex items-center justify-between">
        <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/70">{t("alert.channels")}</span>
        {channels.length > 0 && (
          <button onClick={() => test.mutate()} disabled={test.isPending} className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50">
            <Send className="size-2.5" /> {test.isSuccess ? t("alert.tested") : t("alert.test")}
          </button>
        )}
      </div>
      {channels.length === 0 ? (
        <div className="py-2 text-center text-[11px] text-muted-foreground/60">{t("alert.noChannels")}</div>
      ) : (
        <ul className="max-h-28 space-y-1 overflow-auto pr-0.5">
          {channels.map((ch) => (
            <li key={ch.id} className="flex items-center gap-2 rounded-lg border border-border/40 bg-background-subtle/30 px-2 py-1.5">
              <span className="rounded-full bg-muted px-1.5 py-0.5 text-[9px] font-medium text-muted-foreground">{KIND_LABEL[ch.kind]}</span>
              <span className="min-w-0 flex-1 truncate text-[11px]">{ch.label || KIND_LABEL[ch.kind]}</span>
              <Switch on={ch.enabled} disabled={patch.isPending} onChange={(v) => patch.mutate({ id: ch.id, enabled: v })} />
              <button onClick={() => remove.mutate(ch.id)} className="grid size-5 place-items-center rounded text-muted-foreground/50 hover:bg-rose-500/10 hover:text-rose-500">
                <Trash2 className="size-3" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function HandlerList() {
  const { t } = useTranslation();
  const handlers = useAlertHandlers().data ?? [];
  const patch = usePatchAlertHandler();
  const remove = useRemoveAlertHandler();
  return (
    <div>
      <div className="mb-1 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/70">
        <Workflow className="size-2.5" /> {t("alert.handlers")}
      </div>
      {handlers.length === 0 ? (
        <div className="py-2 text-center text-[11px] text-muted-foreground/60">{t("alert.noHandlers")}</div>
      ) : (
        <ul className="max-h-28 space-y-1 overflow-auto pr-0.5">
          {handlers.map((h) => (
            <li key={h.workflowId} className="flex items-center gap-2 rounded-lg border border-border/40 bg-background-subtle/30 px-2 py-1.5">
              <Workflow className="size-3 shrink-0 text-violet-500" />
              <span className="min-w-0 flex-1 truncate text-[11px]">{h.name}</span>
              <Switch on={h.enabled} disabled={patch.isPending} onChange={(v) => patch.mutate({ workflowId: h.workflowId, enabled: v })} />
              <button onClick={() => remove.mutate(h.workflowId)} className="grid size-5 place-items-center rounded text-muted-foreground/50 hover:bg-rose-500/10 hover:text-rose-500">
                <Trash2 className="size-3" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ── Governance (the 🛡 shield): global kill-switch + audit feed ──
const AUDIT_TONE: Record<string, string> = {
  "killswitch.toggled": "text-rose-500",
  "heal.applied": "text-emerald-500",
  "heal.rejected": "text-muted-foreground",
  "settings.changed": "text-sky-500",
};

export function GovernanceModal({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const kill = useKillSwitch().data?.on ?? false;
  const toggle = useToggleKillSwitch();
  const audit = useAuditLog().data ?? [];

  return (
    <div className={overlay} onClick={onClose}>
      <div className={sheet} onClick={(e) => e.stopPropagation()}>
        <Header icon={<ShieldAlert className="size-4 text-muted-foreground" />} title={t("governance.title")} onClose={onClose} />
        <div className="min-h-0 flex-1 space-y-3 overflow-auto p-4">
          {/* Global kill-switch (danger-toned when ON) */}
          <section className={cn("rounded-xl border p-3", kill ? "border-rose-500/40 bg-rose-500/5" : "border-border/40 bg-background-subtle/30")}>
            <Row title={t("governance.kill")} hint={t("governance.killHint")}>
              <Switch on={kill} tone="rose" disabled={toggle.isPending} onChange={(v) => toggle.mutate(v)} />
            </Row>
          </section>

          {/* Audit trail */}
          <section className={card}>
            <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/70">{t("governance.audit")}</div>
            {audit.length === 0 ? (
              <div className="py-4 text-center text-xs text-muted-foreground/70">{t("governance.auditEmpty")}</div>
            ) : (
              <ul className="space-y-1.5">
                {audit.map((a) => (
                  <li key={a.id} className="flex items-start gap-2 text-xs">
                    <span className={cn("mt-1 size-1.5 shrink-0 rounded-full bg-current", AUDIT_TONE[a.kind] ?? "text-muted-foreground")} />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-foreground/90">{a.message}</div>
                      <div className="text-[10px] text-muted-foreground/60">
                        {new Date(a.ts).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                        {a.actor ? ` · ${a.actor}` : ""}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

