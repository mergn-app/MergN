import type { FuncDefinition, FuncContext } from "../atoms/index";
import type { Runtime } from "../engine/index";

// There is NO microsandbox in this project. The func source is sent to a separate
// code-exec service (an HTTP service embedding microsandbox on a KVM host) where it
// runs inside a microVM. Tokens don't leak, and the code runs isolated.
interface RunResult {
  ok: boolean;
  value?: unknown;
  error?: string;
}

interface ProviderPayload {
  name: string;
  clientSource: string;
  cred: Record<string, string>;
  egressDomain: string;
}

interface RemoteCarrier {
  __remoteProvider?: boolean;
  clientSource?: string;
  cred?: Record<string, string>;
  egressDomain?: string;
  dependencies?: string[];
}

// ctx.connections holds RemoteProviderCarrier objects (from RemoteConnectionsResolver),
// not live clients. Turn them into the `providers` payload the code-exec service
// expects. The code-exec service injects each secret via microsandbox `secretEnv`:
// the func code only ever sees an opaque placeholder, and the real value is
// substituted ONLY into outbound requests to the provider's own egress host —
// so a malicious/buggy func can't read or exfiltrate the credential.
function toProviders(connections: Record<string, unknown>): ProviderPayload[] {
  const out: ProviderPayload[] = [];
  for (const [name, value] of Object.entries(connections ?? {})) {
    const c = value as RemoteCarrier;
    if (!c?.__remoteProvider || !c.clientSource) continue;
    out.push({
      name,
      clientSource: c.clientSource,
      cred: c.cred ?? {},
      egressDomain: c.egressDomain ?? "",
    });
  }
  return out;
}

export class RemoteSandboxRuntime implements Runtime {
  private readonly url: string;
  private readonly token: string;
  private readonly timeoutSec: number;

  constructor() {
    this.url = (process.env.CODE_EXEC_URL || "http://localhost:5070").replace(/\/+$/, "");
    this.token = process.env.CODE_EXEC_TOKEN || "";
    const t = Number(process.env.CODE_TIMEOUT_SEC);
    this.timeoutSec = Number.isFinite(t) && t > 0 ? t : 30;
  }

  async run(
    def: FuncDefinition,
    ctx: FuncContext,
    input: Record<string, unknown>,
  ): Promise<unknown> {
    const providers = toProviders(ctx.connections);
    const dependencies = [
      ...(def.body.dependencies ?? []),
      ...Object.values(ctx.connections ?? {}).flatMap(
        (v) => (v as RemoteCarrier)?.dependencies ?? [],
      ),
    ].filter((v, i, a) => a.indexOf(v) === i);
    const res = await fetch(this.url + "/run", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer " + this.token,
      },
      body: JSON.stringify({
        language: def.body.language,
        source: def.body.source,
        input,
        idempotencyKey: ctx.idempotencyKey,
        timeoutSec: this.timeoutSec,
        providers: providers.length ? providers : undefined,
        dependencies: dependencies.length ? dependencies : undefined,
        // tenant identity — used by the code-exec service for per-tenant logging
        // and abuse detection only (never for execution)
        spaceId: ctx.spaceId,
        workflowId: ctx.workflowId,
      }),
    });

    if (!res.ok) {
      const txt = await res.text();
      throw new Error(`code-exec service ${res.status}: ${txt}`);
    }

    const data = (await res.json()) as RunResult;
    if (!data.ok) {
      throw new Error(data.error || "remote func execution failed");
    }
    return data.value;
  }
}
