import type { DocStore } from "../store/docstore";
import type { OutcomeConfig } from "./outcome";
import type { MaskLevel } from "./pii-mask";
import type { LivenessConfig } from "./webhook-liveness";

const COLLECTION = "workflows";

export type IntervalUnit = "second" | "minute" | "hour" | "day";

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

export interface TriggerConfig {
  // "monitor" = an alert-handler flow: runs automatically when a monitoring
  // event fires on any flow (error / silent-failure / silent-success / heal).
  // Behaves like "manual" for scheduling/webhook paths (no job/endpoint).
  kind: "manual" | "webhook" | "schedule" | "poll" | "event" | "monitor";
  enabled?: boolean;
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
  inputForm?: unknown;
  variables?: Record<string, unknown>;
  conversationId?: string;
  currentVersionId?: string; // latest sealed version (run-stamp / history pointer)
  outcome?: OutcomeConfig; // opt-in silent-success checks (expectations / drift-to-empty)
  maskLevel?: MaskLevel; // per-flow PII masking override (default → MASK_DEFAULT)
  liveness?: LivenessConfig; // per-flow liveness config (webhook heartbeat / schedule tol)
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowMeta {
  id: string;
  name: string;
  funcCount: number;
  updatedAt: string;
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
        }))
        .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
    },

    async saveWorkflow(spaceId, input) {
      const existing = await getWorkflow(spaceId, input.id);
      const now = new Date().toISOString();
      const wf: SavedWorkflow = {
        ...input,
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
  };
}
