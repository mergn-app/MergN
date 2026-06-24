import { spawn } from "node:child_process";
import type {
  EndpointCustomMiddlewareRef,
  EndpointMiddlewareConfig,
} from "./store";
import type { RequestContext, MiddlewareOutcome } from "./builtin-middlewares";
import type { WorkspaceMiddlewareStore } from "./workspace-middlewares";

const PY_MW_RUNNER = `
import json
import traceback
import sys

def main():
    payload = json.load(sys.stdin)
    ns = {}
    try:
        exec(payload["source"], ns)
        fn = ns.get(payload.get("entrypoint") or "handle")
        if not callable(fn):
            raise RuntimeError("entrypoint not callable")
        out = fn(payload["context"])
        if out is None:
            out = {"continue": True}
        print(json.dumps(out))
    except Exception as e:
        print(json.dumps({"__error__": str(e), "__trace__": traceback.format_exc()}))

if __name__ == "__main__":
    main()
`.trim();

export async function runCustomMiddlewares(
  config: EndpointMiddlewareConfig | undefined,
  ctx: RequestContext,
  deps: {
    middlewareStore: WorkspaceMiddlewareStore;
    spaceId: string;
    timeoutMs?: number;
  },
): Promise<MiddlewareOutcome> {
  const refs = (config?.custom ?? [])
    .filter((r) => r.enabled)
    .sort((a, b) => a.order - b.order);
  let nextInput: Record<string, unknown> | undefined;
  for (const ref of refs) {
    const result = await runCustomMiddleware(ref, ctx, deps);
    if (!result.continue) return result;
    if (result.rewriteInput) nextInput = { ...(nextInput ?? {}), ...result.rewriteInput };
  }
  return nextInput ? { continue: true, rewriteInput: nextInput } : { continue: true };
}

async function runCustomMiddleware(
  ref: EndpointCustomMiddlewareRef,
  ctx: RequestContext,
  deps: {
    middlewareStore: WorkspaceMiddlewareStore;
    spaceId: string;
    timeoutMs?: number;
  },
): Promise<MiddlewareOutcome> {
  const row = await deps.middlewareStore.get(deps.spaceId, ref.middlewareId);
  if (!row) {
    return {
      continue: false,
      status: 500,
      body: { error: "middleware_missing", middlewareId: ref.middlewareId },
    };
  }
  if (row.version !== ref.version) {
    return {
      continue: false,
      status: 409,
      body: {
        error: "middleware_version_mismatch",
        middlewareId: ref.middlewareId,
        expected: ref.version,
        actual: row.version,
      },
    };
  }
  const timeoutMs = deps.timeoutMs ?? 5000;
  const child = spawn("python3", ["-c", PY_MW_RUNNER], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const payload = JSON.stringify({
    source: row.source,
    entrypoint: row.entrypoint,
    context: ctx,
  });
  child.stdin.write(payload);
  child.stdin.end();

  const stdout = await new Promise<string>((resolve, reject) => {
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("custom middleware timeout"));
    }, timeoutMs);
    child.stdout.on("data", (d) => {
      out += d.toString();
    });
    child.stderr.on("data", (d) => {
      err += d.toString();
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0 && !out.trim()) {
        reject(new Error(err || `python exited with code ${code}`));
        return;
      }
      resolve(out);
    });
  }).catch((e) => {
    return JSON.stringify({ __error__: e instanceof Error ? e.message : String(e) });
  });

  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(stdout.trim() || "{}") as Record<string, unknown>;
  } catch {
    return {
      continue: false,
      status: 500,
      body: { error: "middleware_invalid_json", middlewareId: ref.middlewareId },
    };
  }
  if (parsed.__error__) {
    return {
      continue: false,
      status: 500,
      body: {
        error: "middleware_runtime_error",
        middlewareId: ref.middlewareId,
        message: String(parsed.__error__),
      },
    };
  }
  const cont = parsed.continue;
  if (cont === false) {
    return {
      continue: false,
      status: typeof parsed.status === "number" ? parsed.status : 400,
      body: parsed.body ?? { error: "middleware_aborted", middlewareId: ref.middlewareId },
      headers:
        parsed.headers &&
        typeof parsed.headers === "object" &&
        !Array.isArray(parsed.headers)
          ? (parsed.headers as Record<string, string>)
          : undefined,
    };
  }
  return {
    continue: true,
    rewriteInput:
      parsed.rewriteInput &&
      typeof parsed.rewriteInput === "object" &&
      !Array.isArray(parsed.rewriteInput)
        ? (parsed.rewriteInput as Record<string, unknown>)
        : undefined,
  };
}
