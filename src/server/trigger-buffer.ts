import { randomUUID } from "node:crypto";
import type { DocStore } from "../store/docstore";
import type { Cipher } from "../store/cipher";
import { LIMITS } from "../limits";

// Durable, FIFO buffer of trigger events received while a flow is paused — the
// no-data-loss queue. DocStore-backed (the drain's FIFO truth source; durable +
// cross-instance via mongo). The raw event payload is sealed at rest with the
// same cipher as secrets/resume-seeds (Vault Transit on managed, raw on
// self-host) — callers always see plaintext; the cipher is internal here.
//
// NOTE: a JetStream durability mirror on `mergn.buffer.<space>.<wf>` belongs to
// the event-bus layer (stream config/retention). DocStore is the authoritative
// drain source (a single-pass drain can't ride a long-lived consume loop), so the
// buffer is fully functional without the mirror; wiring it is a later hook.
const COLLECTION = "buffer_entries";

export type BufferStatus = "buffered" | "replaying" | "replayed" | "failed";

export interface BufferEntry {
  id: string;
  spaceId: string;
  workflowId: string;
  seq: number; // monotonic FIFO order (per workflow)
  trigger: "webhook"; // MVP: only webhooks buffer (schedule/poll skip+mark)
  payload: Record<string, unknown>; // RAW event body — what replay re-runs
  headers?: Record<string, string>;
  status: BufferStatus;
  receivedAt: string;
  replayedRunId?: string;
  resumeFromRunId?: string; // pre-pause half-run to resume from (resume anchor)
}

// At rest: `payload` is dropped in favour of `sealedPayload` when a cipher exists.
type StoredEntry = Omit<BufferEntry, "payload"> & {
  payload?: Record<string, unknown>;
  sealedPayload?: string;
};

export interface EnqueueResult {
  ok: boolean;
  overflow?: boolean; // cap reached — caller hard-stops the flow + 503s the sender
  entry?: BufferEntry;
}

export interface BufferStore {
  enqueue(
    spaceId: string,
    workflowId: string,
    payload: Record<string, unknown>,
    opts?: { headers?: Record<string, string>; resumeFromRunId?: string },
  ): Promise<EnqueueResult>;
  list(spaceId: string, workflowId: string): Promise<BufferEntry[]>; // seq asc
  peekFirst(spaceId: string, workflowId: string): Promise<BufferEntry | null>;
  setStatus(
    spaceId: string,
    entryId: string,
    status: BufferStatus,
    patch?: { replayedRunId?: string },
  ): Promise<void>;
  remove(spaceId: string, entryId: string): Promise<void>;
  count(spaceId: string, workflowId: string, status?: BufferStatus): Promise<number>;
}

const byFifo = (a: BufferEntry, b: BufferEntry): number =>
  a.seq !== b.seq
    ? a.seq - b.seq
    : a.receivedAt !== b.receivedAt
      ? a.receivedAt < b.receivedAt
        ? -1
        : 1
      : a.id.localeCompare(b.id);

export function createBufferStore(store: DocStore, cipher: Cipher | null = null): BufferStore {
  async function seal(payload: Record<string, unknown>): Promise<Partial<StoredEntry>> {
    if (!cipher) return { payload };
    return { sealedPayload: await cipher.encrypt(JSON.stringify(payload)) };
  }
  async function unseal(s: StoredEntry): Promise<BufferEntry> {
    let payload = s.payload ?? {};
    if (s.sealedPayload && cipher) {
      try {
        payload = JSON.parse(await cipher.decrypt(s.sealedPayload)) as Record<string, unknown>;
      } catch (e) {
        console.error(`buffer payload unseal failed [${s.id}]`, e);
      }
    }
    const { sealedPayload: _s, ...rest } = s;
    return { ...rest, payload } as BufferEntry;
  }

  async function rawFor(spaceId: string, workflowId: string): Promise<StoredEntry[]> {
    const docs = (await store.list(spaceId, COLLECTION)) as unknown as StoredEntry[];
    return docs.filter((e) => e.workflowId === workflowId);
  }

  return {
    async enqueue(spaceId, workflowId, payload, opts) {
      const raw = await rawFor(spaceId, workflowId);
      const pending = raw.filter((e) => e.status === "buffered" || e.status === "replaying").length;
      // Cap is a hard stop, never drop-oldest (that loses data). NO_CAP → never trips.
      if (pending >= LIMITS.bufferMaxEntries) return { ok: false, overflow: true };
      const seq = raw.reduce((m, e) => Math.max(m, e.seq), 0) + 1;
      const id = randomUUID();
      const stored: StoredEntry = {
        id,
        spaceId,
        workflowId,
        seq,
        trigger: "webhook",
        status: "buffered",
        receivedAt: new Date().toISOString(),
        ...(opts?.headers ? { headers: opts.headers } : {}),
        ...(opts?.resumeFromRunId ? { resumeFromRunId: opts.resumeFromRunId } : {}),
        ...(await seal(payload)),
      };
      await store.put(spaceId, COLLECTION, id, stored as unknown as Record<string, unknown>);
      return { ok: true, entry: { ...stored, payload } as BufferEntry };
    },

    async list(spaceId, workflowId) {
      const raw = await rawFor(spaceId, workflowId);
      const entries = await Promise.all(raw.map((e) => unseal(e)));
      return entries.sort(byFifo);
    },

    async peekFirst(spaceId, workflowId) {
      const buffered = (await rawFor(spaceId, workflowId)).filter((e) => e.status === "buffered");
      if (!buffered.length) return null;
      const first = (await Promise.all(buffered.map((e) => unseal(e)))).sort(byFifo)[0];
      return first ?? null;
    },

    async setStatus(spaceId, entryId, status, patch) {
      const doc = (await store.get(spaceId, COLLECTION, entryId)) as unknown as StoredEntry | null;
      if (!doc) return;
      await store.put(spaceId, COLLECTION, entryId, {
        ...doc,
        status,
        ...(patch?.replayedRunId ? { replayedRunId: patch.replayedRunId } : {}),
      } as unknown as Record<string, unknown>);
    },

    async remove(spaceId, entryId) {
      await store.remove(spaceId, COLLECTION, entryId);
    },

    async count(spaceId, workflowId, status) {
      const raw = await rawFor(spaceId, workflowId);
      return status ? raw.filter((e) => e.status === status).length : raw.length;
    },
  };
}
