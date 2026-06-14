import type { AuthoredFunc, Wire } from "./types";

export type Source =
  | { kind: "trigger" }
  | { kind: "step"; num: number; title: string; output: string }
  | { kind: "unbound" };

export function orderFuncs(funcs: AuthoredFunc[], wires: Wire[]): AuthoredFunc[] {
  const byId = new Map(funcs.map((f) => [f.id, f]));
  const indeg = new Map(funcs.map((f) => [f.id, 0]));
  const adj = new Map<string, string[]>();
  for (const w of wires) {
    if (w.from === "trigger" || w.from === w.to) continue;
    if (!byId.has(w.from) || !byId.has(w.to)) continue;
    adj.set(w.from, [...(adj.get(w.from) ?? []), w.to]);
    indeg.set(w.to, (indeg.get(w.to) ?? 0) + 1);
  }
  const queue = funcs.filter((f) => (indeg.get(f.id) ?? 0) === 0).map((f) => f.id);
  const seen = new Set<string>();
  const out: AuthoredFunc[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(byId.get(id)!);
    for (const n of adj.get(id) ?? []) {
      indeg.set(n, (indeg.get(n) ?? 0) - 1);
      if ((indeg.get(n) ?? 0) <= 0) queue.push(n);
    }
  }
  for (const f of funcs) if (!seen.has(f.id)) out.push(f);
  return out;
}

export function outputsOf(f: AuthoredFunc): string[] {
  const props = f.outputSchema?.properties;
  if (props && Object.keys(props).length) return Object.keys(props);
  return f.outputSchema?.required ?? [];
}

export function summarizeWorkflow(
  funcs: AuthoredFunc[],
  wires: Wire[],
  configValues: Record<string, Record<string, string>>,
): string {
  if (funcs.length === 0) return "";

  const triggerFields = new Set<string>();
  for (const w of wires) {
    if (w.from === "trigger" && w.fromOutput) triggerFields.add(w.fromOutput);
  }

  const lines: string[] = [];
  if (triggerFields.size)
    lines.push(`trigger fields: ${[...triggerFields].join(", ")}`);

  for (const f of funcs) {
    const tag = f.pure ? "pure" : (f.requires[0]?.provider ?? "effectful");
    lines.push(`[${f.id}] "${f.title}" ${tag}`);
    if (f.inputs.length) {
      const ins = f.inputs.map((p) => {
        const w = wires.find((x) => x.to === f.id && x.toInput === p.name);
        let src = "UNWIRED";
        if (w) {
          src = w.from === "trigger" ? "trigger" : `${w.from}.${w.fromOutput}`;
        } else if ((configValues[f.id] ?? {})[p.name]) {
          src = "trigger";
        }
        return `${p.name}<-${src}`;
      });
      lines.push(`  in: ${ins.join(", ")}`);
    }
    const outs = outputsOf(f);
    if (outs.length) lines.push(`  out: ${outs.join(", ")}`);
  }

  return lines.join("\n");
}

export function lineage(
  funcs: AuthoredFunc[],
  wires: Wire[],
  configValues: Record<string, Record<string, string>>,
) {
  const ordered = orderFuncs(funcs, wires);
  const numberOf = new Map(ordered.map((f, i) => [f.id, i + 1]));

  const sourceOf = (funcId: string, inputName: string): Source => {
    const w = wires.find((x) => x.to === funcId && x.toInput === inputName);
    if (w) {
      if (w.from === "trigger") return { kind: "trigger" };
      const sf = funcs.find((x) => x.id === w.from);
      return {
        kind: "step",
        num: numberOf.get(w.from) ?? 0,
        title: sf?.title || w.from,
        output: w.fromOutput,
      };
    }
    const cfg = configValues[funcId] ?? {};
    if (cfg[inputName] !== undefined && cfg[inputName] !== "")
      return { kind: "trigger" };
    return { kind: "trigger" };
  };

  return { ordered, numberOf, sourceOf };
}
