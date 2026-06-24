import test from "node:test";
import assert from "node:assert/strict";
import {
  runRateLimitMiddleware,
  runValidationMiddleware,
  type RequestContext,
} from "./builtin-middlewares";
import { createMemoryRateLimiter } from "./ratelimit";

function ctx(body: Record<string, unknown>): RequestContext {
  return {
    trigger: "http",
    request: { method: "POST", path: "/demo", ip: "127.0.0.1" },
    headers: {},
    pathParams: {},
    query: {},
    body,
    vars: {},
    auth: {},
    traceId: "test",
  };
}

test("validation middleware rejects missing required fields", async () => {
  const result = await runValidationMiddleware(
    {
      schemaType: "json-schema",
      schema: {
        type: "object",
        required: ["email"],
        properties: { email: { type: "string" } },
      },
    },
    ctx({}),
  );
  assert.equal(result.continue, false);
});

test("rate limit middleware returns 429 after quota", async () => {
  const limiter = createMemoryRateLimiter();
  const config = { key: "ip" as const, windowMs: 1_000, max: 1 };
  const first = await runRateLimitMiddleware(config, ctx({}), {
    rateLimiter: limiter,
    spaceId: "s",
    workflowId: "w",
  });
  assert.equal(first.continue, true);
  const second = await runRateLimitMiddleware(config, ctx({}), {
    rateLimiter: limiter,
    spaceId: "s",
    workflowId: "w",
  });
  assert.equal(second.continue, false);
});
