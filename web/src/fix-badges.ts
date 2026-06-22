import type { WorkflowDiff } from "./queries";

// Maps a WorkflowDiff onto per-node badges — the visual "what did the fix change"
// layer. Pure + derived (never persisted). The 5-badge set is canonical.

export type FixBadge = "code" | "input" | "wire" | "gate" | "provider";

export const BADGE_SYMBOL: Record<FixBadge, string> = {
  code: "</>",
  input: "⊞",
  wire: "→",
  gate: "?",
  provider: "🔌",
};

export interface NodeBadges {
  nodeId: string;
  added?: boolean; // node introduced by the fix
  removed?: boolean; // node deleted by the fix
  badges: FixBadge[];
  detail: {
    inputs?: { added: string[]; removed: string[]; retyped: string[] };
    outputs?: { added: string[]; removed: string[] };
    gate?: "added" | "removed" | "changed";
  };
}

// server wireKey format: `${from}.${fromOutput}->${to}.${toInput}`
export function parseWireKey(key: string): { from: string; to: string } | null {
  const i = key.indexOf("->");
  if (i < 0) return null;
  const from = key.slice(0, i).split(".")[0];
  const to = key.slice(i + 2).split(".")[0];
  return from && to ? { from, to } : null;
}

// Compile per-node badges from a diff: added/removed nodes get a marker; modified
// nodes map their `changed` flags to badges (outputs fold into the input badge);
// a wire change attaches a `wire` badge to BOTH endpoints (an edge change affects
// both sides).
export function diffToNodeBadges(diff: WorkflowDiff): NodeBadges[] {
  const byId = new Map<string, NodeBadges>();
  const ensure = (id: string): NodeBadges => {
    let n = byId.get(id);
    if (!n) {
      n = { nodeId: id, badges: [], detail: {} };
      byId.set(id, n);
    }
    return n;
  };
  const add = (n: NodeBadges, b: FixBadge) => {
    if (!n.badges.includes(b)) n.badges.push(b);
  };

  for (const id of diff.nodes.added) ensure(id).added = true;
  for (const id of diff.nodes.removed) ensure(id).removed = true;

  for (const m of diff.nodes.modified) {
    const n = ensure(m.id);
    const c = m.changed;
    if (c.code) add(n, "code");
    if (c.inputs) {
      add(n, "input");
      n.detail.inputs = c.inputs;
    }
    if (c.outputs) {
      add(n, "input"); // I/O shape change folds into the input badge
      n.detail.outputs = c.outputs;
    }
    if (c.gate) {
      add(n, "gate");
      n.detail.gate = c.gate;
    }
    if (c.provider) add(n, "provider");
  }

  for (const key of [...diff.wires.added, ...diff.wires.removed]) {
    const p = parseWireKey(key);
    if (!p) continue;
    add(ensure(p.from), "wire");
    add(ensure(p.to), "wire");
  }

  return [...byId.values()];
}

// True when a diff has no node/wire/trigger changes (e.g. a deduped no-op fix).
export function isEmptyDiff(diff: WorkflowDiff): boolean {
  return (
    diff.nodes.added.length === 0 &&
    diff.nodes.removed.length === 0 &&
    diff.nodes.modified.length === 0 &&
    diff.wires.added.length === 0 &&
    diff.wires.removed.length === 0 &&
    !diff.trigger.changed
  );
}
