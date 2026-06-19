import type { DocStore } from "../store/docstore";
import type { StepRecord } from "../atoms/index";
import { LIMITS } from "../limits";

// M2: runs are persisted incrementally. A header doc (status "running") is
// written at start; each step is appended to a separate append-only collection
// (no read-modify-write amplification on big fan-outs); finalize flips the
// header to done/failed. Records are assembled from run_steps on read, so the
// header never duplicates step data. Legacy runs (full RunDoc via saveRun) are
// still readable. Step IO is PII-masked by the caller before appendStep.
const COLLECTION = "runs";
const STEPS = "run_steps";

export interface RunDoc {
  id: string;
  workflowId: string;
  workflowName: string;
  trigger: string;
  status: "running" | "done" | "failed";
  input: Record<string, unknown>;
  records: StepRecord[]; // assembled from run_steps on read (or legacy inline)
  startedAt: string;
  finishedAt?: string; // absent while running
  workflowVersionId?: string; // M1 stamp
  maskLevel?: string; // mask level applied to this run's step IO
  stepCount?: number; // set on finalize (cheap list metric)
  failReason?: string; // e.g. "orphaned"
}

export type RunHeader = Omit<RunDoc, "records">;

export interface RunStepDoc extends StepRecord {
  spaceId: string;
  workflowId: string;
  seq: number;
  at: string;
}

export interface RunMeta {
  id: string;
  workflowId: string;
  workflowName: string;
  trigger: string;
  status: string;
  startedAt: string;
  finishedAt?: string;
  stepCount: number;
}

export interface RunStore {
  // M2 incremental lifecycle:
  startRun(spaceId: string, header: RunHeader): Promise<void>;
  appendStep(spaceId: string, step: RunStepDoc): Promise<void>;
  listSteps(spaceId: string, runId: string): Promise<StepRecord[]>;
  finalizeRun(
    spaceId: string,
    runId: string,
    status: "done" | "failed",
    finishedAt: string,
    failReason?: string,
  ): Promise<void>;
  // reads:
  listRuns(spaceId: string, workflowId?: string): Promise<RunMeta[]>;
  getRun(spaceId: string, id: string): Promise<RunDoc | null>;
  // maintenance:
  pruneRuns(spaceId: string): Promise<number>;
  markOrphaned(spaceId: string, maxRunMs: number): Promise<number>;
  // legacy/compat — write a complete RunDoc in one shot:
  saveRun(spaceId: string, run: RunDoc): Promise<void>;
}

// `_` separator — DocStore ids must match /^[A-Za-z0-9_-]+$/ (no colon).
const stepId = (runId: string, seq: number) => `${runId}_${seq}`;
const nonTrigger = (r: StepRecord) => r.nodeId !== "trigger";

export function createRunStore(store: DocStore): RunStore {
  async function listSteps(
    spaceId: string,
    runId: string,
  ): Promise<StepRecord[]> {
    const docs = (await store.list(spaceId, STEPS)) as unknown as RunStepDoc[];
    return docs.filter((s) => s.runId === runId).sort((a, b) => a.seq - b.seq);
  }

  async function readHeader(
    spaceId: string,
    id: string,
  ): Promise<RunDoc | null> {
    return (await store.get(spaceId, COLLECTION, id)) as unknown as RunDoc | null;
  }

  return {
    listSteps,

    async startRun(spaceId, header) {
      await store.put(
        spaceId,
        COLLECTION,
        header.id,
        header as unknown as Record<string, unknown>,
      );
    },

    async appendStep(spaceId, step) {
      await store.put(
        spaceId,
        STEPS,
        stepId(step.runId, step.seq),
        step as unknown as Record<string, unknown>,
      );
    },

    async finalizeRun(spaceId, runId, status, finishedAt, failReason) {
      const header = await readHeader(spaceId, runId);
      if (!header) return;
      const steps = await listSteps(spaceId, runId);
      await store.put(spaceId, COLLECTION, runId, {
        ...header,
        status,
        finishedAt,
        stepCount: steps.filter(nonTrigger).length,
        ...(failReason ? { failReason } : {}),
      } as unknown as Record<string, unknown>);
    },

    async getRun(spaceId, id) {
      const header = await readHeader(spaceId, id);
      if (!header) return null;
      const steps = await listSteps(spaceId, id);
      return {
        ...header,
        records: steps.length ? steps : (header.records ?? []),
      };
    },

    async listRuns(spaceId, workflowId) {
      const docs = (await store.list(
        spaceId,
        COLLECTION,
      )) as unknown as RunDoc[];
      return docs
        .filter((r) => !workflowId || r.workflowId === workflowId)
        .map((r) => ({
          id: r.id,
          workflowId: r.workflowId,
          workflowName: r.workflowName,
          trigger: r.trigger,
          status: r.status,
          startedAt: r.startedAt,
          finishedAt: r.finishedAt,
          stepCount:
            r.stepCount ??
            (Array.isArray(r.records)
              ? r.records.filter(nonTrigger).length
              : 0),
        }))
        .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
    },

    async pruneRuns(spaceId) {
      const days = LIMITS.runRetentionDays;
      if (!Number.isFinite(days) || days < 0) return 0; // UNLIMITED / self-host
      const cutoff = Date.now() - days * 86_400_000;
      const docs = (await store.list(
        spaceId,
        COLLECTION,
      )) as unknown as RunDoc[];
      let removed = 0;
      for (const r of docs) {
        if (r.status === "running") continue; // never prune live runs
        const when = Date.parse(r.finishedAt ?? r.startedAt);
        if (Number.isFinite(when) && when < cutoff) {
          for (const s of (await listSteps(spaceId, r.id)) as RunStepDoc[])
            await store.remove(spaceId, STEPS, stepId(r.id, s.seq));
          await store.remove(spaceId, COLLECTION, r.id);
          removed++;
        }
      }
      return removed;
    },

    async markOrphaned(spaceId, maxRunMs) {
      const cutoff = Date.now() - maxRunMs;
      const docs = (await store.list(
        spaceId,
        COLLECTION,
      )) as unknown as RunDoc[];
      let n = 0;
      for (const r of docs) {
        if (r.status !== "running") continue;
        if (Date.parse(r.startedAt) < cutoff) {
          await store.put(spaceId, COLLECTION, r.id, {
            ...r,
            status: "failed",
            finishedAt: new Date().toISOString(),
            failReason: "orphaned",
          } as unknown as Record<string, unknown>);
          n++;
        }
      }
      return n;
    },

    async saveRun(spaceId, run) {
      await store.put(
        spaceId,
        COLLECTION,
        run.id,
        run as unknown as Record<string, unknown>,
      );
    },
  };
}
