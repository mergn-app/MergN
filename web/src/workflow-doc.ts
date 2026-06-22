import type { AuthoredFunc, InputForm, TriggerConfig, Wire } from "./types";

// The single source of truth for "what gets persisted" in a workflow. Any new
// persisted field is added here once — the editor's autosave funnel (derive the
// doc → stable-stringify → compare to the last-saved snapshot → debounced save)
// then covers it automatically, so no mutation site ever marks dirty by hand.
export interface WorkflowDocParts {
  name: string;
  funcs: AuthoredFunc[];
  wires: Wire[];
  positions: Record<string, { x: number; y: number }>;
  config: Record<string, Record<string, string>>;
  nodeConnections: Record<string, Record<string, string>>;
  trigger: TriggerConfig;
  inputForm: InputForm | null;
  variables: Record<string, unknown>;
}

// Fixed key order so two equal-content docs serialize identically.
export function buildWorkflowDoc(p: WorkflowDocParts): WorkflowDocParts {
  return {
    name: p.name,
    funcs: p.funcs,
    wires: p.wires,
    positions: p.positions,
    config: p.config,
    nodeConnections: p.nodeConnections,
    trigger: p.trigger,
    inputForm: p.inputForm,
    variables: p.variables,
  };
}

// Order-independent serialization for the dirty check: object keys are sorted
// (so {x,y} vs {y,x}, or a re-ordered positions/config map, don't read as a
// change), while arrays (funcs/wires) keep their order, which IS semantic.
export function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return "[" + v.map(stableStringify).join(",") + "]";
  if (v && typeof v === "object") {
    return (
      "{" +
      Object.keys(v as Record<string, unknown>)
        .sort()
        .map(
          (k) =>
            JSON.stringify(k) +
            ":" +
            stableStringify((v as Record<string, unknown>)[k]),
        )
        .join(",") +
      "}"
    );
  }
  return JSON.stringify(v ?? null);
}
