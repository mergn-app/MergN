import { randomUUID } from "node:crypto";
import type { DocStore } from "../store/docstore";
import type { BlobStore } from "../store/blobs";
import { LIMITS } from "../limits";

const COLLECTION = "files";

// Thrown when an upload would exceed the per-space storage limit, so the HTTP
// layer can map it to a 413 instead of a 500.
export class FileLimitError extends Error {}

export type FileSource = "user" | "workflow";

export interface FileMeta {
  id: string;
  name: string;
  mime: string;
  size: number;
  source: FileSource;
  createdAt: string;
}

export interface FileService {
  upload(
    spaceId: string,
    file: { name: string; mime: string; body: Buffer; source?: FileSource },
  ): Promise<FileMeta>;
  list(spaceId: string): Promise<FileMeta[]>;
  get(spaceId: string, id: string): Promise<FileMeta | null>;
  content(spaceId: string, id: string): Promise<Buffer | null>;
  remove(spaceId: string, id: string): Promise<void>;
}

export function createFileService(store: DocStore, blobs: BlobStore): FileService {
  return {
    async upload(spaceId, file) {
      // Enforce the per-space total storage quota (sum of existing file sizes +
      // this one). Unlimited for self-host (the cap is MAX_SAFE_INTEGER).
      const existing = (await store.list(
        spaceId,
        COLLECTION,
      )) as unknown as FileMeta[];
      const used = existing.reduce((sum, f) => sum + (f.size || 0), 0);
      if (used + file.body.length > LIMITS.maxStorageBytes)
        throw new FileLimitError(
          `storage limit reached (max ${Math.floor(LIMITS.maxStorageBytes / 1024 / 1024 / 1024)} GB per workspace)`,
        );
      const id = randomUUID();
      await blobs.put(spaceId, id, file.body);
      const meta: FileMeta = {
        id,
        name: file.name.slice(0, 200) || "file",
        mime: file.mime || "application/octet-stream",
        size: file.body.length,
        source: file.source ?? "user",
        createdAt: new Date().toISOString(),
      };
      await store.put(spaceId, COLLECTION, id, meta as unknown as Record<string, unknown>);
      return meta;
    },

    async list(spaceId) {
      const docs = (await store.list(spaceId, COLLECTION)) as unknown as FileMeta[];
      return docs.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    },

    async get(spaceId, id) {
      return (await store.get(spaceId, COLLECTION, id)) as unknown as FileMeta | null;
    },

    async content(spaceId, id) {
      const meta = await this.get(spaceId, id);
      if (!meta) return null;
      return blobs.get(spaceId, id);
    },

    async remove(spaceId, id) {
      await blobs.remove(spaceId, id).catch(() => {});
      await store.remove(spaceId, COLLECTION, id);
    },
  };
}
