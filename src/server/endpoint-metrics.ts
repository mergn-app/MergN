export interface EndpointMetricRow {
  workflowId: string;
  method: string;
  path: string;
  count: number;
  failures: number;
  middlewareAborts: number;
  lastLatencyMs: number;
  updatedAt: string;
}

const rows = new Map<string, EndpointMetricRow>();

export function recordEndpointMetric(input: {
  workflowId: string;
  method: string;
  path: string;
  latencyMs: number;
  failed?: boolean;
  middlewareAbort?: boolean;
}): void {
  const key = `${input.workflowId}:${input.method}:${input.path}`;
  const prev = rows.get(key);
  rows.set(key, {
    workflowId: input.workflowId,
    method: input.method,
    path: input.path,
    count: (prev?.count ?? 0) + 1,
    failures: (prev?.failures ?? 0) + (input.failed ? 1 : 0),
    middlewareAborts: (prev?.middlewareAborts ?? 0) + (input.middlewareAbort ? 1 : 0),
    lastLatencyMs: input.latencyMs,
    updatedAt: new Date().toISOString(),
  });
}

export function listEndpointMetrics(): EndpointMetricRow[] {
  return [...rows.values()].sort((a, b) =>
    a.updatedAt < b.updatedAt ? 1 : -1,
  );
}
