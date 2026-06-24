import type { DocStore } from "../store/docstore";
import { formatFuncsCode } from "./format-code";
import type { OutcomeConfig } from "./outcome";
import type { MaskLevel } from "./pii-mask";
import type { LivenessConfig } from "./webhook-liveness";

const COLLECTION = "workflows";

export type IntervalUnit = "second" | "minute" | "hour" | "day";
export type HttpMethod =
  | "GET"
  | "POST"
  | "PUT"
  | "PATCH"
  | "DELETE"
  | "OPTIONS"
  | "HEAD";

export interface ScheduleTriggerConfig {
  mode: "cron" | "interval";
  cron?: string;
  intervalValue?: number;
  intervalUnit?: IntervalUnit;
  timezone?: string;
}

export interface PollTriggerConfig {
  provider: string;
  source?: string;
  dependencies?: string[];
  paramNames?: string[];
  intervalValue: number;
  intervalUnit: IntervalUnit;
  connection?: string;
  params?: Record<string, unknown>;
}

export interface HttpTriggerConfig {
  method: HttpMethod;
  path: string;
  responseMode?: "sync" | "async";
}

export interface EndpointMetadata {
  method: HttpMethod;
  path: string;
  groupKey?: string;
  summary?: string;
  public?: boolean;
  responseMode?: "sync" | "async";
}

export interface EndpointValidationConfig {
  schemaType: "json-schema" | "zod-json";
  schema: Record<string, unknown>;
  failStatus?: number;
}

export interface EndpointRateLimitConfig {
  key: "ip" | "workspace" | "endpoint";
  windowMs: number;
  max: number;
}

export interface EndpointBuiltinMiddlewares {
  validation?: EndpointValidationConfig;
  rateLimit?: EndpointRateLimitConfig;
}

export interface EndpointCustomMiddlewareRef {
  middlewareId: string;
  version: number;
  order: number;
  enabled: boolean;
}

export interface EndpointMiddlewareConfig {
  builtins?: EndpointBuiltinMiddlewares;
  custom: EndpointCustomMiddlewareRef[];
}

export interface TriggerConfig {
  // "monitor" = an alert-handler flow: runs automatically when a monitoring
  // event fires on any flow (error / silent-failure / silent-success / heal).
  // Behaves like "manual" for scheduling/webhook paths (no job/endpoint).
  kind:
    | "manual"
    | "http"
    | "webhook"
    | "schedule"
    | "poll"
    | "event"
    | "monitor";
  enabled?: boolean;
  http?: HttpTriggerConfig;
  schedule?: ScheduleTriggerConfig;
  poll?: PollTriggerConfig;
  eventFields?: string[];
  // for kind:"monitor" — only fire on these event categories (default: all).
  monitor?: { events?: string[] };
}

export interface SavedWorkflow {
  id: string;
  name: string;
  funcs: unknown[];
  wires: unknown[];
  positions: Record<string, { x: number; y: number }>;
  config: Record<string, Record<string, string>>;
  nodeConnections?: Record<string, Record<string, string>>;
  trigger?: TriggerConfig;
  endpoint?: EndpointMetadata;
  middleware?: EndpointMiddlewareConfig;
  inputForm?: unknown;
  variables?: Record<string, unknown>;
  conversationId?: string;
  currentVersionId?: string; // latest sealed version (run-stamp / history pointer)
  outcome?: OutcomeConfig; // opt-in silent-success checks (expectations / drift-to-empty)
  alertsEnabled?: boolean; // send external alerts / run handlers for this flow (default OFF — opt-in)
  maskLevel?: MaskLevel; // per-flow PII masking override (default → MASK_DEFAULT)
  // No-data-loss pause: while true, webhook events are buffered (not run inline)
  // and schedule/poll ticks are skipped. Set by the user or by auto-heal at
  // heal-start; cleared by /resume. Durable so the UI + webhook handler agree.
  paused?: boolean;
  pausedAt?: string; // ISO — UI "stopped since"
  pausedReason?: "manual" | "heal" | "buffer-full";
  liveness?: LivenessConfig; // per-flow liveness config (webhook heartbeat / schedule tol)
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowMeta {
  id: string;
  name: string;
  funcCount: number;
  updatedAt: string;
  triggerKind?: TriggerConfig["kind"];
  httpMethod?: HttpMethod;
  httpPath?: string;
  webhookSource?: string;
  scheduleMode?: "cron" | "interval";
  scheduleLabel?: string;
}

export interface WorkflowStore {
  listWorkflows(spaceId: string): Promise<WorkflowMeta[]>;
  getWorkflow(spaceId: string, id: string): Promise<SavedWorkflow | null>;
  saveWorkflow(
    spaceId: string,
    input: Omit<SavedWorkflow, "createdAt" | "updatedAt">,
  ): Promise<SavedWorkflow>;
  deleteWorkflow(spaceId: string, id: string): Promise<void>;
  // point HEAD at its latest sealed version without bumping content/updatedAt.
  setCurrentVersion(
    spaceId: string,
    id: string,
    versionId: string,
  ): Promise<void>;
  // flip the no-data-loss pause flag (durable; webhook handler + UI read it).
  setPaused(
    spaceId: string,
    id: string,
    paused: boolean,
    reason?: "manual" | "heal" | "buffer-full",
  ): Promise<void>;
}

export function createWorkflowStore(store: DocStore): WorkflowStore {
  async function getWorkflow(
    spaceId: string,
    id: string,
  ): Promise<SavedWorkflow | null> {
    return (await store.get(spaceId, COLLECTION, id)) as SavedWorkflow | null;
  }

  return {
    getWorkflow,

    async listWorkflows(spaceId) {
      const docs = (await store.list(
        spaceId,
        COLLECTION,
      )) as unknown as SavedWorkflow[];
      return docs
        .map((wf) => ({
          id: wf.id,
          name: wf.name,
          funcCount: Array.isArray(wf.funcs) ? wf.funcs.length : 0,
          updatedAt: wf.updatedAt,
          triggerKind: wf.trigger?.kind,
          httpMethod: wf.endpoint?.method ?? wf.trigger?.http?.method,
          httpPath: wf.endpoint?.path ?? wf.trigger?.http?.path,
          webhookSource: wf.trigger?.kind === "webhook" ? "incoming" : undefined,
          scheduleMode:
            wf.trigger?.kind === "schedule" ? wf.trigger.schedule?.mode : undefined,
          scheduleLabel:
            wf.trigger?.kind === "schedule"
              ? wf.trigger.schedule?.mode === "cron"
                ? wf.trigger.schedule?.cron
                : wf.trigger.schedule?.intervalValue !== undefined
                  ? `${wf.trigger.schedule.intervalValue} ${wf.trigger.schedule.intervalUnit ?? "second"}`
                  : undefined
              : undefined,
        }))
        .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
    },

    async saveWorkflow(spaceId, input) {
      const existing = await getWorkflow(spaceId, input.id);
      const now = new Date().toISOString();
      // beautify generated step code at the persist chokepoint (covers builder +
      // applied heal fixes) so what's stored — and shown in the diff — is clean
      const funcs = await formatFuncsCode(input.funcs ?? []);
      const wf: SavedWorkflow = {
        ...input,
        funcs,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      await store.put(
        spaceId,
        COLLECTION,
        input.id,
        wf as unknown as Record<string, unknown>,
      );
      return wf;
    },

    async deleteWorkflow(spaceId, id) {
      await store.remove(spaceId, COLLECTION, id);
    },

    async setCurrentVersion(spaceId, id, versionId) {
      const existing = await getWorkflow(spaceId, id);
      if (!existing) return;
      await store.put(spaceId, COLLECTION, id, {
        ...existing,
        currentVersionId: versionId,
      } as unknown as Record<string, unknown>);
    },

    async setPaused(spaceId, id, paused, reason) {
      const existing = await getWorkflow(spaceId, id);
      if (!existing) return;
      const { paused: _p, pausedAt: _a, pausedReason: _r, ...rest } = existing;
      await store.put(spaceId, COLLECTION, id, {
        ...rest,
        ...(paused
          ? { paused: true, pausedAt: new Date().toISOString(), pausedReason: reason ?? "manual" }
          : {}),
      } as unknown as Record<string, unknown>);
    },
  };
}
