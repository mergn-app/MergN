import type { StepStatus, Gate } from '../atoms/index'
import type { Workflow } from './graph'
import { dependenciesOf } from './graph'
import type { RunLogStore } from './log'
import type { Queue } from './queue'

export class Scheduler {
  constructor(
    private workflow: Workflow,
    private log: RunLogStore,
    private queue: Queue,
    // Max nodes enqueued per tick (run-safety back-pressure, injected by the
    // caller so the engine carries no policy). Default = no cap.
    private maxFanOut: number = Number.MAX_SAFE_INTEGER,
  ) {}

  async tick(runId: string): Promise<void> {
    const log = await this.log.get(runId)
    const status = new Map<string, StepStatus>()
    const output = new Map<string, unknown>()
    for (const record of log.records) {
      status.set(record.nodeId, record.status)
      output.set(record.nodeId, record.output)
    }

    // 1) propagate skips to a fixpoint: a node is SKIPPED when a dependency it
    // needs was skipped, or its own gate condition is false. Marking a node
    // skipped can skip its descendants, so loop until nothing changes. Skips are
    // written straight to the log (the node never runs — zero cost).
    let changed = true
    while (changed) {
      changed = false
      for (const node of this.workflow.nodes) {
        if (status.has(node.nodeId)) continue // already done/pending/failed/skipped
        const deps = dependenciesOf(node)
        // only decide once every dependency is resolved (done or skipped)
        const resolved = deps.every((d) => {
          const s = status.get(d)
          return s === 'done' || s === 'skipped'
        })
        if (!resolved) continue
        const deadDep = deps.some((d) => status.get(d) === 'skipped')
        const gateFails =
          !!node.gate && !gatePasses(node.gate, readRef(output, node.gate.ref))
        if (deadDep || gateFails) {
          status.set(node.nodeId, 'skipped')
          await this.log.append({
            runId,
            nodeId: node.nodeId,
            funcId: node.funcId,
            funcVersion: node.funcVersion,
            attempt: 1,
            status: 'skipped',
            resolvedInput: {},
          })
          changed = true
        }
      }
    }

    // 2) enqueue runnable nodes: all dependencies done, not already handled.
    // Bounded by maxFanOut per tick: excess ready nodes are simply re-evaluated
    // on a later tick (the queue dedups by runId+nodeId, so nothing is dropped
    // or double-processed). At the default no-cap this enqueues everything,
    // identical to before.
    let enqueued = 0
    for (const node of this.workflow.nodes) {
      if (enqueued >= this.maxFanOut) break
      const current = status.get(node.nodeId)
      if (current === 'done' || current === 'pending' || current === 'skipped')
        continue
      const ready = dependenciesOf(node).every((dep) => status.get(dep) === 'done')
      if (ready) {
        await this.queue.enqueue({ runId, nodeId: node.nodeId })
        enqueued++
      }
    }
  }
}

function gatePasses(gate: Gate, value: unknown): boolean {
  if (gate.equals !== undefined) return value === gate.equals
  if (gate.truthy !== undefined) return Boolean(value) === gate.truthy
  return true // no condition expressed → pass
}

function readRef(output: Map<string, unknown>, ref: string): unknown {
  const [nodeId, , ...rest] = ref.split('.')
  let current: unknown = output.get(nodeId)
  for (const seg of rest) {
    if (current && typeof current === 'object') {
      current = (current as Record<string, unknown>)[seg]
    } else {
      return undefined
    }
  }
  return current
}
