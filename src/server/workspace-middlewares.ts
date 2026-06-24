import { randomUUID } from "node:crypto";
import type { DocStore } from "../store/docstore";

const COLLECTION = "workspace_middlewares";

export interface WorkspaceMiddleware {
  id: string;
  name: string;
  source: string;
  entrypoint: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceMiddlewareStore {
  list(spaceId: string): Promise<WorkspaceMiddleware[]>;
  get(spaceId: string, id: string): Promise<WorkspaceMiddleware | null>;
  upsert(
    spaceId: string,
    input: Pick<WorkspaceMiddleware, "id" | "name" | "source" | "entrypoint"> &
      Partial<Pick<WorkspaceMiddleware, "version">>,
  ): Promise<WorkspaceMiddleware>;
  remove(spaceId: string, id: string): Promise<void>;
}

export function createWorkspaceMiddlewareStore(
  store: DocStore,
): WorkspaceMiddlewareStore {
  return {
    async list(spaceId) {
      const rows = (await store.list(
        spaceId,
        COLLECTION,
      )) as unknown as WorkspaceMiddleware[];
      return rows.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
    },
    async get(spaceId, id) {
      return (await store.get(
        spaceId,
        COLLECTION,
        id,
      )) as WorkspaceMiddleware | null;
    },
    async upsert(spaceId, input) {
      const now = new Date().toISOString();
      const id = input.id || randomUUID();
      const prev = (await store.get(
        spaceId,
        COLLECTION,
        id,
      )) as WorkspaceMiddleware | null;
      const row: WorkspaceMiddleware = {
        id,
        name: input.name.trim(),
        source: input.source,
        entrypoint: input.entrypoint || "handle",
        version: input.version ?? (prev ? prev.version + 1 : 1),
        createdAt: prev?.createdAt ?? now,
        updatedAt: now,
      };
      await store.put(
        spaceId,
        COLLECTION,
        id,
        row as unknown as Record<string, unknown>,
      );
      return row;
    },
    async remove(spaceId, id) {
      await store.remove(spaceId, COLLECTION, id);
    },
  };
}
