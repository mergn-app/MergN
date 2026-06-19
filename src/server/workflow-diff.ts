// Pure, dependency-light workflow diffing + content hashing for M1 versioning.
// No store / LLM imports — trivially unit-testable. The version store and the
// (later) M8 diff UI both consume these.
import { createHash } from "node:crypto";

// SavedWorkflow keeps funcs/wires as unknown[]; we read only the fields that
// matter for hashing + diffing. Unknown extra fields are preserved by the hash
// (full-content) but ignored by the structured diff.
export interface DiffFunc {
  id: string;
  bodySource?: string;
  inputs?: Array<{ name: string; role?: string; type?: string }>;
  outputSchema?: { properties?: Record<string, unknown> };
  gate?: { ref?: string; equals?: unknown; truthy?: boolean };
  requires?: Array<{ provider?: string }>;
  [k: string]: unknown;
}
export interface DiffWire {
  from: string;
  fromOutput?: string;
  to: string;
  toInput?: string;
}

// The content-bearing slice of a workflow. positions/timestamps/conversationId
// are intentionally excluded (cosmetic / non-content) — moving a node must NOT
// produce a new version.
export interface WorkflowSnapshot {
  name?: string;
  funcs?: unknown[];
  wires?: unknown[];
  positions?: Record<string, { x: number; y: number }>;
  config?: Record<string, Record<string, string>>;
  nodeConnections?: Record<string, Record<string, string>>;
  trigger?: unknown;
  inputForm?: unknown;
  variables?: Record<string, unknown>;
}

export interface WorkflowDiff {
  nodes: {
    added: string[];
    removed: string[];
    modified: Array<{
      id: string;
      changed: {
        code?: boolean;
        inputs?: { added: string[]; removed: string[]; retyped: string[] };
        outputs?: { added: string[]; removed: string[] };
        gate?: "added" | "removed" | "changed";
        provider?: boolean;
      };
    }>;
  };
  wires: { added: string[]; removed: string[] };
  trigger: { changed: boolean };
  config: { changedSteps: string[] };
}

const wireKey = (w: DiffWire): string =>
  `${w.from}.${w.fromOutput ?? ""}->${w.to}.${w.toInput ?? ""}`;

// Deterministic JSON: keys sorted, undefined values dropped (matches JSON.stringify).
function stable(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return "[" + v.map(stable).join(",") + "]";
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort();
  return (
    "{" + keys.map((k) => JSON.stringify(k) + ":" + stable(o[k])).join(",") + "}"
  );
}

// Canonical, position-independent, order-independent serialization of the
// content-bearing slice. Funcs sorted by id, wires by wireKey → reordering a
// step or a wire does not change the hash.
export function canonicalize(s: WorkflowSnapshot): string {
  const funcs = [...((s.funcs ?? []) as DiffFunc[])].sort((a, b) =>
    String(a?.id ?? "").localeCompare(String(b?.id ?? "")),
  );
  const wires = [...((s.wires ?? []) as DiffWire[])].sort((a, b) =>
    wireKey(a).localeCompare(wireKey(b)),
  );
  return stable({
    name: s.name ?? "",
    funcs,
    wires,
    config: s.config ?? {},
    nodeConnections: s.nodeConnections ?? {},
    trigger: s.trigger ?? null,
    inputForm: s.inputForm ?? null,
    variables: s.variables ?? {},
  });
}

export function contentHash(s: WorkflowSnapshot): string {
  return createHash("sha256").update(canonicalize(s)).digest("hex");
}

// ── diff helpers ──
const funcsById = (s: WorkflowSnapshot): Map<string, DiffFunc> =>
  new Map(((s.funcs ?? []) as DiffFunc[]).map((f) => [String(f.id), f]));
const outsOf = (f: DiffFunc): string[] =>
  Object.keys(f.outputSchema?.properties ?? {});
const inputSig = (f: DiffFunc): Map<string, string> =>
  new Map(
    (f.inputs ?? []).map((p) => [p.name, `${p.role ?? "input"}:${p.type ?? "string"}`]),
  );
const gateSig = (f: DiffFunc): string | null =>
  f.gate
    ? stable({ ref: f.gate.ref, equals: f.gate.equals, truthy: f.gate.truthy })
    : null;
const provSig = (f: DiffFunc): string =>
  (f.requires ?? [])
    .map((r) => r.provider)
    .filter(Boolean)
    .sort()
    .join(",");

function setDiff(a: Iterable<string>, b: Iterable<string>) {
  const sa = new Set(a);
  const sb = new Set(b);
  return {
    added: [...sb].filter((x) => !sa.has(x)),
    removed: [...sa].filter((x) => !sb.has(x)),
  };
}

// Structured before→after diff. Feeds M8 node badges (code/input/wire/gate/provider).
export function diffWorkflows(a: WorkflowSnapshot, b: WorkflowSnapshot): WorkflowDiff {
  const fa = funcsById(a);
  const fb = funcsById(b);
  const { added, removed } = setDiff(fa.keys(), fb.keys());

  const modified: WorkflowDiff["nodes"]["modified"] = [];
  for (const id of fa.keys()) {
    if (!fb.has(id)) continue;
    const x = fa.get(id)!;
    const y = fb.get(id)!;
    const changed: WorkflowDiff["nodes"]["modified"][number]["changed"] = {};

    if (x.bodySource !== y.bodySource) changed.code = true;

    const ix = inputSig(x);
    const iy = inputSig(y);
    const inAdded = [...iy.keys()].filter((k) => !ix.has(k));
    const inRemoved = [...ix.keys()].filter((k) => !iy.has(k));
    const retyped = [...ix.keys()].filter((k) => iy.has(k) && ix.get(k) !== iy.get(k));
    if (inAdded.length || inRemoved.length || retyped.length)
      changed.inputs = { added: inAdded, removed: inRemoved, retyped };

    const od = setDiff(outsOf(x), outsOf(y));
    if (od.added.length || od.removed.length) changed.outputs = od;

    const gx = gateSig(x);
    const gy = gateSig(y);
    if (gx !== gy)
      changed.gate = !gx ? "added" : !gy ? "removed" : "changed";

    if (provSig(x) !== provSig(y)) changed.provider = true;

    if (Object.keys(changed).length) modified.push({ id, changed });
  }

  const wa = ((a.wires ?? []) as DiffWire[]).map(wireKey);
  const wb = ((b.wires ?? []) as DiffWire[]).map(wireKey);
  const wires = setDiff(wa, wb);

  const triggerChanged = stable(a.trigger ?? null) !== stable(b.trigger ?? null);

  const ca = a.config ?? {};
  const cb = b.config ?? {};
  const cfgSteps = new Set([...Object.keys(ca), ...Object.keys(cb)]);
  const changedSteps = [...cfgSteps].filter(
    (s) => stable(ca[s] ?? {}) !== stable(cb[s] ?? {}),
  );

  return {
    nodes: { added, removed, modified },
    wires,
    trigger: { changed: triggerChanged },
    config: { changedSteps },
  };
}
