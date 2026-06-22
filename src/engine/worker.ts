import type {
  FuncNode,
  FuncDefinition,
  EffectfulFunc,
  FuncContext,
  ProviderClient,
  StepRecord,
  StepStatus,
} from '../atoms/index'
import type { Workflow } from './graph'
import type { RunLogStore } from './log'
import type { Queue, QueueItem } from './queue'
import type { Scheduler } from './scheduler'
import { eventHash, type IdempotencyStore } from './idempotency'

// Per-run identity + idempotency wiring, injected by runWorkflow. `runKey` is
// the REAL run id (the engine's internal log uses a fixed "run" id, which must
// never be the idempotency key — it would collide across every run). Absent on
// the legacy path → no dedup (behaviour unchanged).
export interface RunSafety {
  spaceId: string
  runKey: string
  idempotency?: IdempotencyStore
}

export interface FuncRegistry {
  get(funcId: string, version: number): Promise<FuncDefinition>
}

export interface ConnectionResolver {
  inject(node: FuncNode): Promise<Record<string, ProviderClient>>
}

export interface Runtime {
  run(
    def: FuncDefinition,
    ctx: FuncContext,
    input: Record<string, unknown>,
  ): Promise<unknown>
}

export class Worker {
  constructor(
    private workflow: Workflow,
    private registry: FuncRegistry,
    private connections: ConnectionResolver,
    private runtime: Runtime,
    private log: RunLogStore,
    private queue: Queue,
    private scheduler: Scheduler,
    private safety?: RunSafety,
  ) {}

  async process(item: QueueItem): Promise<void> {
    const existing = await this.log.getStep(item.runId, item.nodeId)
    if (existing?.status === 'done') {
      await this.queue.ack(item)
      return
    }

    const node = this.findNode(item.nodeId)
    const def = await this.registry.get(node.funcId, node.funcVersion)
    const input = await this.resolveInput(item.runId, node)
    const key = `${item.runId}:${node.funcId}`

    if (def.pure) {
      const output = await this.runtime.run(def, { idempotencyKey: key, connections: {}, spaceId: this.safety?.spaceId, workflowId: this.workflow.id }, input)
      await this.log.append(this.record(item, node, 'done', input, output, key))
    } else {
      await this.log.append(this.record(item, node, 'pending', input, undefined, key))
      const output = await this.executeEffect(node, def, input, key)
      await this.log.append(this.record(item, node, 'done', input, output, key))
    }

    await this.queue.ack(item)
    await this.scheduler.tick(item.runId)
  }

  // Runs an effectful step's side-effect, guarded by idempotency when the func
  // opts in (mechanism !== "none") and a store is wired. On a dedup hit the
  // side-effect is NOT re-fired — the recorded output is reused. Otherwise it
  // runs and the output is sealed under the (real runId, funcId, eventHash) key.
  private async executeEffect(
    node: FuncNode,
    def: EffectfulFunc,
    input: Record<string, unknown>,
    key: string,
  ): Promise<unknown> {
    const idem = this.safety?.idempotency
    const guarded = !!idem && def.effect.idempotency.mechanism !== 'none'
    const ik = guarded
      ? { runId: this.safety!.runKey, funcId: node.funcId, eventHash: eventHash(input) }
      : undefined
    if (idem && ik) {
      const claim = await idem.claim(this.safety!.spaceId, ik)
      if (!claim.claimed) return claim.cachedOutput // already done — don't re-fire
    }
    const clients = await this.connections.inject(node)
    const ctx: FuncContext = { idempotencyKey: key, connections: clients, spaceId: this.safety?.spaceId, workflowId: this.workflow.id }
    const output = await this.runtime.run(def, ctx, input)
    if (idem && ik) await idem.complete(this.safety!.spaceId, ik, output)
    return output
  }

  private findNode(nodeId: string): FuncNode {
    const node = this.workflow.nodes.find((candidate) => candidate.nodeId === nodeId)
    if (!node) throw new Error(`node not found: ${nodeId}`)
    return node
  }

  private async resolveInput(
    runId: string,
    node: FuncNode,
  ): Promise<Record<string, unknown>> {
    const input: Record<string, unknown> = {}
    for (const [name, binding] of Object.entries(node.bindings)) {
      if (binding.mode === 'literal') input[name] = binding.value
      else input[name] = await this.readRef(runId, binding.path)
    }
    return input
  }

  private async readRef(runId: string, path: string): Promise<unknown> {
    const [nodeId, , ...rest] = path.split('.')
    const step = await this.log.getStep(runId, nodeId)
    return pick(step?.output, rest)
  }

  private record(
    item: QueueItem,
    node: FuncNode,
    status: StepStatus,
    input: Record<string, unknown>,
    output: unknown,
    key: string,
  ): StepRecord {
    return {
      runId: item.runId,
      nodeId: node.nodeId,
      funcId: node.funcId,
      funcVersion: node.funcVersion,
      attempt: 1,
      status,
      idempotencyKey: key,
      resolvedInput: input,
      output,
    }
  }
}

function pick(value: unknown, path: string[]): unknown {
  let current = value
  for (const segment of path) {
    if (current && typeof current === 'object') {
      current = (current as Record<string, unknown>)[segment]
    } else {
      return undefined
    }
  }
  return current
}
