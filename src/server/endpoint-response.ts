export interface EndpointResponse {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

export function successResponse(
  mode: "sync" | "async" | undefined,
  run: { id: string; status: string; records?: unknown[] },
): EndpointResponse {
  if (mode === "async") {
    return {
      status: 202,
      body: { accepted: true, runId: run.id, status: run.status },
    };
  }
  return {
    status: 200,
    body: {
      ok: run.status !== "failed",
      runId: run.id,
      status: run.status,
      records: run.records ?? [],
    },
  };
}

export function errorResponse(
  status: number,
  error: string,
  detail?: unknown,
): EndpointResponse {
  return {
    status,
    body: detail === undefined ? { error } : { error, detail },
  };
}
