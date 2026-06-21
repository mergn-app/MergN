import type { RunMeta } from "./runs";

// Pure run-history analytics — the numbers a monitoring assistant (MCP get_analytics
// / Doctor) reports: success rate, error-type breakdown, latency percentiles, volume.
// Derived from RunMeta only (no new backend aggregation); `now` is injected so it
// stays deterministic + testable.

export interface Analytics {
  total: number;
  byStatus: { done: number; failed: number; running: number; skipped: number; other: number };
  successRate: number | null; // done / (done + failed), null when no terminal runs
  errorBreakdown: { transient: number; auth: number; logic: number; unknown: number };
  latencyMs: { p50: number; p95: number; avg: number } | null; // finished runs only
  volume: { last24h: number; last7d: number };
}

const percentile = (sorted: number[], p: number): number => {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[i];
};

export function computeAnalytics(runs: RunMeta[], nowMs: number): Analytics {
  const byStatus = { done: 0, failed: 0, running: 0, skipped: 0, other: 0 };
  const errorBreakdown = { transient: 0, auth: 0, logic: 0, unknown: 0 };
  const latencies: number[] = [];
  let last24h = 0, last7d = 0;
  const DAY = 86_400_000;

  for (const r of runs) {
    if (r.status in byStatus) byStatus[r.status as keyof typeof byStatus]++;
    else byStatus.other++;

    if (r.status === "failed") {
      const t = (r.errorType ?? "unknown") as keyof typeof errorBreakdown;
      errorBreakdown[t in errorBreakdown ? t : "unknown"]++;
    }

    if (r.finishedAt) {
      const ms = Date.parse(r.finishedAt) - Date.parse(r.startedAt);
      if (Number.isFinite(ms) && ms >= 0) latencies.push(ms);
    }

    const started = Date.parse(r.startedAt);
    if (Number.isFinite(started)) {
      if (nowMs - started <= DAY) last24h++;
      if (nowMs - started <= 7 * DAY) last7d++;
    }
  }

  const terminal = byStatus.done + byStatus.failed;
  const successRate = terminal > 0 ? byStatus.done / terminal : null;

  latencies.sort((a, b) => a - b);
  const latencyMs = latencies.length
    ? {
        p50: percentile(latencies, 50),
        p95: percentile(latencies, 95),
        avg: Math.round(latencies.reduce((s, x) => s + x, 0) / latencies.length),
      }
    : null;

  return { total: runs.length, byStatus, successRate, errorBreakdown, latencyMs, volume: { last24h, last7d } };
}
