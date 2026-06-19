import type { DocStore } from "../store/docstore";
import type { ScheduleStore } from "../store/schedules";
import type { RunStore } from "./runs";
import type { HealthMonitor } from "./health";

// Schedule liveness. A schedule that silently stops firing produces no failed
// run — nothing else notices. This evaluator compares each active interval
// schedule's last fire against its expected cadence and, past a tolerance,
// records a liveness fail on the flow's health.
//
// Only interval schedules ("@every Ns") are evaluated. Cron specs are not (we
// don't compute their previous fire time here), and polls fire every tick but
// only record a run on new data, so run-recency wouldn't reflect their cadence.

// Tolerance + grace + tick cadence are technical defaults (NOT plan policy), so
// they live here, env-overridable — not in limits.ts.
const TOLERANCE_PCT = Number(process.env.LIVENESS_TOLERANCE_PCT) || 0.5;
const GRACE_MS = Number(process.env.LIVENESS_GRACE_MS) || 30_000;
const TICK_MS = Number(process.env.LIVENESS_TICK_MS) || 60_000;

// "@every 30s" → 30000. Anything else (cron) → undefined.
export function intervalMsFromSpec(spec: string): number | undefined {
  const m = /^@every\s+(\d+)s$/.exec(spec.trim());
  if (!m) return undefined;
  const secs = Number(m[1]);
  return Number.isFinite(secs) && secs > 0 ? secs * 1000 : undefined;
}

// A fire is "missed" once the gap since the last fire exceeds one interval plus
// tolerance + grace. The clock starts at the LATER of the last fire and the last
// (re)activation/edit (`activeSince` = job.updatedAt): a freshly resumed, edited
// or just-recovered schedule gets a full interval before it's "overdue", so
// pausing/editing never produces a false liveness fail. The gap only grows until
// the next fire, so detection is sustained, not flickering.
export function scheduleOverdue(params: {
  intervalMs: number;
  lastRunAt?: string;
  activeSince: string; // job.updatedAt — last register/resume/edit
  now: number;
  tolerancePct?: number;
  graceMs?: number;
}): boolean {
  const tol = params.tolerancePct ?? TOLERANCE_PCT;
  const grace = params.graceMs ?? GRACE_MS;
  const allowed = params.intervalMs * (1 + tol) + grace;
  const lastMs = params.lastRunAt ? Date.parse(params.lastRunAt) : NaN;
  const sinceMs = Date.parse(params.activeSince);
  const refMs = Math.max(
    Number.isFinite(lastMs) ? lastMs : 0,
    Number.isFinite(sinceMs) ? sinceMs : 0,
  );
  if (refMs === 0) return false;
  return params.now - refMs > allowed;
}

export interface LivenessEvaluator {
  tick(): Promise<number>; // returns # of jobs evaluated
  start(): () => void; // begin periodic ticking; returns stop()
}

export interface LivenessDeps {
  store: DocStore;
  scheduleStore: ScheduleStore;
  runs: RunStore;
  health: HealthMonitor;
  now?: () => number;
}

export function createLivenessEvaluator(deps: LivenessDeps): LivenessEvaluator {
  const { store, scheduleStore, runs, health } = deps;
  const now = deps.now ?? (() => Date.now());

  async function evaluateJob(spaceId: string, job: {
    workflowId: string;
    triggerType: "schedule" | "poll";
    spec: string;
    active: boolean;
    updatedAt: string;
  }): Promise<boolean> {
    if (!job.active) return false; // paused jobs aren't liveness-evaluated
    // Only schedules fire→record 1:1. A poll fires every tick but only records a
    // run when it finds NEW data, so run-recency ≠ poll-cadence — an idle poll
    // would look dead. Polls are not evaluated here.
    if (job.triggerType !== "schedule") return false;
    const intervalMs = intervalMsFromSpec(job.spec);
    if (intervalMs === undefined) return false; // cron specs aren't evaluated here

    const metas = await runs.listRuns(spaceId, job.workflowId);
    const lastRunAt = metas[0]?.startedAt; // any status = "it fired"
    const overdue = scheduleOverdue({
      intervalMs,
      lastRunAt,
      activeSince: job.updatedAt,
      now: now(),
    });

    // Only touch health on a transition, to avoid re-reading runs needlessly.
    const cur = health.get(spaceId, job.workflowId);
    if (overdue && !cur?.livenessFail) {
      const refMs = Math.max(
        lastRunAt ? Date.parse(lastRunAt) : 0,
        Date.parse(job.updatedAt),
      );
      await health.recompute(spaceId, job.workflowId, {
        liveness: { kind: "schedule", since: new Date(refMs + intervalMs).toISOString() },
      });
    } else if (!overdue && cur?.livenessFail) {
      await health.recompute(spaceId, job.workflowId, { liveness: null });
    }
    return true;
  }

  async function tick(): Promise<number> {
    let evaluated = 0;
    for (const spaceId of await store.spaces()) {
      const jobs = await scheduleStore.listBySpace(spaceId);
      for (const job of jobs) {
        try {
          if (await evaluateJob(spaceId, job)) evaluated++;
        } catch (e) {
          console.error("liveness eval failed", spaceId, job.workflowId, e);
        }
      }
    }
    return evaluated;
  }

  function start(): () => void {
    const handle = setInterval(() => {
      void tick().catch((e) => console.error("liveness tick failed", e));
    }, TICK_MS);
    if (typeof handle.unref === "function") handle.unref();
    return () => clearInterval(handle);
  }

  return { tick, start };
}
