import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import type { RunMeta } from "./queries";

// Four compact, themed charts derived from the run list — no chart library, just
// inline SVG (vector-effect keeps strokes crisp when the viewBox stretches).

const durMs = (r: RunMeta): number | undefined =>
  r.finishedAt ? Date.parse(r.finishedAt) - Date.parse(r.startedAt) : undefined;

const ERR_COLOR: Record<string, string> = {
  transient: "bg-amber-500",
  auth: "bg-violet-500",
  logic: "bg-rose-500",
  unknown: "bg-slate-500",
};

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0 flex-1 rounded-xl border border-border/40 bg-background-subtle/40 p-2.5">
      <div className="mb-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/70">{title}</div>
      {children}
    </div>
  );
}

// ── latency line + failure markers ───────────────────────────────────────────
function LatencyChart({ ordered }: { ordered: RunMeta[] }) {
  const { t } = useTranslation();
  const pts = ordered.map((r, i) => ({ i, d: durMs(r), failed: r.status === "failed" }));
  const withDur = pts.filter((p) => p.d !== undefined) as { i: number; d: number; failed: boolean }[];
  if (ordered.length < 2)
    return <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground">{t("monitoring.noRuns")}</div>;
  const N = ordered.length - 1;
  const max = Math.max(1, ...withDur.map((p) => p.d));
  const H = 40;
  const x = (i: number) => (N === 0 ? 0 : (i / N) * 100);
  const y = (d: number) => H - (d / max) * (H - 4) - 2;
  const line = withDur.map((p) => `${x(p.i)},${y(p.d)}`).join(" ");
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-1">
      <svg viewBox={`0 0 100 ${H}`} preserveAspectRatio="none" className="min-h-0 w-full flex-1 overflow-visible">
        {[0.25, 0.5, 0.75].map((g) => (
          <line key={g} x1="0" x2="100" y1={H * g} y2={H * g} className="stroke-border/40" strokeWidth="0.5" vectorEffect="non-scaling-stroke" />
        ))}
        {withDur.length >= 2 && (
          <polyline points={line} fill="none" className="stroke-emerald-500" strokeWidth="1.5" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
        )}
        {pts.filter((p) => p.failed).map((p) => (
          <line key={p.i} x1={x(p.i)} x2={x(p.i)} y1="0" y2={H} className="stroke-rose-500/70" strokeWidth="1" vectorEffect="non-scaling-stroke" />
        ))}
      </svg>
      <div className="flex shrink-0 justify-between text-[9px] text-muted-foreground/50">
        <span>{t("monitoring.graphHint")}</span>
        <span>~{max}ms</span>
      </div>
    </div>
  );
}

// ── success rate ──────────────────────────────────────────────────────────────
function SuccessRate({ completed }: { completed: RunMeta[] }) {
  const { t } = useTranslation();
  const done = completed.filter((r) => r.status === "done").length;
  const rate = completed.length ? Math.round((done / completed.length) * 100) : null;
  return (
    <Card title={t("monitoring.successRate")}>
      <div className="flex items-baseline gap-1">
        <span className={cn("text-2xl font-semibold", rate === null ? "text-muted-foreground" : rate >= 90 ? "text-emerald-500" : rate >= 60 ? "text-amber-500" : "text-rose-500")}>
          {rate === null ? "—" : `${rate}%`}
        </span>
        <span className="text-[10px] text-muted-foreground/60">{t("monitoring.lastN", { n: completed.length })}</span>
      </div>
      <div className="mt-1.5 flex h-1.5 gap-px overflow-hidden rounded-full">
        {completed.slice(0, 30).reverse().map((r, i) => (
          <div key={i} className={cn("flex-1", r.status === "failed" ? "bg-rose-500" : "bg-emerald-500")} />
        ))}
      </div>
    </Card>
  );
}

// ── error-type breakdown ──────────────────────────────────────────────────────
function ErrorBreakdown({ failed }: { failed: RunMeta[] }) {
  const { t } = useTranslation();
  const counts = useMemo(() => {
    const m: Record<string, number> = {};
    for (const r of failed) m[r.errorType ?? "unknown"] = (m[r.errorType ?? "unknown"] ?? 0) + 1;
    return Object.entries(m).sort((a, b) => b[1] - a[1]);
  }, [failed]);
  const max = Math.max(1, ...counts.map(([, c]) => c));
  return (
    <Card title={t("monitoring.errorTypes")}>
      {counts.length === 0 ? (
        <div className="py-2 text-center text-[11px] text-muted-foreground/60">{t("monitoring.noErrors")}</div>
      ) : (
        <div className="space-y-1">
          {counts.map(([kind, c]) => (
            <div key={kind} className="flex items-center gap-2 text-[11px]">
              <span className="w-14 shrink-0 truncate text-muted-foreground">{kind}</span>
              <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
                <div className={cn("h-full rounded-full", ERR_COLOR[kind] ?? "bg-slate-500")} style={{ width: `${(c / max) * 100}%` }} />
              </div>
              <span className="w-4 shrink-0 text-right tabular-nums text-muted-foreground/70">{c}</span>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

// ── run volume per hour (last buckets) ────────────────────────────────────────
function Volume({ runs }: { runs: RunMeta[] }) {
  const { t } = useTranslation();
  const buckets = useMemo(() => {
    const HOUR = 3_600_000;
    const now = Date.now();
    const arr = Array.from({ length: 24 }, () => ({ done: 0, failed: 0 }));
    for (const r of runs) {
      const age = now - Date.parse(r.startedAt);
      const idx = 23 - Math.floor(age / HOUR);
      if (idx >= 0 && idx < 24) (r.status === "failed" ? (arr[idx].failed++) : (arr[idx].done++));
    }
    return arr;
  }, [runs]);
  const max = Math.max(1, ...buckets.map((b) => b.done + b.failed));
  return (
    <Card title={t("monitoring.volume")}>
      <div className="flex h-16 items-end gap-px">
        {buckets.map((b, i) => {
          const total = b.done + b.failed;
          return (
            <div key={i} title={`${total} runs`} className="flex flex-1 flex-col justify-end" style={{ height: "100%" }}>
              {b.failed > 0 && <div className="bg-rose-500" style={{ height: `${(b.failed / max) * 100}%` }} />}
              {b.done > 0 && <div className="bg-emerald-500/70" style={{ height: `${(b.done / max) * 100}%` }} />}
            </div>
          );
        })}
      </div>
      <div className="mt-1 text-[9px] text-muted-foreground/50">{t("monitoring.volumeHint")}</div>
    </Card>
  );
}

export function MonitorGraphs({ runs }: { runs: RunMeta[] }) {
  const { t } = useTranslation();
  // newest-first → window, plus an oldest→newest copy for the time-series
  const windowed = useMemo(() => runs.slice(0, 60), [runs]);
  const ordered = useMemo(() => [...windowed].reverse(), [windowed]);
  const completed = useMemo(() => windowed.filter((r) => r.status === "done" || r.status === "failed"), [windowed]);
  const failed = useMemo(() => windowed.filter((r) => r.status === "failed"), [windowed]);

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      {/* latency grows to fill the (now larger) graph area */}
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="mb-1.5 shrink-0 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/70">{t("monitoring.latency")}</div>
        <LatencyChart ordered={ordered} />
      </div>
      <div className="flex shrink-0 gap-2">
        <SuccessRate completed={completed} />
        <ErrorBreakdown failed={failed} />
        <Volume runs={windowed} />
      </div>
    </div>
  );
}
