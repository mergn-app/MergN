import type { AuthoredFunc, Wire, TriggerConfig, InputForm } from "./types";
import { spaceHeaders } from "./space";

export interface HealthIssue {
  kind: "orphan-input" | "cycle";
  nodeId: string;
  field?: string;
  message: string;
}

// Deterministic, instant (no LLM) detection of definitely-broken wiring:
//  - orphan-input: a non-config input with no wire, no config value, not a
//    trigger field, and not covered by the input form or saved variables — it
//    would be `undefined` at run time.
//  - cycle: the wire graph is not a DAG.
// Subtle "a wire is probably missing" cases are intentionally NOT flagged here
// (a form field and a should-be-wired input look identical without semantics);
// those are surfaced by the AI "Fix with AI" action instead.
export function detectIssues(args: {
  funcs: AuthoredFunc[];
  wires: Wire[];
  trigger: TriggerConfig;
  inputForm: InputForm | null;
  variables: Record<string, unknown>;
  configValues: Record<string, Record<string, string>>;
}): HealthIssue[] {
  const { funcs, wires, trigger, inputForm, variables, configValues } = args;
  const issues: HealthIssue[] = [];
  const eventFields = new Set(trigger.eventFields ?? []);
  const formNames = new Set((inputForm?.fields ?? []).map((f) => f.name));
  const varNames = new Set(Object.keys(variables ?? {}));

  for (const f of funcs) {
    const cfg = configValues[f.id] ?? {};
    for (const p of f.inputs) {
      if (p.role === "config") continue;
      const wired = wires.some((w) => w.to === f.id && w.toInput === p.name);
      const hasConfig = cfg[p.name] !== undefined && cfg[p.name] !== "";
      if (
        wired ||
        hasConfig ||
        eventFields.has(p.name) ||
        formNames.has(p.name) ||
        varNames.has(p.name)
      )
        continue;
      issues.push({
        kind: "orphan-input",
        nodeId: f.id,
        field: p.name,
        message: `${f.id}.${p.name}`,
      });
    }
  }

  const adj = new Map<string, Set<string>>();
  for (const w of wires) {
    if (!adj.has(w.from)) adj.set(w.from, new Set());
    adj.get(w.from)!.add(w.to);
  }
  const color = new Map<string, number>();
  const dfs = (n: string): boolean => {
    color.set(n, 1);
    for (const nx of adj.get(n) ?? []) {
      const c = color.get(nx) ?? 0;
      if (c === 1) return true;
      if (c === 0 && dfs(nx)) return true;
    }
    color.set(n, 2);
    return false;
  };
  for (const f of funcs) {
    if ((color.get(f.id) ?? 0) === 0 && dfs(f.id)) {
      issues.push({ kind: "cycle", nodeId: f.id, message: `cycle: ${f.id}` });
      break;
    }
  }
  return issues;
}

export interface RepairResult {
  added: Wire[];
  wires: Wire[];
  variableFields: string[];
  diagnostics: string[];
}

// Runs the server-side AI wiring repair (deterministic detect + LLM bridge) on
// the current graph and returns the wires it added.
export async function repairWiring(body: {
  funcs: AuthoredFunc[];
  wires: Wire[];
  trigger: TriggerConfig;
}): Promise<RepairResult> {
  const res = await fetch("/api/repair-wiring", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...spaceHeaders() },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`repair failed: ${res.status}`);
  return res.json();
}
