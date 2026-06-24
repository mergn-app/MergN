import type { Schema } from "./schema";
import type { PortDef, Binding } from "./binding";
import type { ConnectionRequirement } from "./connection";

export interface FuncBody {
  language: "python";
  source: string;
  dependencies?: string[];
  generatedBy: { agent: string; prompt: string };
}

export type ProviderClient = unknown;

export interface FuncContext {
  idempotencyKey: string;
  connections: Record<string, ProviderClient>;
  // Tenant identity, host-side only — forwarded to the remote code-exec service
  // for per-tenant logging / abuse detection. NEVER exposed to the func code.
  spaceId?: string;
  workflowId?: string;
}

export type FuncHandler = (
  ctx: FuncContext,
  input: Record<string, unknown>,
) => Promise<unknown>;

export type DangerClass = "benign" | "costly" | "catastrophic";

export type IdempotencyMechanism =
  | "provider-key"
  | "upsert"
  | "read-before-write"
  | "claim"
  | "none";

export interface Idempotency {
  key: string;
  mechanism: IdempotencyMechanism;
}

export interface EffectPolicy {
  retryable: boolean;
  dangerClass: DangerClass;
  idempotency: Idempotency;
}

interface FuncBase {
  id: string;
  version: number;
  kind: "library" | "adapter";
  inputs: PortDef[];
  outputSchema: Schema;
  body: FuncBody;
}

export interface PureFunc extends FuncBase {
  pure: true;
}

export interface EffectfulFunc extends FuncBase {
  pure: false;
  requires: ConnectionRequirement[];
  effect: EffectPolicy;
}

export type FuncDefinition = PureFunc | EffectfulFunc;

// A gate makes a node CONDITIONAL: the engine runs the node only when the gate
// passes, otherwise the node (and everything that depends on it) is skipped.
// `ref` points at an upstream node's output field ("stepId.output.field");
// the gate passes when that value equals `equals`, or matches `truthy`.
export interface Gate {
  ref: string;
  equals?: unknown;
  truthy?: boolean;
}

export interface FuncNode {
  nodeId: string;
  funcId: string;
  funcVersion: number;
  bindings: Record<string, Binding>;
  connections: Record<string, string>;
  connectionIds?: Record<string, string>;
  dependsOn: string[];
  gate?: Gate;
}
