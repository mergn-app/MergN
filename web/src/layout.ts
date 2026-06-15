import dagre from "@dagrejs/dagre";
import type { AuthoredFunc, Wire, TriggerConfig } from "./types";

const NODE_W = 288; // FuncNode is w-72
const TRIGGER_W = 180;

// FuncNode height grows with its taller input/output column.
function estHeight(f: AuthoredFunc): number {
  const inCount = f.inputs.length;
  const outCount =
    Object.keys(f.outputSchema?.properties ?? {}).length ||
    (f.outputSchema?.required?.length ?? 0);
  return 92 + Math.max(inCount, outCount, 1) * 24;
}

// Layered left-to-right layout: X = dependency depth (so a producer always sits
// left of its consumer), Y = crossing-minimised order within each layer. Folds in
// data wires, implicit trigger event-field edges, and conditional gate edges so
// the picture matches the real flow. Returns top-left positions by node id.
export function layoutPositions(
  funcs: AuthoredFunc[],
  wires: Wire[],
  trigger: TriggerConfig,
): Record<string, { x: number; y: number }> {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: "LR", nodesep: 36, ranksep: 96, marginx: 24, marginy: 24 });
  g.setDefaultEdgeLabel(() => ({}));

  const ids = new Set(funcs.map((f) => f.id));
  const showTrigger = trigger.kind !== "manual";
  if (showTrigger) g.setNode("trigger", { width: TRIGGER_W, height: 80 });
  for (const f of funcs) g.setNode(f.id, { width: NODE_W, height: estHeight(f) });

  const seen = new Set<string>();
  const addEdge = (a: string, b: string) => {
    if (a === b || !g.hasNode(a) || !g.hasNode(b)) return;
    const k = `${a}->${b}`;
    if (seen.has(k)) return;
    seen.add(k);
    g.setEdge(a, b);
  };

  for (const w of wires) if (ids.has(w.to)) addEdge(w.from, w.to);

  const eventFields = trigger.eventFields ?? [];
  if (showTrigger) {
    for (const f of funcs) {
      for (const p of f.inputs) {
        if (p.role === "config" || !eventFields.includes(p.name)) continue;
        if (wires.some((w) => w.to === f.id && w.toInput === p.name)) continue;
        addEdge("trigger", f.id);
      }
    }
  }
  for (const f of funcs) {
    if (f.gate?.ref) addEdge(String(f.gate.ref).split(".")[0], f.id);
  }

  dagre.layout(g);

  const out: Record<string, { x: number; y: number }> = {};
  const all = showTrigger ? ["trigger", ...ids] : [...ids];
  for (const id of all) {
    if (!g.hasNode(id)) continue;
    const n = g.node(id);
    if (n) {
      out[id] = {
        x: Math.round(n.x - n.width / 2),
        y: Math.round(n.y - n.height / 2),
      };
    }
  }
  return out;
}
