import { mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import dns from "node:dns/promises";
import net from "node:net";
import type { FuncDefinition, FuncContext } from "../atoms/index";
import type { Runtime } from "../engine/index";

// Block requests that resolve to internal/loopback/link-local/private ranges
// (SSRF guard — e.g. cloud metadata 169.254.169.254 or an internal service).
function ipBlocked(ip: string): boolean {
  if (ip.startsWith("::ffff:")) ip = ip.slice(7);
  const v = net.isIP(ip);
  if (v === 4) {
    const o = ip.split(".").map(Number);
    if (o[0] === 0 || o[0] === 127 || o[0] === 10) return true;
    if (o[0] === 169 && o[1] === 254) return true;
    if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return true;
    if (o[0] === 192 && o[1] === 168) return true;
    if (o[0] === 100 && o[1] >= 64 && o[1] <= 127) return true;
    return false;
  }
  if (v === 6) {
    const lo = ip.toLowerCase();
    if (lo === "::1" || lo === "::") return true;
    if (lo.startsWith("fc") || lo.startsWith("fd")) return true;
    if (/^fe[89ab]/.test(lo)) return true;
    return false;
  }
  return true;
}
async function assertPublicHost(host: string): Promise<void> {
  const h = host.replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
  if (net.isIP(h)) {
    if (ipBlocked(h)) throw new Error(`egress blocked: internal address ${h}`);
    return;
  }
  let addrs;
  try {
    addrs = await dns.lookup(h, { all: true });
  } catch {
    throw new Error(`egress blocked: cannot resolve ${h}`);
  }
  for (const a of addrs)
    if (ipBlocked(a.address))
      throw new Error(`egress blocked: ${h} resolves to internal ${a.address}`);
}

interface Carrier {
  __remoteProvider?: boolean;
  clientSource?: string;
  cred?: Record<string, string>;
  egressDomain?: string;
  dependencies?: string[];
}

interface ResolvedProvider {
  name: string;
  clientSource: string;
  cred: Record<string, string>;
  egressDomain?: string;
}

function guardedFetch(domain?: string) {
  return async (i: unknown, init?: unknown): Promise<Response> => {
    const url =
      typeof i === "string"
        ? i
        : i instanceof URL
          ? i.href
          : i instanceof Request
            ? i.url
            : String(i);
    let host: string;
    try {
      host = new URL(url).host;
    } catch {
      throw new Error("egress blocked: invalid url");
    }
    const bare = host.replace(/:\d+$/, "");
    if (domain && bare !== domain && !host.endsWith(`.${domain}`)) {
      throw new Error(`egress blocked: ${host} (allowed: ${domain})`);
    }
    await assertPublicHost(host);
    return fetch(url, init as RequestInit | undefined);
  };
}

const PYTHON = process.env.PYTHON_BIN ?? "python3";
const TIMEOUT_SEC = Number(process.env.CODE_TIMEOUT_SEC ?? 30);
const PY_RUNNER = `
import asyncio
import json
import sys
import traceback

class AttrDict(dict):
    def __getattr__(self, key):
        try:
            return self[key]
        except KeyError as exc:
            raise AttributeError(key) from exc
    def __setattr__(self, key, value):
        self[key] = value

def to_attr(value):
    if isinstance(value, dict):
        out = AttrDict()
        for k, v in value.items():
            out[k] = to_attr(v)
        return out
    if isinstance(value, list):
        return [to_attr(v) for v in value]
    return value

def to_plain(value):
    if isinstance(value, AttrDict):
        return {k: to_plain(v) for k, v in value.items()}
    if isinstance(value, dict):
        return {k: to_plain(v) for k, v in value.items()}
    if isinstance(value, list):
        return [to_plain(v) for v in value]
    return value

def send(message):
    sys.stdout.write(json.dumps(message, ensure_ascii=False) + "\\n")
    sys.stdout.flush()

def recv():
    line = sys.stdin.readline()
    if not line:
        raise RuntimeError("runtime disconnected")
    return json.loads(line)

class ProviderProxy:
    def __init__(self, provider):
        self._provider = provider
    def __getattr__(self, method):
        def call(*args, **kwargs):
            rid = f"{self._provider}:{method}"
            send({
                "type": "call",
                "id": rid,
                "provider": self._provider,
                "method": method,
                "args": to_plain(list(args)),
                "kwargs": to_plain(kwargs),
            })
            response = recv()
            if response.get("type") != "call_result":
                raise RuntimeError("invalid runtime response")
            if not response.get("ok", False):
                raise RuntimeError(str(response.get("error", "provider call failed")))
            return to_attr(response.get("value"))
        return call

class ConnectionsProxy:
    def __getattr__(self, provider):
        return ProviderProxy(provider)

class Ctx:
    def __init__(self, idempotency_key):
        self.idempotencyKey = idempotency_key
        self.connections = ConnectionsProxy()

def main():
    boot = recv()
    source = str(boot.get("source", ""))
    input_data = to_attr(boot.get("input") or {})
    ctx = Ctx(str(boot.get("idempotencyKey", "")))
    env = {}
    try:
        exec(source, env, env)
        fn = env.get("run")
        if not callable(fn):
            raise RuntimeError("func must define run(ctx, input)")
        out = fn(ctx, input_data)
        if asyncio.iscoroutine(out):
            out = asyncio.run(out)
        send({"type": "result", "value": to_plain(out)})
    except Exception as exc:
        send({"type": "error", "error": f"{exc}\\n{traceback.format_exc()}"})

if __name__ == "__main__":
    main()
`;

async function invokePython(
  source: string,
  idempotencyKey: string,
  input: Record<string, unknown>,
  clients: Record<string, unknown>,
): Promise<unknown> {
  const runDir = join(tmpdir(), "fb-local", randomUUID());
  await mkdir(runDir, { recursive: true });
  const runner = join(runDir, "runner.py");
  await writeFile(runner, PY_RUNNER);
  return new Promise<unknown>((resolve, reject) => {
    const proc = spawn(PYTHON, ["-u", runner], { cwd: runDir, env: process.env });
    const rl = createInterface({ input: proc.stdout });
    let stderr = "";
    let done = false;
    const timeout = setTimeout(() => {
      if (done) return;
      done = true;
      proc.kill("SIGKILL");
      reject(new Error(`code execution timed out after ${TIMEOUT_SEC}s`));
    }, TIMEOUT_SEC * 1000);
    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(timeout);
      rl.close();
      fn();
    };
    proc.stderr.on("data", (d) => (stderr += String(d)));
    rl.on("line", async (line) => {
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      if (msg?.type === "call") {
        const provider = String(msg.provider ?? "");
        const method = String(msg.method ?? "");
        const id = String(msg.id ?? "");
        try {
          const target = (clients[provider] as Record<string, unknown> | undefined)?.[method];
          if (typeof target !== "function") {
            throw new Error(`provider method not found: ${provider}.${method}`);
          }
          const args = Array.isArray(msg.args) ? msg.args : [];
          const kwargs = msg.kwargs && typeof msg.kwargs === "object" ? msg.kwargs : {};
          const hasKwargs = Object.keys(kwargs).length > 0;
          const value = await (target as (...a: unknown[]) => Promise<unknown> | unknown)(
            ...(hasKwargs ? [...args, kwargs] : args),
          );
          proc.stdin.write(
            JSON.stringify({ type: "call_result", id, ok: true, value }) + "\n",
          );
        } catch (err) {
          proc.stdin.write(
            JSON.stringify({
              type: "call_result",
              id,
              ok: false,
              error: err instanceof Error ? err.message : String(err),
            }) + "\n",
          );
        }
        return;
      }
      if (msg?.type === "result") {
        finish(() => resolve(msg.value));
        proc.kill();
        return;
      }
      if (msg?.type === "error") {
        finish(() => reject(new Error(String(msg.error ?? "python execution failed"))));
        proc.kill();
      }
    });
    proc.on("error", (err) => finish(() => reject(err)));
    proc.on("close", (code) => {
      if (done) return;
      const extra = stderr.trim() ? `: ${stderr.trim().slice(-600)}` : "";
      finish(() => reject(new Error(`python runtime exited with code ${code ?? 1}${extra}`)));
    });
    proc.stdin.write(JSON.stringify({ source, idempotencyKey, input }) + "\n");
  }).finally(async () => {
    await rm(runDir, { recursive: true, force: true }).catch(() => {});
  });
}

export class LocalRuntime implements Runtime {
  async run(
    def: FuncDefinition,
    ctx: FuncContext,
    input: Record<string, unknown>,
  ): Promise<unknown> {
    const providers: ResolvedProvider[] = [];
    for (const [name, value] of Object.entries(ctx.connections ?? {})) {
      const c = value as Carrier;
      if (!c?.__remoteProvider || !c.clientSource) continue;
      providers.push({ name, clientSource: c.clientSource, cred: c.cred ?? {}, egressDomain: c.egressDomain });
    }

    const runDir = join(tmpdir(), "fb-local-providers", randomUUID());
    await mkdir(join(runDir, "providers"), { recursive: true });

    try {
      const connections: Record<string, unknown> = {};
      for (let i = 0; i < providers.length; i++) {
        const p = providers[i];
        const file = join(runDir, "providers", `p${i}.mjs`);
        await writeFile(file, p.clientSource);
        const mod = await import(pathToFileURL(file).href);
        if (typeof mod.default !== "function") {
          throw new Error(`provider ${p.name} must export default a factory function`);
        }
        connections[p.name] = await mod.default(p.cred, guardedFetch(p.egressDomain));
      }

      return await invokePython(def.body.source, ctx.idempotencyKey, input, connections);
    } finally {
      await rm(runDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}
