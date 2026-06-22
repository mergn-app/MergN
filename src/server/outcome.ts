// Outcome health — "silent success" detection. A run can finish status:"done"
// yet not do its job (an expired token returns an empty 200, the report goes out
// blank). Run status + liveness are both green, so status-based monitors miss
// it entirely. This evaluates the run's OUTPUT against the flow's declared
// expectations, plus a conservative drop-to-empty heuristic. Pure + opt-in (no
// config → no signal → zero false positives).

export interface OutcomeExpectation {
  nodeId?: string; // a specific step; absent = the flow's final step output
  rule: "nonEmpty" | "minCount" | "hasKeys" | "equals" | "range";
  min?: number; // minCount
  keys?: string[]; // hasKeys
  equals?: unknown; // equals
  lo?: number; // range
  hi?: number; // range
}

export interface OutcomeConfig {
  driftToEmpty?: boolean; // conservative auto: a step that always had data, now empty
  expectations?: OutcomeExpectation[];
}

export interface OutcomeFail {
  kind: "expectation" | "drop";
  nodeId?: string;
  detail: string;
}

export interface OutcomeOutput {
  nodeId: string;
  output: unknown;
  effectful: boolean; // only effectful steps matter; a pure transform may be empty
}

// Drift needs at least this many prior runs (all non-empty) before "now empty"
// counts as a drop — avoids flagging a young flow with little history.
const DRIFT_MIN_HISTORY = 3;

export function isEmpty(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v === "string") return v.length === 0;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === "object") return Object.keys(v as object).length === 0;
  return false; // numbers/booleans are real values (0 / false are NOT empty)
}

// Like isEmpty, but also recognizes PII-mask "zero length" tags («string:0»,
// «array:0»). Drift-to-empty reads PAST runs' MASKED outputs, where an empty
// string/array is a tag, not a real empty — this catches that case too.
export function maskedIsEmpty(v: unknown): boolean {
  if (typeof v === "string" && /^«[a-z]+:0»$/i.test(v)) return true;
  return isEmpty(v);
}

function countOf(v: unknown): number | undefined {
  return Array.isArray(v) ? v.length : undefined;
}

function pick(outputs: OutcomeOutput[], nodeId?: string): OutcomeOutput | undefined {
  if (nodeId) return outputs.find((o) => o.nodeId === nodeId);
  return outputs.length ? outputs[outputs.length - 1] : undefined; // flow final
}

function checkExpectation(
  outputs: OutcomeOutput[],
  e: OutcomeExpectation,
): OutcomeFail | null {
  const target = pick(outputs, e.nodeId);
  if (!target) return null; // step didn't run (e.g. gated) → not an outcome fail
  const v = target.output;
  const fail = (detail: string): OutcomeFail => ({
    kind: "expectation",
    nodeId: target.nodeId,
    detail,
  });
  switch (e.rule) {
    case "nonEmpty":
      return isEmpty(v) ? fail(`${target.nodeId}: output is empty`) : null;
    case "minCount": {
      const n = countOf(v);
      const min = e.min ?? 1;
      return n === undefined || n < min
        ? fail(`${target.nodeId}: ${n ?? "non-array"} items < expected ${min}`)
        : null;
    }
    case "hasKeys": {
      const ok =
        v && typeof v === "object" && !Array.isArray(v) &&
        (e.keys ?? []).every((k) => k in (v as Record<string, unknown>));
      return ok ? null : fail(`${target.nodeId}: missing keys ${(e.keys ?? []).join(",")}`);
    }
    case "equals":
      return JSON.stringify(v) === JSON.stringify(e.equals)
        ? null
        : fail(`${target.nodeId}: value != expected`);
    case "range": {
      const n = typeof v === "number" ? v : NaN;
      const lo = e.lo ?? -Infinity;
      const hi = e.hi ?? Infinity;
      return Number.isFinite(n) && n >= lo && n <= hi
        ? null
        : fail(`${target.nodeId}: ${v} out of [${e.lo ?? ""},${e.hi ?? ""}]`);
    }
    default:
      return null;
  }
}

export function evaluateOutcome(params: {
  outputs: OutcomeOutput[]; // this run, in execution order
  config: OutcomeConfig | undefined;
  // for driftToEmpty: per-node count of prior runs (within a window) where the
  // node produced non-empty output, and how many prior runs were considered.
  driftBaseline?: Record<string, number>;
  driftHistory?: number;
}): OutcomeFail | null {
  const { outputs, config } = params;
  if (!config) return null; // opt-in: no config → no signal

  // 1) Declared expectations (deterministic, hard) — first violation wins.
  for (const e of config.expectations ?? []) {
    const f = checkExpectation(outputs, e);
    if (f) return f;
  }

  // 2) Conservative drop-to-empty (soft): a step that was non-empty across ALL
  // of the last N (≥ DRIFT_MIN_HISTORY) runs is empty now. Only effectful steps;
  // only the unambiguous data→empty transition (not a statistical threshold).
  if (config.driftToEmpty && params.driftBaseline) {
    const hist = params.driftHistory ?? 0;
    if (hist >= DRIFT_MIN_HISTORY) {
      for (const o of outputs) {
        if (!o.effectful || !isEmpty(o.output)) continue;
        if ((params.driftBaseline[o.nodeId] ?? 0) >= hist) {
          return {
            kind: "drop",
            nodeId: o.nodeId,
            detail: `${o.nodeId}: produced data in the last ${hist} runs, empty now`,
          };
        }
      }
    }
  }

  return null;
}
