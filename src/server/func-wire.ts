import type { FuncDefinition } from "../atoms/index";

// The stored/editor func shape (what a SavedWorkflow.funcs entry looks like).
// `funcToWire` converts an authored FuncDefinition into it. Extracted from
// index.ts so both the chat tool handlers and the heal-agent (fix engine) can
// produce this shape without importing the server entrypoint (circular dep).
export interface StoredFunc {
  id: string;
  title: string;
  summary: string;
  version: number;
  kind: FuncDefinition["kind"];
  pure: boolean;
  inputs: { name: string; role: string; type: string; required: boolean }[];
  outputSchema: FuncDefinition["outputSchema"];
  bodySource: string;
  dependencies: string[];
  requires: { name: string; provider: string; scopes: string[] }[];
  dangerClass: string | null;
  idempotency: { key: string; mechanism: string } | null;
}

export function funcToWire(
  func: FuncDefinition,
  title: string,
  summary: string,
): StoredFunc {
  return {
    id: func.id,
    title,
    summary,
    version: func.version,
    kind: func.kind,
    pure: func.pure,
    inputs: func.inputs.map((p) => ({
      name: p.name,
      role: p.role,
      type: p.schema.type,
      required: p.required,
    })),
    outputSchema: func.outputSchema,
    bodySource: func.body.source,
    dependencies: func.body.dependencies ?? [],
    requires: func.pure ? [] : func.requires,
    dangerClass: func.pure ? null : func.effect.dangerClass,
    idempotency: func.pure ? null : func.effect.idempotency,
  };
}
