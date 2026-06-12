import { randomUUID } from "node:crypto";
import type { DocStore } from "../store/docstore";

const COLLECTION = "logs";
const DOC = "feed";
const CAP = 500; // keep the last N entries per space
const MSG_MAX = 500;
const DETAIL_MAX = 4000;

export type LogLevel = "error" | "warn" | "info";
export type LogSource = "build" | "run" | "chat" | "client" | "system";

export interface LogEntry {
  id: string;
  ts: string;
  level: LogLevel;
  source: LogSource;
  message: string;
  detail?: string;
  workflowId?: string;
}

export interface NewLog {
  level: LogLevel;
  source: LogSource;
  message: string;
  detail?: string;
  workflowId?: string;
}

export interface LogStore {
  append(spaceId: string, e: NewLog): Promise<LogEntry>;
  list(spaceId: string, limit?: number): Promise<LogEntry[]>;
  clear(spaceId: string): Promise<void>;
}

const clamp = (s: string, n: number) => (s.length <= n ? s : s.slice(0, n) + "…");

export function createLogStore(store: DocStore): LogStore {
  async function read(spaceId: string): Promise<LogEntry[]> {
    const doc = (await store.get(spaceId, COLLECTION, DOC)) as unknown as
      | { entries?: LogEntry[] }
      | null;
    return doc?.entries ?? [];
  }

  return {
    async append(spaceId, e) {
      const entry: LogEntry = {
        id: randomUUID(),
        ts: new Date().toISOString(),
        level: e.level,
        source: e.source,
        message: clamp(e.message, MSG_MAX),
        detail: e.detail ? clamp(e.detail, DETAIL_MAX) : undefined,
        workflowId: e.workflowId,
      };
      const entries = [...(await read(spaceId)), entry].slice(-CAP);
      await store.put(spaceId, COLLECTION, DOC, {
        id: DOC,
        entries,
      } as unknown as Record<string, unknown>);
      return entry;
    },

    async list(spaceId, limit = 200) {
      const entries = await read(spaceId);
      return entries.slice(-limit).reverse(); // newest first
    },

    async clear(spaceId) {
      await store.put(spaceId, COLLECTION, DOC, {
        id: DOC,
        entries: [],
      } as unknown as Record<string, unknown>);
    },
  };
}
