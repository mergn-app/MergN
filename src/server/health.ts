import type { ErrorType } from "./error-classify";
import type { RunStore } from "./runs";

// Per-flow health. `computeHealth` is pure (testable); the monitor caches a
// HealthState per workflow, recomputes from recent runs + liveness, and fires a
// callback on transitions (used to drive alerting / status UI).

export type HealthStatus = "healthy" | "degraded" | "failing" | "nodata";

export interface LivenessFail {
  kind: "schedule" | "webhook";
  since: string;
}

export interface HealthState {
  workflowId: string;
  status: HealthStatus;
  lastRunAt?: string;
  lastError?: { type: ErrorType; message: string };
  livenessFail?: LivenessFail;
  updatedAt: string;
}

// How many trailing runs to consider, and how many consecutive failures (or a
// liveness fail) flip a flow to 🔴. Technical defaults — NOT plan policy, so
// they live here, not in limits.ts. Overridable via env for ops tuning.
const WINDOW = Number(process.env.HEALTH_WINDOW) || 20;
const FAIL_STREAK = Number(process.env.HEALTH_FAIL_STREAK) || 3;

export interface ComputeHealthInput {
  recentRuns: { status: string }[]; // newest-first
  livenessFail?: boolean;
  failStreak?: number;
}

export function computeHealth(input: ComputeHealthInput): HealthStatus {
  const streak = input.failStreak ?? FAIL_STREAK;
  // only completed runs classify health; an in-flight "running" is ignored
  const completed = input.recentRuns.filter(
    (r) => r.status === "done" || r.status === "failed",
  );
  if (completed.length === 0) return "nodata";
  if (input.livenessFail) return "failing";
  let consecutive = 0;
  for (const r of completed) {
    if (r.status === "failed") consecutive++;
    else break;
  }
  if (consecutive >= streak) return "failing";
  const anyFailure = completed.some((r) => r.status === "failed");
  return anyFailure ? "degraded" : "healthy";
}

// `undefined` = preserve cached value, `null` = clear it, object = set it.
export interface RecomputeOpts {
  lastError?: { type: ErrorType; message: string } | null;
  liveness?: LivenessFail | null;
}

export interface HealthMonitor {
  recompute(
    spaceId: string,
    workflowId: string,
    opts?: RecomputeOpts,
  ): Promise<HealthState>;
  get(spaceId: string, workflowId: string): HealthState | undefined;
  summary(spaceId: string): Promise<HealthState[]>;
}

export interface HealthMonitorDeps {
  runs: RunStore;
  onChange?: (
    spaceId: string,
    state: HealthState,
    prev: HealthStatus | undefined,
  ) => void;
  now?: () => number;
}

const key = (spaceId: string, workflowId: string) => `${spaceId} ${workflowId}`;

export function createHealthMonitor(deps: HealthMonitorDeps): HealthMonitor {
  const { runs, onChange } = deps;
  const now = deps.now ?? (() => Date.now());
  const cache = new Map<string, HealthState>();

  async function recompute(
    spaceId: string,
    workflowId: string,
    opts: RecomputeOpts = {},
  ): Promise<HealthState> {
    const k = key(spaceId, workflowId);
    const prev = cache.get(k);

    const metas = await runs.listRuns(spaceId, workflowId);
    const recentRuns = metas.slice(0, WINDOW); // listRuns is already newest-first
    const livenessFail =
      opts.liveness === undefined ? prev?.livenessFail : opts.liveness ?? undefined;

    const status = computeHealth({
      recentRuns,
      livenessFail: !!livenessFail,
    });

    // lastError: a fresh successful latest run clears it; otherwise apply the
    // explicit opt (set/clear) or preserve what we had.
    const latest = recentRuns[0];
    let lastError = prev?.lastError;
    if (opts.lastError !== undefined) lastError = opts.lastError ?? undefined;
    if (latest?.status === "done") lastError = undefined;

    const state: HealthState = {
      workflowId,
      status,
      lastRunAt: latest?.startedAt ?? prev?.lastRunAt,
      lastError,
      livenessFail: livenessFail ?? undefined,
      updatedAt: new Date(now()).toISOString(),
    };
    cache.set(k, state);
    if (prev?.status !== status) onChange?.(spaceId, state, prev?.status);
    return state;
  }

  return {
    recompute,
    get: (spaceId, workflowId) => cache.get(key(spaceId, workflowId)),
    async summary(spaceId) {
      // refresh every known workflow in this space from run history
      const metas = await runs.listRuns(spaceId);
      const ids = [...new Set(metas.map((m) => m.workflowId))];
      const out: HealthState[] = [];
      for (const id of ids) out.push(await recompute(spaceId, id));
      return out;
    },
  };
}
