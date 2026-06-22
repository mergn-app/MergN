import type { DocStore } from "../store/docstore";

// Explicit registry of flows that run on an alert (chosen by the user, not
// inferred from a flow's trigger). Each entry has its own enable/disable toggle;
// the alert service dispatches the ENABLED ones with the alert payload as input.
const COLLECTION = "alert_handlers";

export interface AlertHandler {
  workflowId: string;
  enabled: boolean;
  addedAt: string;
}

export interface AlertHandlerStore {
  list(spaceId: string): Promise<AlertHandler[]>;
  add(spaceId: string, workflowId: string): Promise<AlertHandler>;
  setEnabled(spaceId: string, workflowId: string, enabled: boolean): Promise<void>;
  remove(spaceId: string, workflowId: string): Promise<void>;
  isEnabled(spaceId: string, workflowId: string): Promise<boolean>;
}

export function createAlertHandlerStore(store: DocStore): AlertHandlerStore {
  return {
    async list(spaceId) {
      return (await store.list(spaceId, COLLECTION)) as unknown as AlertHandler[];
    },
    async add(spaceId, workflowId) {
      const existing = (await store.get(spaceId, COLLECTION, workflowId)) as unknown as AlertHandler | null;
      const h: AlertHandler = existing ?? { workflowId, enabled: true, addedAt: new Date().toISOString() };
      await store.put(spaceId, COLLECTION, workflowId, h as unknown as Record<string, unknown>);
      return h;
    },
    async setEnabled(spaceId, workflowId, enabled) {
      const h = (await store.get(spaceId, COLLECTION, workflowId)) as unknown as AlertHandler | null;
      if (!h) return;
      await store.put(spaceId, COLLECTION, workflowId, { ...h, enabled } as unknown as Record<string, unknown>);
    },
    async remove(spaceId, workflowId) {
      await store.remove(spaceId, COLLECTION, workflowId);
    },
    async isEnabled(spaceId, workflowId) {
      const h = (await store.get(spaceId, COLLECTION, workflowId)) as { enabled?: boolean } | null;
      return !!h?.enabled;
    },
  };
}
