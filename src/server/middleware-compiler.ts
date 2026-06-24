import type { RateLimiter } from "./ratelimit";
import type {
  EndpointMetadata,
  EndpointMiddlewareConfig,
  SavedWorkflow,
} from "./store";
import type {
  MiddlewareAbort,
  MiddlewareContinue,
  MiddlewareOutcome,
  RequestContext,
} from "./builtin-middlewares";
import {
  runRateLimitMiddleware,
  runValidationMiddleware,
} from "./builtin-middlewares";
import { runCustomMiddlewares } from "./custom-middleware-runtime";
import type { WorkspaceMiddlewareStore } from "./workspace-middlewares";

export interface EndpointPlan {
  triggerKind: "http" | "webhook" | "schedule";
  endpoint?: EndpointMetadata;
  middleware: EndpointMiddlewareConfig;
}

export interface CompiledExecutionResult {
  continue: boolean;
  rewrittenInput?: Record<string, unknown>;
  response?: {
    status: number;
    body: unknown;
    headers?: Record<string, string>;
  };
}

export function compileEndpointPlan(workflow: SavedWorkflow): EndpointPlan {
  return {
    triggerKind:
      workflow.trigger?.kind === "webhook" || workflow.trigger?.kind === "schedule"
        ? workflow.trigger.kind
        : "http",
    endpoint: workflow.endpoint,
    middleware: workflow.middleware ?? { custom: [] },
  };
}

function toAbort(out: MiddlewareAbort): CompiledExecutionResult {
  return {
    continue: false,
    response: { status: out.status, body: out.body, headers: out.headers },
  };
}

function toContinue(out: MiddlewareContinue): CompiledExecutionResult {
  return { continue: true, rewrittenInput: out.rewriteInput };
}

export async function executeCompiledPlan(
  plan: EndpointPlan,
  ctx: RequestContext,
  deps: {
    rateLimiter: RateLimiter;
    middlewareStore: WorkspaceMiddlewareStore;
    spaceId: string;
    workflowId: string;
  },
): Promise<CompiledExecutionResult> {
  const builtins = plan.middleware.builtins;
  if (builtins?.rateLimit) {
    const out = await runRateLimitMiddleware(builtins.rateLimit, ctx, {
      rateLimiter: deps.rateLimiter,
      spaceId: deps.spaceId,
      workflowId: deps.workflowId,
    });
    if (!out.continue) return toAbort(out);
  }
  if (builtins?.validation) {
    const out = await runValidationMiddleware(builtins.validation, ctx);
    if (!out.continue) return toAbort(out);
  }
  const custom = await runCustomMiddlewares(plan.middleware, ctx, {
    middlewareStore: deps.middlewareStore,
    spaceId: deps.spaceId,
  });
  if (!custom.continue) return toAbort(custom as MiddlewareAbort);
  return toContinue(custom as MiddlewareContinue);
}

export function mergeInput(
  base: Record<string, unknown>,
  rewritten?: Record<string, unknown>,
): Record<string, unknown> {
  if (!rewritten) return base;
  return { ...base, ...rewritten };
}

export type { RequestContext, MiddlewareOutcome };
