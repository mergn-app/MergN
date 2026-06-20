import type { ScheduleStore } from "../store/schedules";
import type { DocStore } from "../store/docstore";
import type { HealthMonitor } from "./health";
import type { RunStore } from "./runs";
import type { WorkflowStore } from "./store";
import { evaluateHeartbeat } from "./webhook-liveness";

// Schedule + poll liveness. A job that silently stops firing produces no failed
// run — nothing else notices. This evaluator compares each active interval job's
// last FIRE (recorded by the scheduler-consumer on every NATS fire, in the job
// doc) against its expected cadence; past a tolerance it records a liveness fail.
//
// Fire-observation, not run-observation: we watch the actual fire, so it works
// for polls too (an idle poll still FIRES even when it produces no run — no
// run-recency false positive) and costs one job query per tick, no per-job run
// scan. Only interval specs ("@every Ns") are evaluated; cron specs are not (we
// don't compute their previous fire time here).

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

// Cron cadence is irregular, so instead of computing the next fire (which would
// need a cron parser that could disagree with NATS), we LEARN it from observed
// fires: the largest gap between recent fires is the expected max silence. Past
// that (× tolerance) with no new fire → overdue. Needs ≥ minHistory fires to
// trust the learned gap (a young cron stays silent until it has history).
// Note: a genuinely-irregular cron (e.g. weekdays-only) can over-flag once in
// its first period until the long (weekend) gap has been observed.
export function cronOverdue(params: {
  recentFires: string[]; // ISO, any order
  activeSince: string;
  now: number;
  tolerancePct?: number;
  minHistory?: number;
}): boolean {
  const minH = params.minHistory ?? 3;
  const fires = params.recentFires
    .map((s) => Date.parse(s))
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b);
  if (fires.length < minH) return false;
  let maxGap = 0;
  for (let i = 1; i < fires.length; i++)
    maxGap = Math.max(maxGap, fires[i] - fires[i - 1]);
  if (maxGap <= 0) return false;
  const tol = params.tolerancePct ?? TOLERANCE_PCT;
  const sinceMs = Date.parse(params.activeSince);
  const refMs = Math.max(
    fires[fires.length - 1],
    Number.isFinite(sinceMs) ? sinceMs : 0,
  );
  return params.now - refMs > maxGap * (1 + tol);
}

export interface LivenessEvaluator {
  tick(): Promise<number>; // returns # of jobs evaluated
  start(): () => void; // begin periodic ticking; returns stop()
}

export interface LivenessDeps {
  scheduleStore: ScheduleStore;
  health: HealthMonitor;
  // optional — enables the webhook-heartbeat pass (opt-in flows only)
  store?: DocStore;
  workflows?: WorkflowStore;
  runs?: RunStore;
  now?: () => number;
}

// webhook windows are coarse (hour/day/week), and the pass is O(workflows), so
// it runs only every Nth tick instead of every minute.
const WEBHOOK_EVERY = 5;

export function createLivenessEvaluator(deps: LivenessDeps): LivenessEvaluator {
  const { scheduleStore, health, store, workflows, runs } = deps;
  const now = deps.now ?? (() => Date.now());
  let tickN = 0;

  async function evaluateJob(job: {
    spaceId: string;
    workflowId: string;
    triggerType: "schedule" | "poll";
    spec: string;
    active: boolean;
    lastFiredAt?: string;
    recentFires?: string[];
    updatedAt: string;
  }): Promise<boolean> {
    if (!job.active) return false; // paused jobs aren't liveness-evaluated

    // lastFiredAt = the actual NATS fire (consumer-written), works for polls too.
    const intervalMs = intervalMsFromSpec(job.spec);
    let overdue: boolean;
    let sinceMs: number;
    if (intervalMs !== undefined) {
      // interval / poll — fixed cadence from the spec
      overdue = scheduleOverdue({
        intervalMs,
        lastRunAt: job.lastFiredAt,
        activeSince: job.updatedAt,
        now: now(),
      });
      sinceMs =
        Math.max(
          job.lastFiredAt ? Date.parse(job.lastFiredAt) : 0,
          Date.parse(job.updatedAt),
        ) + intervalMs;
    } else if ((job.recentFires?.length ?? 0) >= 3) {
      // cron — learned cadence from observed fires
      overdue = cronOverdue({
        recentFires: job.recentFires!,
        activeSince: job.updatedAt,
        now: now(),
      });
      sinceMs = job.lastFiredAt
        ? Date.parse(job.lastFiredAt)
        : Date.parse(job.updatedAt);
    } else {
      return false; // cron without enough history (or an unparseable spec)
    }

    // Only touch health on a transition (health.get is the in-memory cache, no IO).
    const cur = health.get(job.spaceId, job.workflowId);
    if (overdue && !cur?.livenessFail) {
      await health.recompute(job.spaceId, job.workflowId, {
        liveness: { kind: "schedule", since: new Date(sinceMs).toISOString() },
      });
    } else if (!overdue && cur?.livenessFail) {
      await health.recompute(job.spaceId, job.workflowId, { liveness: null });
    }
    return true;
  }

  // Webhook heartbeat: a webhook flow with an opt-in heartbeat config — compare
  // its declared expected cadence against actual webhook arrivals (= webhook-
  // triggered runs). Opt-in → only flows with config are judged.
  async function evaluateWebhook(
    spaceId: string,
    wf: { id: string; trigger?: { kind?: string }; liveness?: { webhook?: { heartbeat?: Parameters<typeof evaluateHeartbeat>[0]["hb"] } }; createdAt?: string },
  ): Promise<boolean> {
    const hb = wf.liveness?.webhook?.heartbeat;
    if (wf.trigger?.kind !== "webhook" || !hb || !runs) return false;
    const metas = await runs.listRuns(spaceId, wf.id);
    const arrivals = metas
      .filter((m) => m.trigger === "webhook")
      .map((m) => Date.parse(m.startedAt))
      .filter((n) => Number.isFinite(n));
    const fail = evaluateHeartbeat({
      hb,
      arrivals,
      now: now(),
      activeSince: wf.createdAt ? Date.parse(wf.createdAt) : undefined,
    });
    const cur = health.get(spaceId, wf.id);
    if (fail && !cur?.livenessFail) {
      await health.recompute(spaceId, wf.id, {
        liveness: { kind: "webhook", since: new Date(now()).toISOString() },
      });
    } else if (!fail && cur?.livenessFail) {
      await health.recompute(spaceId, wf.id, { liveness: null });
    }
    return true;
  }

  async function tickWebhooks(): Promise<void> {
    if (!store || !workflows || !runs) return;
    for (const spaceId of await store.spaces()) {
      for (const meta of await workflows.listWorkflows(spaceId)) {
        try {
          const wf = await workflows.getWorkflow(spaceId, meta.id);
          if (wf) await evaluateWebhook(spaceId, wf);
        } catch (e) {
          console.error("webhook liveness eval failed", spaceId, meta.id, e);
        }
      }
    }
  }

  // One pass over all active jobs (single store query) + in-memory timestamp
  // math; no per-job run-history reads → scales to many tenants/flows. The
  // (heavier, opt-in) webhook pass runs only every WEBHOOK_EVERY ticks.
  async function tick(): Promise<number> {
    tickN++;
    let evaluated = 0;
    for (const job of await scheduleStore.listActive()) {
      try {
        if (await evaluateJob(job)) evaluated++;
      } catch (e) {
        console.error("liveness eval failed", job.spaceId, job.workflowId, e);
      }
    }
    if (tickN % WEBHOOK_EVERY === 1)
      await tickWebhooks().catch((e) =>
        console.error("webhook liveness tick failed", e),
      );
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
