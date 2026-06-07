import type { DocStore } from "../store/docstore";

const COLLECTION = "workflows";

export interface TriggerConfig {
  kind: "manual" | "webhook" | "schedule" | "poll" | "event";
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
  };
}
