import type { SavedWorkflow } from "./store";
import type { BufferStore } from "./trigger-buffer";

// Drains a paused flow's buffered events back through the normal run path —
// FIFO, idempotent, resume-aware. It invents no new execution: it mints a
// deterministic runId per entry and hands it to runSavedWorkflow, leaning on the
// existing idempotency dedup (no double side-effects) and resume-from-step. The
// DocStore is the FIFO truth source (a single-pass drain can't ride a long-lived
// JetStream consume loop).

interface RunResult {
  id: string;
  status: string;
}

export interface ReplayDeps {
  buffer: BufferStore;
  getWorkflow(spaceId: string, workflowId: string): Promise<SavedWorkflow | null>;
  runSavedWorkflow(
    spaceId: string,
    wf: SavedWorkflow,
    input: Record<string, unknown>,
    trigger: string,
    runId?: string,
    resumeFrom?: { runId: string },
  ): Promise<RunResult>;
  setPaused(spaceId: string, workflowId: string, paused: boolean): Promise<void>;
}

export interface ReplayResult {
  replayed: number;
  failed: number;
  runs: { entryId: string; runId: string; status: string }[];
}

export async function replayBuffer(
  deps: ReplayDeps,
  spaceId: string,
  workflowId: string,
): Promise<ReplayResult> {
  const result: ReplayResult = { replayed: 0, failed: 0, runs: [] };
  const wf = await deps.getWorkflow(spaceId, workflowId);
  if (!wf) return result;

  // Single-pass FIFO drain off the DocStore truth source. Re-read each round so
  // events arriving mid-drain (flow still paused) join the SAME pass — FIFO
  // holds because new entries get a higher seq and land at the tail.
  for (;;) {
    const next = (await deps.buffer.list(spaceId, workflowId)).find((e) => e.status === "buffered");
    if (!next) break;
    // Claim the entry: a second replay (double-click / other instance) skips it,
    // and the deterministic runId means even a racing run hits the idempotency dedup.
    await deps.buffer.setStatus(spaceId, next.id, "replaying");
    const runId = `webhook-${next.id}`; // deterministic → one entry, one side-effect set
    try {
      const run = await deps.runSavedWorkflow(
        spaceId,
        wf,
        next.payload,
        "webhook",
        runId,
        next.resumeFromRunId ? { runId: next.resumeFromRunId } : undefined,
      );
      const ok = run.status !== "failed";
      await deps.buffer.setStatus(spaceId, next.id, ok ? "replayed" : "failed", { replayedRunId: run.id });
      result.runs.push({ entryId: next.id, runId: run.id, status: run.status });
      if (ok) result.replayed++;
      else result.failed++;
    } catch (e) {
      await deps.buffer.setStatus(spaceId, next.id, "failed");
      result.failed++;
      console.error(`buffer replay errored [${workflowId}/${next.id}]`, e);
    }
  }

  // Unpause ONLY when every entry is terminal (replayed/failed) — not "queue
  // empty". A mid-drain arrival keeps the flow paused until it too is drained.
  const stillPending =
    (await deps.buffer.count(spaceId, workflowId, "buffered")) +
    (await deps.buffer.count(spaceId, workflowId, "replaying"));
  if (stillPending === 0) await deps.setPaused(spaceId, workflowId, false);
  return result;
}

// Test-run: execute the first buffered event's REAL payload to verify a fix,
// WITHOUT consuming it (peek only) and WITHOUT idempotency (non-deterministic
// runId → real side effects; the UI warns when downstream danger is non-benign).
export async function testRunFirst(
  deps: ReplayDeps,
  spaceId: string,
  workflowId: string,
  now: string,
): Promise<{ ran: false } | { ran: true; entryId: string; runId: string; status: string }> {
  const wf = await deps.getWorkflow(spaceId, workflowId);
  if (!wf) return { ran: false };
  const entry = await deps.buffer.peekFirst(spaceId, workflowId);
  if (!entry) return { ran: false };
  const run = await deps.runSavedWorkflow(spaceId, wf, entry.payload, "webhook", `test-${entry.id}-${now}`, undefined);
  return { ran: true, entryId: entry.id, runId: run.id, status: run.status };
}
