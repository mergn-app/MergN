import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import {
  ArrowLeft,
  Settings,
  ShieldAlert,
  History,
  Bell,
  AlertCircle,
  AlertTriangle,
  Info,
  X,
  Stethoscope,
  Workflow as WorkflowIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  useWorkflows,
  useHealth,
  useHealthSummary,
  useRuns,
  useLogs,
  useHealEvents,
  useWorkflowVersions,
  useAlertsEnabled,
  useToggleAlerts,
  fetchRun,
  type HealthState,
  type RunMeta,
  type RunDoc,
  type LogEntry,
} from "./queries";
import { healthColor } from "./status-palette";
import { ChangeReview, type ChangeSource } from "./ChangeReview";
import { VersionRow, FixRow } from "./VersionRow";
import { FlowSettingsModal, GovernanceModal, ChannelList, HandlerList } from "./SettingsPanels";
import { MonitorGraphs } from "./monitor-graphs";
import { DoctorChat } from "./DoctorChat";

// run-status colors (distinct from health-status — never mix)
const RUN_DOT: Record<string, string> = {
  done: "bg-emerald-500",
  failed: "bg-rose-500",
  running: "bg-amber-500 animate-pulse",
  skipped: "bg-muted-foreground/40",
};
const LOG_ICON: Record<string, { Icon: typeof AlertCircle; cls: string }> = {
  error: { Icon: AlertCircle, cls: "text-rose-400" },
  warn: { Icon: AlertTriangle, cls: "text-amber-400" },
  info: { Icon: Info, cls: "text-sky-400" },
};

function rel(iso?: string): string {
  if (!iso) return "—";
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return "—";
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}
const durMs = (r: RunMeta): number | undefined =>
  r.finishedAt ? Date.parse(r.finishedAt) - Date.parse(r.startedAt) : undefined;

const panel = "rounded-2xl border border-border/40 bg-card";

// ── run-detail modal: clicking a run shows its steps (input/output/error) ─────
function RunDetailModal({ runId, onClose }: { runId: string; onClose: () => void }) {
  const { t } = useTranslation();
  const [run, setRun] = useState<RunDoc | null>(null);
  useEffect(() => {
    let live = true;
    fetchRun(runId).then((r) => live && setRun(r)).catch(() => live && setRun(null));
    return () => { live = false; };
  }, [runId]);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div className={cn(panel, "flex max-h-[80vh] w-full max-w-2xl flex-col overflow-hidden")} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 border-b border-border/40 px-4 py-2.5">
          <span className={cn("size-2 rounded-full", RUN_DOT[run?.status ?? ""] ?? "bg-muted-foreground")} />
          <span className="text-sm font-medium">{t("monitoring.runDetail")}</span>
          <span className="font-mono text-[10px] text-muted-foreground/60">{runId.slice(0, 8)}</span>
          <button onClick={onClose} className="ml-auto flex size-7 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground">
            <X className="size-4" />
          </button>
        </div>
        <div className="min-h-0 flex-1 space-y-2 overflow-auto p-4">
          {!run ? (
            <div className="py-6 text-center text-xs text-muted-foreground">{t("common.loading")}</div>
          ) : (
            run.records.filter((r) => r.nodeId !== "trigger").map((r, i) => (
              <div key={i} className="space-y-1 rounded-lg border border-border/40 bg-background-subtle/40 p-2.5">
                <div className="flex items-center gap-2 text-xs">
                  <span className={cn("size-2 rounded-full", RUN_DOT[r.status] ?? "bg-muted-foreground")} />
                  <span className="font-mono text-[11px]">{r.nodeId}</span>
                  <span className="ml-auto text-muted-foreground/70">{r.status}</span>
                </div>
                {r.error ? (
                  <pre className="overflow-auto rounded border border-rose-500/30 bg-rose-500/5 p-2 font-mono text-[10px] text-rose-600 dark:text-rose-400">{String(r.error)}</pre>
                ) : r.output !== undefined ? (
                  <pre className="overflow-auto rounded border border-border/40 bg-muted/30 p-2 font-mono text-[10px] text-foreground/80">{JSON.stringify(r.output, null, 2)?.slice(0, 1000)}</pre>
                ) : null}
              </div>
            ))
          )}
          {run && run.records.filter((r) => r.nodeId !== "trigger").length === 0 && (
            <div className="py-6 text-center text-xs text-muted-foreground">{run.records.find((r) => r.error)?.error ?? t("monitoring.noSteps")}</div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── log-detail modal: clicking a log shows its full message + detail ──────────
function LogDetailModal({ log, onClose }: { log: LogEntry; onClose: () => void }) {
  const { t } = useTranslation();
  const li = LOG_ICON[log.level] ?? LOG_ICON.info;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div className={cn(panel, "flex max-h-[80vh] w-full max-w-xl flex-col overflow-hidden")} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 border-b border-border/40 px-4 py-2.5">
          <li.Icon className={cn("size-4", li.cls)} />
          <span className="text-sm font-medium">{t("monitoring.logDetail")}</span>
          <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">{log.source}</span>
          <span className="ml-auto text-[11px] text-muted-foreground/70">{new Date(log.ts).toLocaleString()}</span>
          <button onClick={onClose} className="flex size-7 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground">
            <X className="size-4" />
          </button>
        </div>
        <div className="min-h-0 flex-1 space-y-3 overflow-auto p-4">
          <div className="text-sm font-medium text-foreground">{log.message}</div>
          {log.detail ? (
            <pre className="overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border/40 bg-muted/30 p-3 font-mono text-[11px] leading-relaxed text-foreground/80">{log.detail}</pre>
          ) : (
            <div className="text-xs text-muted-foreground">{t("monitoring.noLogDetail")}</div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── inline alert panel (left of the charts): on/off + settings entry ─────────
// The toggle is real (per-flow opt-in, default OFF). Channel/severity rules are
// not built yet — surfaced as "coming soon".
function AlertPanel({ workflowId }: { workflowId: string }) {
  const { t } = useTranslation();
  const enabled = useAlertsEnabled(workflowId).data ?? false;
  const toggle = useToggleAlerts(workflowId);
  return (
    <div className={cn(panel, "flex w-1/2 min-w-0 shrink-0 flex-col overflow-hidden")}>
      <div className="flex items-center gap-2 border-b border-border/40 px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/70">
        <Bell className="size-3.5" />
        {t("monitoring.alerts")}
        <span
          className={cn(
            "ml-auto rounded-full px-2 py-0.5 text-[9px] font-medium normal-case tracking-normal",
            enabled ? "bg-emerald-500/15 text-emerald-500" : "bg-amber-500/15 text-amber-600 dark:text-amber-400",
          )}
        >
          {enabled ? t("monitoring.alertsOn") : t("monitoring.alertsOff")}
        </span>
      </div>
      <div className="min-h-0 flex-1 space-y-3 overflow-auto p-3">
        {/* real toggle: external delivery for this flow (default OFF) */}
        <div className="flex items-start gap-3">
          <button
            type="button"
            disabled={toggle.isPending}
            onClick={() => toggle.mutate(!enabled)}
            className={cn(
              "mt-0.5 flex h-5 w-9 shrink-0 items-center rounded-full p-0.5 transition-colors disabled:opacity-50",
              enabled ? "bg-emerald-500/80" : "bg-muted-foreground/30",
            )}
          >
            <span className={cn("size-4 rounded-full bg-background shadow-sm ring-1 ring-black/5 transition-transform", enabled && "translate-x-4")} />
          </button>
          <div className="min-w-0">
            <div className="text-sm font-medium">{t("monitoring.alertsToggle")}</div>
            <div className="text-xs text-muted-foreground">{t("monitoring.alertsToggleHint")}</div>
          </div>
        </div>

        {/* channels + handler-flow lists (add new ones from ⚙ flow settings) */}
        <div className="space-y-3 border-t border-border/40 pt-3">
          <ChannelList />
          <HandlerList />
        </div>
      </div>
    </div>
  );
}

// ── left: flow list, most-recently-run first, health-colored ─────────────────
function FlowList({
  workflowId,
  onOpen,
}: {
  workflowId: string;
  onOpen: (id: string) => void;
}) {
  const { t } = useTranslation();
  const flows = useWorkflows().data ?? [];
  const summary = useHealthSummary().data ?? [];
  const byId = useMemo(
    () => new Map(summary.map((h) => [h.workflowId, h])),
    [summary],
  );
  const sorted = useMemo(() => {
    const ord = (id: string) => byId.get(id)?.lastRunAt ?? "";
    return [...flows].sort((a, b) => (ord(a.id) < ord(b.id) ? 1 : -1));
  }, [flows, byId]);

  return (
    <div className={cn(panel, "flex w-64 shrink-0 flex-col overflow-hidden")}>
      <div className="border-b border-border/40 px-3 py-2.5 text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground/70">
        {t("monitoring.flows")}
      </div>
      <div className="min-h-0 flex-1 space-y-0.5 overflow-auto p-1.5">
        {sorted.map((f) => {
          const h = byId.get(f.id);
          const c = healthColor(h?.status ?? "nodata");
          const active = f.id === workflowId;
          return (
            <button
              key={f.id}
              onClick={() => onOpen(f.id)}
              title={f.name}
              className={cn(
                "flex w-full items-center gap-2.5 rounded-xl px-2 py-2 text-left transition-colors hover:bg-background-subtle",
                active && "border border-border/60 bg-background-subtle",
              )}
            >
              <span className={cn("size-2 shrink-0 rounded-full", c.dot, c.pulse && "animate-pulse")} />
              <span className="min-w-0 flex-1 truncate text-sm">{f.name}</span>
              <span className="shrink-0 text-[10px] text-muted-foreground/60">{rel(h?.lastRunAt)}</span>
            </button>
          );
        })}
        {sorted.length === 0 && (
          <div className="px-2 py-6 text-center text-xs text-muted-foreground">
            {t("monitoring.noFlows")}
          </div>
        )}
      </div>
    </div>
  );
}

// ── center ───────────────────────────────────────────────────────────────────
// A SHORT, single-line reason for the header — never the raw stack trace (that
// lives in the logs / run-detail). lastError → just the errorType category.
function shortCause(t: (k: string) => string, h?: HealthState): { short?: string; full?: string } {
  if (h?.livenessFail)
    return { short: h.livenessFail.kind === "webhook" ? t("health.cause.webhookSilent") : t("health.cause.scheduleStopped") };
  if (h?.outcomeFail) {
    const d = h.outcomeFail.detail ?? "";
    return { short: d.length > 80 ? d.slice(0, 80) + "…" : d, full: d };
  }
  if (h?.lastError)
    return { short: h.lastError.type, full: `${h.lastError.type}: ${h.lastError.message}` };
  return {};
}

function HealthHeader({ health }: { health?: HealthState }) {
  const { t } = useTranslation();
  const c = healthColor(health?.status ?? "nodata");
  const { short, full } = shortCause(t, health);
  return (
    <div className="flex min-w-0 flex-1 items-center gap-2 text-sm">
      <span className={cn("size-2.5 shrink-0 rounded-full", c.dot, c.pulse && "animate-pulse")} />
      <span className={cn("shrink-0 font-medium", c.text)}>{t(c.labelKey)}</span>
      {short && (
        <span className="min-w-0 truncate text-muted-foreground" title={full ?? short}>
          — {short}
        </span>
      )}
    </div>
  );
}

// ── right: unified history — pending fixes (need review) + version timeline ───
// A fix IS a version, so both live in one list. Clicking any entry opens the same
// full-screen change-review surface.
function HistoryBody({ workflowId, onOpen }: { workflowId: string; onOpen: (s: ChangeSource) => void }) {
  const { t } = useTranslation();
  const pending = (useHealEvents(workflowId || null).data ?? []).filter((e) => e.status === "proposed");
  const versions = useWorkflowVersions(workflowId || null).data ?? [];
  const empty = pending.length === 0 && versions.length === 0;
  return (
    <div className="min-h-0 flex-1 space-y-1.5 overflow-auto p-2">
      {empty ? (
        <div className="flex h-full items-center justify-center p-4 text-center text-xs text-muted-foreground/70">
          {t("review.noHistory")}
        </div>
      ) : (
        <>
          {/* pending proposed fixes — need review, pinned to the top */}
          {pending.map((e) => (
            <FixRow key={e.id} e={e} time={rel(e.at)} onClick={() => onOpen({ kind: "fix", event: e })} />
          ))}
          {/* version timeline (newest-first) */}
          {versions.map((v) => (
            <VersionRow key={v.id} v={v} time={rel(v.createdAt)} onClick={() => onOpen({ kind: "version", version: v })} />
          ))}
        </>
      )}
    </div>
  );
}

// Right column: history timeline + the Doctor chat, tabbed. The Doctor reads,
// diagnoses and repairs this flow; its fix/version cards open the same review.
function RightColumn({ workflowId, onOpen }: { workflowId: string; onOpen: (s: ChangeSource) => void }) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<"doctor" | "history">("doctor");
  const tabCls = (active: boolean) =>
    cn(
      "flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-medium transition-colors",
      active ? "bg-secondary text-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground",
    );
  return (
    <div className={cn(panel, "flex w-[400px] shrink-0 flex-col overflow-hidden")}>
      <div className="flex items-center gap-1 border-b border-border/40 px-2 py-1.5">
        <button type="button" onClick={() => setTab("doctor")} className={tabCls(tab === "doctor")}>
          <Stethoscope className="size-3.5" />
          {t("doctor.tab")}
        </button>
        <button type="button" onClick={() => setTab("history")} className={tabCls(tab === "history")}>
          <History className="size-3.5" />
          {t("review.history")}
        </button>
      </div>
      {/* both stay mounted — switching tabs must NOT drop an in-flight Doctor chat */}
      <div className={cn("flex min-h-0 flex-1 flex-col", tab !== "doctor" && "hidden")}>
        <DoctorChat key={workflowId} workflowId={workflowId} onOpen={onOpen} />
      </div>
      <div className={cn("flex min-h-0 flex-1 flex-col", tab !== "history" && "hidden")}>
        <HistoryBody workflowId={workflowId} onOpen={onOpen} />
      </div>
    </div>
  );
}

export function MonitoringPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const params = useParams({ strict: false }) as { spaceId?: string; workflowId?: string };
  const spaceId = params.spaceId ?? "";
  const workflowId = params.workflowId ?? "";

  const flows = useWorkflows().data ?? [];
  const name = flows.find((f) => f.id === workflowId)?.name ?? workflowId;
  const health = useHealth(workflowId || null).data;
  const runs = useRuns(workflowId || null).data ?? [];
  const logs = (useLogs(true).data ?? []).filter((l) => l.workflowId === workflowId);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [governanceOpen, setGovernanceOpen] = useState(false);
  const [openRunId, setOpenRunId] = useState<string | null>(null);
  const [openLog, setOpenLog] = useState<LogEntry | null>(null);
  const [openSource, setOpenSource] = useState<ChangeSource | null>(null);

  const goFlow = (id: string) =>
    void navigate({ to: "/s/$spaceId/w/$workflowId/monitor", params: { spaceId, workflowId: id } });
  const back = () =>
    void navigate({ to: "/s/$spaceId/w/$workflowId", params: { spaceId, workflowId } });

  return (
    <div className="flex h-screen w-screen flex-col bg-background text-foreground">
      <div className="p-2 pb-0">
        <header className="flex items-center gap-3 rounded-2xl border border-border/40 bg-muted/40 px-4 py-2">
          <button
            onClick={back}
            title={t("monitoring.back")}
            className="flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <ArrowLeft className="size-4" />
          </button>
          <WorkflowIcon className="size-4 text-muted-foreground" />
          <h1 className="truncate text-sm font-semibold">{name}</h1>
        </header>
      </div>

      <div className="flex min-h-0 flex-1 gap-2 p-2">
        <FlowList workflowId={workflowId} onOpen={goFlow} />

        {/* center — selected flow */}
        <div className={cn(panel, "flex min-w-0 flex-1 flex-col overflow-hidden")}>
          <div className="flex items-center gap-3 border-b border-border/40 px-4 py-2.5">
            <HealthHeader health={health} />
            <div className="ml-auto flex shrink-0 items-center gap-1">
              {/* version history lives in the right-column timeline now (consolidated) */}
              <button
                onClick={() => setGovernanceOpen(true)}
                title={t("governance.title")}
                className="flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                <ShieldAlert className="size-4" />
              </button>
              <button
                onClick={() => setSettingsOpen(true)}
                title={t("settings.title")}
                className="flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                <Settings className="size-4" />
              </button>
            </div>
          </div>

          {/* alert panel (left half) + charts (right half) — top half of the column */}
          <div className="flex min-h-0 flex-1 gap-2 border-b border-border/40 p-2">
            <AlertPanel workflowId={workflowId} />
            <div className={cn(panel, "min-w-0 flex-1 overflow-hidden p-3")}>
              <MonitorGraphs runs={runs} />
            </div>
          </div>

          {/* runs + logs SIDE BY SIDE — fill remaining space, each scrolls internally */}
          <div className="flex min-h-0 flex-1 gap-2 p-2">
            {/* runs */}
            <div className={cn(panel, "flex min-w-0 flex-1 flex-col overflow-hidden")}>
              <div className="border-b border-border/40 px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/70">
                {t("monitoring.runs")}
              </div>
              <div className="min-h-0 flex-1 space-y-1 overflow-auto p-2">
                {runs.length === 0 ? (
                  <div className="py-4 text-center text-xs text-muted-foreground">{t("monitoring.noRuns")}</div>
                ) : (
                  runs.slice(0, 100).map((r) => {
                    const d = durMs(r);
                    return (
                      <button
                        key={r.id}
                        onClick={() => setOpenRunId(r.id)}
                        className="flex w-full items-center gap-2.5 rounded-lg border border-border/40 bg-background-subtle/40 px-2.5 py-1.5 text-left text-xs transition-colors hover:bg-background-subtle"
                      >
                        <span className={cn("size-2 shrink-0 rounded-full", RUN_DOT[r.status] ?? "bg-muted-foreground")} />
                        <span className="font-mono text-[11px] text-muted-foreground">{r.trigger}</span>
                        <span className="ml-auto shrink-0 text-muted-foreground/70">
                          {d !== undefined ? `${d}ms` : r.status} · {rel(r.startedAt)}
                        </span>
                      </button>
                    );
                  })
                )}
              </div>
            </div>

            {/* logs */}
            <div className={cn(panel, "flex min-w-0 flex-1 flex-col overflow-hidden")}>
              <div className="border-b border-border/40 px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/70">
                {t("monitoring.logs")}
              </div>
              <div className="min-h-0 flex-1 space-y-0.5 overflow-auto p-2">
                {logs.length === 0 ? (
                  <div className="py-4 text-center text-xs text-muted-foreground">{t("monitoring.noLogs")}</div>
                ) : (
                  logs.slice(0, 100).map((l: LogEntry) => {
                    const li = LOG_ICON[l.level] ?? LOG_ICON.info;
                    return (
                      <button
                        key={l.id}
                        type="button"
                        onClick={() => setOpenLog(l)}
                        className="flex w-full gap-2 rounded-lg px-1 py-1 text-left text-xs transition-colors hover:bg-background-subtle"
                      >
                        <li.Icon className={cn("mt-0.5 size-3.5 shrink-0", li.cls)} />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="truncate font-medium">{l.message}</span>
                            <span className="ml-auto shrink-0 rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                              {l.source}
                            </span>
                          </div>
                          {l.detail && (
                            <div className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground/70">{l.detail}</div>
                          )}
                        </div>
                      </button>
                    );
                  })
                )}
              </div>
            </div>
          </div>
        </div>

        {/* right — history timeline + Doctor chat (tabbed) */}
        {workflowId && <RightColumn workflowId={workflowId} onOpen={setOpenSource} />}
      </div>

      {settingsOpen && workflowId && <FlowSettingsModal workflowId={workflowId} onClose={() => setSettingsOpen(false)} />}
      {governanceOpen && <GovernanceModal onClose={() => setGovernanceOpen(false)} />}
      {openRunId && <RunDetailModal runId={openRunId} onClose={() => setOpenRunId(null)} />}
      {openLog && <LogDetailModal log={openLog} onClose={() => setOpenLog(null)} />}
      {openSource && workflowId && <ChangeReview source={openSource} workflowId={workflowId} onClose={() => setOpenSource(null)} />}
    </div>
  );
}
