import type { RunDoc, RunMeta } from "./runs";
import type { SavedWorkflow } from "./store";
import type { DiagnosisContext } from "./fix-engine";

// Builds the diagnosis triple for a failed run: (a) the failed step's error +
// resolved input + its CODE, (b) the same step's IO from the last successful run,
// (c) the flow definition. The step's bodySource is NOT in the run record — it's
// sourced from the workflow def (run steps only carry resolvedInput/output/error).

export interface DiagnosisContextDeps {
  getRun: (spaceId: string, id: string) => Promise<RunDoc | null>;
  listRuns: (spaceId: string, workflowId?: string, limit?: number) => Promise<RunMeta[]>;
  getWorkflow: (spaceId: string, id: string) => Promise<SavedWorkflow | null | undefined>;
}

interface FuncEntry {
  id: string;
  bodySource?: string;
}

// Returns null when the run isn't a diagnosable failure (missing / not failed).
export async function buildDiagnosisContext(
  deps: DiagnosisContextDeps,
  spaceId: string,
  runId: string,
): Promise<DiagnosisContext | null> {
  const run = await deps.getRun(spaceId, runId);
  if (!run || run.status !== "failed") return null;

  // the failed step (the per-step catch writes a `failed` record); fall back to
  // the run-level failReason when the failure was systemic (no step record).
  const failedStep = run.records.find((r) => r.status === "failed" && r.error);
  const failedNodeId = failedStep?.nodeId ?? "";
  const error = failedStep?.error ?? run.failReason ?? "unknown error";
  const resolvedInput = failedStep?.resolvedInput ?? {};

  const wf = await deps.getWorkflow(spaceId, run.workflowId);
  const funcs = (wf?.funcs ?? []) as FuncEntry[];
  const bodySource = funcs.find((f) => f.id === failedNodeId)?.bodySource ?? "";

  const lastGoodStepIO = failedNodeId
    ? await findLastGoodStepIO(deps, spaceId, run.workflowId, failedNodeId, runId)
    : undefined;

  return {
    workflowId: run.workflowId,
    failedRun: { runId, failedNodeId, error, resolvedInput, bodySource },
    lastGoodStepIO,
    workflow: { funcs: wf?.funcs ?? [], wires: wf?.wires ?? [], trigger: wf?.trigger ?? null },
  };
}

// Newest successful run that has a `done` record for the same step → its IO.
async function findLastGoodStepIO(
  deps: DiagnosisContextDeps,
  spaceId: string,
  workflowId: string,
  nodeId: string,
  excludeRunId: string,
): Promise<{ output: unknown; resolvedInput: unknown } | undefined> {
  const recent = await deps.listRuns(spaceId, workflowId, 20).catch(() => []);
  for (const meta of recent) {
    if (meta.status !== "done" || meta.id === excludeRunId) continue;
    const good = await deps.getRun(spaceId, meta.id).catch(() => null);
    const step = good?.records.find((r) => r.nodeId === nodeId && r.status === "done");
    if (step) return { output: step.output, resolvedInput: step.resolvedInput };
  }
  return undefined;
}
