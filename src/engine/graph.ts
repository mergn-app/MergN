import type { FuncNode } from '../atoms/index'

export interface Workflow {
  id: string
  nodes: FuncNode[]
}

export function dependenciesOf(node: FuncNode): string[] {
  const refDeps: string[] = []
  for (const binding of Object.values(node.bindings)) {
    if (binding.mode === 'ref') refDeps.push(binding.path.split('.')[0])
  }
  // the gate reads an upstream output, so its source node must run first too
  if (node.gate?.ref) refDeps.push(node.gate.ref.split('.')[0])
  return [...new Set([...refDeps, ...node.dependsOn])]
}

// Reverse reachability: every node DOWNSTREAM of any seed — i.e. that
// transitively depends on a seed — excluding the seeds themselves. Built by
// inverting the same edges `dependenciesOf` reads (dep → dependents), then a
// forward BFS from the seeds. This is the single shared helper for "what would
// a change to these nodes affect" — the danger-downstream and danger-check
// passes both reuse it, so there is exactly one reverse-reachability impl.
export function downstreamOf(
  nodes: FuncNode[],
  seedIds: Iterable<string>,
): Set<string> {
  const dependents = new Map<string, string[]>()
  for (const node of nodes) {
    for (const dep of dependenciesOf(node)) {
      const list = dependents.get(dep)
      if (list) list.push(node.nodeId)
      else dependents.set(dep, [node.nodeId])
    }
  }
  const out = new Set<string>()
  const stack = [...seedIds]
  while (stack.length) {
    const id = stack.pop() as string
    for (const child of dependents.get(id) ?? []) {
      if (!out.has(child)) {
        out.add(child)
        stack.push(child)
      }
    }
  }
  return out
}
