import type { Schema } from "./schema";
import type { PortDef, Binding } from "./binding";
import type { ConnectionRequirement } from "./connection";

export interface FuncBody {
  language: "javascript";
  source: string;
  dependencies?: string[];
  generatedBy: { agent: string; prompt: string };
}

export type ProviderClient = unknown;

export interface FuncContext {
  idempotencyKey: string;
  connections: Record<string, ProviderClient>;
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

export interface FuncNode {
  nodeId: string;
  funcId: string;
  funcVersion: number;
  bindings: Record<string, Binding>;
  connections: Record<string, string>;
  connectionIds?: Record<string, string>;
  dependsOn: string[];
}
