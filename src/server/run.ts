import type {
  FuncDefinition,
  FuncNode,
  Binding,
  Schema,
  FuncContext,
  ProviderClient,
  StepRecord,
  RunLog,
  DangerClass,
  IdempotencyMechanism,
} from "../atoms/index";
import type {
  Workflow,
  Runtime,
  ConnectionResolver,
  RunLogStore,
} from "../engine/index";
import {
  Scheduler,
  Worker,
  InMemoryQueue,
  InMemoryFuncRegistry,
} from "../engine/index";
import type { Registry } from "../providers/registry";
import type { Connections } from "./connections";
import { RemoteSandboxRuntime } from "./remote-sandbox-runtime";
import { LocalRuntime } from "./local-runtime";
import { resolveEgressHost } from "./egress";

export interface RunDeps {
  spaceId: string;
  registry: Registry;
  connections: Connections;
}

class NotifyingRunLog implements RunLogStore {
  private records: StepRecord[] = [];
  constructor(private onRecord?: (r: StepRecord) => Promise<void> | void) {}
  async append(record: StepRecord): Promise<void> {
    this.records.push(record);
    if (this.onRecord) await this.onRecord(record);
  }
  async get(runId: string): Promise<RunLog> {
    return { runId, records: this.records.filter((r) => r.runId === runId) };
  }
  async getStep(runId: string, nodeId: string): Promise<StepRecord | null> {
    const m = this.records.filter(
      (r) => r.runId === runId && r.nodeId === nodeId,
    );
    return m.length ? m[m.length - 1] : null;
  }
}

interface RunInput {
  name: string;
  role: "input" | "config";
  type: string;
  required: boolean;
}

interface RunFunc {
  id: string;
  version: number;
  kind: string;
  pure: boolean;
  inputs: RunInput[];
  outputSchema: Schema;
  bodySource: string;
  dependencies?: string[];
  requires: { name: string; provider: string; scopes: string[] }[];
  dangerClass: string | null;
  idempotency: { key: string; mechanism: string } | null;
}

interface RunWire {
  from: string;
  fromOutput: string;
  to: string;
  toInput: string;
}

function toSchema(type: string): Schema {
  switch (type) {
    case "number":
      return { type: "number" };
    case "boolean":
      return { type: "boolean" };
    case "array":
      return { type: "array" };
    case "string":
      return { type: "string" };
    default:
      return { type: "object" };
  }
}

function toDef(f: RunFunc): FuncDefinition {
  const inputs = f.inputs.map((p) => ({
    name: p.name,
    role: p.role,
    schema: toSchema(p.type),
    required: p.required,
  }));
  const body = {
    language: "javascript" as const,
    source: f.bodySource,
    dependencies: f.dependencies ?? [],
    generatedBy: { agent: "builder", prompt: f.id },
  };
  const kind = f.kind === "library" ? ("library" as const) : ("adapter" as const);
  if (f.pure) {
    return { id: f.id, version: f.version, kind, pure: true, inputs, outputSchema: f.outputSchema, body };
  }
  return {
    id: f.id,
    version: f.version,
    kind,
    pure: false,
    inputs,
    outputSchema: f.outputSchema,
    body,
    requires: f.requires,
    effect: {
      retryable: true,
      dangerClass: (f.dangerClass ?? "benign") as DangerClass,
      idempotency: {
        key: f.idempotency?.key ?? "runId+funcId",
        mechanism: (f.idempotency?.mechanism ?? "none") as IdempotencyMechanism,
      },
    },
  };
}

function coerce(type: string, raw: string): unknown {
  if (type === "number") {
    const n = Number(raw);
    return Number.isNaN(n) ? raw : n;
  }
  if (type === "boolean") return raw === "true";
  return raw;
}

function toNode(
  f: RunFunc,
  wires: RunWire[],
  config: Record<string, string>,
  nodeConnections: Record<string, string>,
): FuncNode {
  const bindings: Record<string, Binding> = {};
  for (const p of f.inputs) {
    const cfg = config[p.name];
    if (cfg !== undefined && cfg !== "") {
      bindings[p.name] = { mode: "literal", value: coerce(p.type, cfg) };
      continue;
    }
    const w = wires.find((x) => x.to === f.id && x.toInput === p.name);
    if (!w) continue;
    bindings[p.name] = {
      mode: "ref",
      path: w.fromOutput
        ? `${w.from}.output.${w.fromOutput}`
        : `${w.from}.output`,
    };
  }
  const connections: Record<string, string> = {};
  const connectionIds: Record<string, string> = {};
  if (!f.pure)
    for (const r of f.requires) {
      connections[r.name] = r.provider;
      const cid = nodeConnections[r.name];
      if (cid) connectionIds[r.name] = cid;
    }
  return {
    nodeId: f.id,
    funcId: f.id,
    funcVersion: f.version,
    bindings,
    connections,
    connectionIds,
    dependsOn: [],
  };
}

export interface RemoteProviderCarrier {
  __remoteProvider: true;
  clientSource: string;
  cred?: Record<string, string>;
  egressDomain?: string;
  dependencies?: string[];
}

// Resolves each declared connection to a carrier (clientSource + cred + egressDomain
// + dependencies). The cred is resolved host-side (stored connection or env). Both runtimes
// consume carriers: LocalRuntime builds the client on the host, RemoteSandboxRuntime
// forwards them to the microVM. The provider client itself is built inside the runtime.
class CarrierConnectionsResolver implements ConnectionResolver {
  constructor(private deps: RunDeps) {}
  async inject(node: FuncNode): Promise<Record<string, ProviderClient>> {
    const { spaceId, registry, connections } = this.deps;
    const out: Record<string, ProviderClient> = {};
    for (const [name, provider] of Object.entries(node.connections)) {
      const spec = registry.getProvider(spaceId, provider);
      if (!spec?.clientSource) continue;
      const connId = node.connectionIds?.[name];
      let cred = await connections.getCredential(spaceId, provider, connId);
      if (!cred && spec.env) {
        const envValue = process.env[spec.env];
        if (envValue !== undefined) cred = { value: envValue };
      }
      const eg = resolveEgressHost(spec.sandbox, cred ?? undefined);
      if (eg.error) throw new Error(`connection ${provider}: ${eg.error}`);
      const carrier: RemoteProviderCarrier = {
        __remoteProvider: true,
        clientSource: spec.clientSource,
        cred: cred ?? undefined,
        egressDomain: eg.host,
        dependencies: spec.dependencies ?? [],
      };
      out[name] = carrier;
    }
    return out;
  }
}

export async function runWorkflow(
  deps: RunDeps,
  funcs: RunFunc[],
  wires: RunWire[],
  input: Record<string, unknown>,
  config: Record<string, Record<string, string>> = {},
  nodeConnections: Record<string, Record<string, string>> = {},
  onRecord?: (r: StepRecord) => Promise<void> | void,
  seed?: StepRecord[],
): Promise<StepRecord[]> {
  const registry = new InMemoryFuncRegistry();
  const nodes: FuncNode[] = [];
  for (const f of funcs) {
    registry.register(toDef(f));
    nodes.push(toNode(f, wires, config[f.id] ?? {}, nodeConnections[f.id] ?? {}));
  }

  const workflow: Workflow = { id: "run", nodes };
  const queue = new InMemoryQueue();
  const log = new NotifyingRunLog(onRecord);
  const scheduler = new Scheduler(workflow, log, queue);

  const isRemote = process.env.CODE_RUNTIME === "remote";
  if (process.env.NODE_ENV === "production" && !isRemote) {
    throw new Error(
      "refusing to execute workflow code in-process in production: set CODE_RUNTIME=remote (sandboxed execution required)",
    );
  }
  const runtime: Runtime = isRemote
    ? new RemoteSandboxRuntime()
    : new LocalRuntime();
  const resolver: ConnectionResolver = new CarrierConnectionsResolver(deps);

  const worker = new Worker(
    workflow,
    registry,
    resolver,
    runtime,
    log,
    queue,
    scheduler,
  );

  const runId = "run";
  if (seed && seed.length) {
    for (const record of seed) await log.append({ ...record, runId });
  } else {
    await log.append({
      runId,
      nodeId: "trigger",
      funcId: "trigger",
      funcVersion: 1,
      attempt: 1,
      status: "done",
      resolvedInput: {},
      output: input,
    });
  }
  await scheduler.tick(runId);

  let item = await queue.pop();
  let guard = 0;
  while (item && guard++ < 1000) {
    const current = item;
    await new Promise((r) => setTimeout(r, 180));
    try {
      await worker.process(current);
    } catch (e) {
      const node = nodes.find((n) => n.nodeId === current.nodeId);
      const prev = await log.getStep(runId, current.nodeId);
      await log.append({
        runId,
        nodeId: current.nodeId,
        funcId: node?.funcId ?? "?",
        funcVersion: node?.funcVersion ?? 1,
        attempt: 1,
        status: "failed",
        resolvedInput: prev?.resolvedInput ?? {},
        error: e instanceof Error ? e.message : String(e),
      });
    }
    item = await queue.pop();
  }

  return (await log.get(runId)).records;
}
