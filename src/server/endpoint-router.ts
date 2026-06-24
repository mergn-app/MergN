import type { SavedWorkflow, WorkflowStore } from "./store";

export interface ResolvedEndpoint {
  workflow: SavedWorkflow;
  pathParams: Record<string, string>;
}

export function matchHttpPath(
  pattern: string,
  path: string,
): { ok: boolean; params: Record<string, string>; score: number } {
  const left = pattern
    .split("/")
    .map((s) => s.trim())
    .filter(Boolean);
  const right = path
    .split("/")
    .map((s) => s.trim())
    .filter(Boolean);
  if (left.length !== right.length) return { ok: false, params: {}, score: -1 };
  const params: Record<string, string> = {};
  let score = 0;
  for (let i = 0; i < left.length; i += 1) {
    const p = left[i];
    const v = right[i];
    if (p.startsWith(":")) {
      params[p.slice(1)] = decodeURIComponent(v);
      continue;
    }
    if (p !== v) return { ok: false, params: {}, score: -1 };
    score += 2;
  }
  return { ok: true, params, score };
}

export async function resolveHttpEndpoint(
  workflows: WorkflowStore,
  spaceId: string,
  method: string,
  path: string,
): Promise<ResolvedEndpoint | null> {
  const metas = await workflows.listWorkflows(spaceId);
  let best: {
    wf: SavedWorkflow;
    params: Record<string, string>;
    score: number;
  } | null = null;
  const m = method.toUpperCase();
  for (const meta of metas) {
    const wf = await workflows.getWorkflow(spaceId, meta.id);
    if (!wf || wf.trigger?.kind !== "http") continue;
    const endpointMethod = (wf.endpoint?.method ?? wf.trigger.http?.method)?.toUpperCase();
    const endpointPath = wf.endpoint?.path ?? wf.trigger.http?.path;
    if (!endpointMethod || !endpointPath || endpointMethod !== m) continue;
    const matched = matchHttpPath(endpointPath, path);
    if (!matched.ok) continue;
    if (!best || matched.score > best.score) {
      best = { wf, params: matched.params, score: matched.score };
    }
  }
  return best ? { workflow: best.wf, pathParams: best.params } : null;
}
