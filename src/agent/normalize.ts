import { extractInputs, extractOutputs, extractFileInputs } from "./extract";
import type { Wire } from "./wiring-repair";

// Deterministic, LLM-FREE re-derivation of a workflow graph after a MANUAL edit
// (step code, wires, or ports). It mirrors the deterministic half of
// reconcileWiring + the designer's port/gate building so a hand-edited graph
// stays as consistent as an AI-authored one — WITHOUT calling the model:
//   • each step's inputs/outputs are re-extracted from its body,
//   • wires/gates referencing fields that no longer exist are dropped (or remapped),
//   • the user-provided (run-form) fields are recomputed.

export interface NormInput {
  name: string;
  role: string;
  type: string;
  required: boolean;
}

export interface NormFunc {
  id: string;
  bodySource: string;
  inputs: NormInput[];
  outputSchema?: {
    type?: string;
    properties?: Record<string, unknown>;
    required?: string[];
  };
  gate?: { ref?: string; equals?: unknown; truthy?: boolean } | null;
  [k: string]: unknown;
}

export interface NormalizeResult {
  funcs: NormFunc[];
  wires: Wire[];
  variableFields: string[];
  diagnostics: string[];
}

function outputsOf(f: {
  outputSchema?: { properties?: Record<string, unknown>; required?: string[] };
}): string[] {
  const props = f.outputSchema?.properties;
  if (props && Object.keys(props).length) return Object.keys(props);
  return f.outputSchema?.required ?? [];
}

const inKey = (to: string, toInput: string) => `${to} ${toInput}`;

function reachable(
  start: string,
  target: string,
  adj: Map<string, Set<string>>,
): boolean {
  const seen = new Set<string>();
  const stack = [start];
  while (stack.length) {
    const cur = stack.pop()!;
    if (cur === target) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const n of adj.get(cur) ?? []) stack.push(n);
  }
  return false;
}

export function normalizeGraph(
  funcsIn: NormFunc[],
  wiresIn: Wire[],
  eventFields: string[] = [],
): NormalizeResult {
  const diagnostics: string[] = [];

  // --- A. Re-derive each step's ports from its code --------------------------
  const funcs: NormFunc[] = funcsIn.map((f) => {
    const body = typeof f.bodySource === "string" ? f.bodySource : "";
    const used = extractInputs(body);
    const fileNames = new Set(extractFileInputs(body));
    const existing = new Map((f.inputs ?? []).map((i) => [i.name, i]));

    // The CODE is the authority for a step's inputs: available = read-in-code ∪
    // existing config-role inputs (a per-step setting the user configured). An
    // input the body no longer reads is removed — and its wires dropped below —
    // which is what makes "a deleted input is no longer accessible" hold. Adding
    // an input via the editor's `input.` autocomplete is fine because picking a
    // suggestion inserts `input.<name>` into the body, so it's read-in-code here.
    const order: string[] = [];
    const seen = new Set<string>();
    const push = (n: string) => {
      if (!seen.has(n)) {
        seen.add(n);
        order.push(n);
      }
    };
    for (const n of used) push(n);
    for (const i of f.inputs ?? []) if (i.role === "config") push(i.name);

    const inputs: NormInput[] = order.map((name) => {
      const ex = existing.get(name);
      if (ex) {
        // keep authored role/type; upgrade to "file" if the body now reads bytes
        const type =
          ex.type === "file" || fileNames.has(name) ? "file" : ex.type;
        return { ...ex, type };
      }
      return {
        name,
        role: "input",
        type: fileNames.has(name) ? "file" : "string",
        required: true,
      };
    });

    const removed = (f.inputs ?? [])
      .map((i) => i.name)
      .filter((n) => !seen.has(n));
    if (removed.length)
      diagnostics.push(`${f.id}: removed input(s) ${removed.join(", ")}`);

    // Outputs from code; if extraction finds none, keep existing (parse-miss
    // safety — don't silently wipe outputs that downstream wires depend on).
    let outNames = extractOutputs(body);
    if (outNames.length === 0) {
      const keep = outputsOf(f);
      if (keep.length) {
        outNames = keep;
        diagnostics.push(`${f.id}: outputs kept (none detected in code)`);
      }
    }
    const properties: Record<string, unknown> = {};
    for (const n of outNames)
      properties[n] = f.outputSchema?.properties?.[n] ?? { type: "string" };
    const outputSchema = { type: "object", properties, required: outNames };

    return { ...f, inputs, outputSchema };
  });

  const funcById = new Map(funcs.map((f) => [f.id, f]));
  const inputNames = new Map(
    funcs.map((f) => [f.id, new Set(f.inputs.map((i) => i.name))]),
  );

  // --- B. Validate / repair wires --------------------------------------------
  const adj = new Map<string, Set<string>>();
  const kept: Wire[] = [];
  const seenWire = new Set<string>();
  for (const w of wiresIn) {
    const wk = `${w.from}.${w.fromOutput}->${w.to}.${w.toInput}`;
    if (seenWire.has(wk)) continue;

    // target step must still declare this input
    if (!funcById.has(w.to) || !inputNames.get(w.to)?.has(w.toInput)) {
      diagnostics.push(`dropped wire -> ${w.to}.${w.toInput} (no such input)`);
      continue;
    }

    let fromOutput = w.fromOutput;
    if (w.from === "trigger") {
      if (!eventFields.includes(w.fromOutput)) {
        diagnostics.push(`dropped trigger.${w.fromOutput} (not an event field)`);
        continue;
      }
    } else {
      const src = funcById.get(w.from);
      if (!src) {
        diagnostics.push(`dropped wire from ${w.from} (no such step)`);
        continue;
      }
      const outs = outputsOf(src);
      if (!outs.includes(w.fromOutput)) {
        if (outs.length === 1) {
          diagnostics.push(
            `remapped ${w.from}.${w.fromOutput} -> ${w.from}.${outs[0]}`,
          );
          fromOutput = outs[0];
        } else {
          diagnostics.push(
            `dropped ${w.from}.${w.fromOutput} -> ${w.to}.${w.toInput} (no such output)`,
          );
          continue;
        }
      }
      if (w.from === w.to) {
        diagnostics.push(`dropped self-wire on ${w.from}`);
        continue;
      }
      if (reachable(w.to, w.from, adj)) {
        diagnostics.push(`dropped ${w.from}->${w.to} (would create a cycle)`);
        continue;
      }
    }

    const wire: Wire = {
      from: w.from,
      fromOutput,
      to: w.to,
      toInput: w.toInput,
    };
    kept.push(wire);
    seenWire.add(wk);
    if (!adj.has(wire.from)) adj.set(wire.from, new Set());
    adj.get(wire.from)!.add(wire.to);
  }

  // --- C. Validate gates ------------------------------------------------------
  for (const f of funcs) {
    const g = f.gate as
      | { ref?: string; equals?: unknown; truthy?: boolean }
      | null
      | undefined;
    if (!g || !g.ref) continue;
    const m = /^(.+)\.output\.(.+)$/.exec(g.ref);
    const ok =
      !!m &&
      m[1] !== f.id &&
      funcById.has(m[1]) &&
      outputsOf(funcById.get(m[1])!).includes(m[2]) &&
      (g.equals !== undefined || g.truthy === true);
    if (!ok) {
      diagnostics.push(`${f.id}: dropped invalid gate (${g.ref ?? "?"})`);
      delete (f as Record<string, unknown>).gate;
    }
  }

  // --- D. Recompute user-provided (run-form) fields --------------------------
  const satisfied = new Set(kept.map((w) => inKey(w.to, w.toInput)));
  const variableFields: string[] = [];
  const seenVar = new Set<string>();
  for (const f of funcs) {
    for (const inp of f.inputs) {
      if (inp.role === "config") continue;
      if (satisfied.has(inKey(f.id, inp.name))) continue;
      if (eventFields.includes(inp.name)) continue;
      if (!seenVar.has(inp.name)) {
        seenVar.add(inp.name);
        variableFields.push(inp.name);
      }
    }
  }

  return { funcs, wires: kept, variableFields, diagnostics };
}
