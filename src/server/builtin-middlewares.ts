import type { RateLimiter } from "./ratelimit";
import type {
  EndpointRateLimitConfig,
  EndpointValidationConfig,
} from "./store";

export interface RequestContext {
  trigger: string;
  request: {
    method: string;
    path: string;
    ip?: string;
  };
  headers: Record<string, string>;
  pathParams: Record<string, string>;
  query: Record<string, string>;
  body: Record<string, unknown>;
  vars: Record<string, unknown>;
  auth: Record<string, unknown>;
  traceId: string;
}

export interface MiddlewareAbort {
  continue: false;
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

export interface MiddlewareContinue {
  continue: true;
  rewriteInput?: Record<string, unknown>;
}

export type MiddlewareOutcome = MiddlewareAbort | MiddlewareContinue;

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function validateJsonSchemaLike(
  schema: EndpointValidationConfig["schema"],
  body: Record<string, unknown>,
): string | null {
  const root = asObject(schema);
  const required = Array.isArray(root.required)
    ? root.required.filter((x): x is string => typeof x === "string")
    : [];
  const properties = asObject(root.properties);
  for (const key of required) {
    if (!(key in body)) return `missing required field: ${key}`;
  }
  for (const [key, spec] of Object.entries(properties)) {
    const value = body[key];
    if (value === undefined) continue;
    const t = asObject(spec).type;
    if (typeof t !== "string") continue;
    if (t === "array" && !Array.isArray(value)) return `invalid type for ${key}: expected array`;
    if (
      t !== "array" &&
      ((t === "number" && typeof value !== "number") ||
        (t === "string" && typeof value !== "string") ||
        (t === "boolean" && typeof value !== "boolean") ||
        (t === "object" &&
          (!value || typeof value !== "object" || Array.isArray(value))))
    ) {
      return `invalid type for ${key}: expected ${t}`;
    }
  }
  return null;
}

export async function runValidationMiddleware(
  config: EndpointValidationConfig,
  ctx: RequestContext,
): Promise<MiddlewareOutcome> {
  const message = validateJsonSchemaLike(config.schema, ctx.body ?? {});
  if (!message) return { continue: true };
  return {
    continue: false,
    status: config.failStatus ?? 400,
    body: { error: "validation_failed", message },
  };
}

export async function runRateLimitMiddleware(
  config: EndpointRateLimitConfig,
  ctx: RequestContext,
  deps: { rateLimiter: RateLimiter; spaceId: string; workflowId: string },
): Promise<MiddlewareOutcome> {
  const keyBase =
    config.key === "workspace"
      ? deps.spaceId
      : config.key === "endpoint"
        ? `${deps.spaceId}:${deps.workflowId}:${ctx.request.method}:${ctx.request.path}`
        : ctx.request.ip || ctx.headers["x-forwarded-for"] || "unknown";
  const result = await deps.rateLimiter.take(
    `endpoint:${keyBase}`,
    { windowMs: config.windowMs, limit: config.max },
    1,
  );
  if (result.ok) return { continue: true };
  return {
    continue: false,
    status: 429,
    body: { error: "rate_limited", retryAfterMs: result.retryAfterMs },
    headers: { "Retry-After": String(Math.ceil(result.retryAfterMs / 1000)) },
  };
}
