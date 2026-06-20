import { randomUUID } from "node:crypto";
import type { NatsCtx } from "./nats";

export interface RunEvent {
  id: string;
  workflowId: string;
  status: string;
  trigger: string;
  errorType?: string; // set on failed runs (transient|auth|logic|unknown)
}

type Listener = (event: RunEvent) => void;

export interface RunEventsImpl {
  emit(spaceId: string, event: RunEvent): void;
  // async: a JetStream consumer is created per subscriber. Returns an
  // unsubscribe that tears it down.
  on(
    spaceId: string,
    workflowId: string,
    listener: Listener,
  ): Promise<() => void>;
}

// ── In-memory fallback (single process). Used until JetStream is wired, and as
// a safety net. Does NOT cross the API↔scheduler-consumer process boundary —
// which is exactly why production swaps in the JetStream impl below. ──────────
export function inMemoryRunEvents(): RunEventsImpl {
  const listeners = new Map<string, Set<Listener>>();
  const key = (s: string, w: string) => `${s} ${w}`;
  return {
    emit(spaceId, event) {
      const set = listeners.get(key(spaceId, event.workflowId));
      if (!set) return;
      for (const l of set) {
        try {
          l(event);
        } catch {
          void 0;
        }
      }
    },
    async on(spaceId, workflowId, listener) {
      const k = key(spaceId, workflowId);
      let set = listeners.get(k);
      if (!set) {
        set = new Set();
        listeners.set(k, set);
      }
      set.add(listener);
      return () => {
        set!.delete(listener);
        if (set!.size === 0) listeners.delete(k);
      };
    },
  };
}

// ── JetStream impl — durable, cross-process, multi-instance. emit publishes to
// `<prefix>.<spaceId>.<workflowId>`; each subscriber is an ephemeral, new-only,
// no-ack consumer (a live tail), auto-removed if its SSE connection drops. ────
export function jetStreamRunEvents(
  nats: NatsCtx,
  streamName: string,
  subjectPrefix: string,
): RunEventsImpl {
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const subjectFor = (spaceId: string, wfId: string) =>
    `${subjectPrefix}.${spaceId}.${wfId}`;

  return {
    emit(spaceId, event) {
      void nats.js
        .publish(
          subjectFor(spaceId, event.workflowId),
          enc.encode(JSON.stringify(event)),
        )
        .catch(() => {});
    },

    async on(spaceId, workflowId, listener) {
      // unique per-subscriber consumer name (no dots); deleted on unsubscribe,
      // and auto-removed after 60s of inactivity if the SSE dies uncleanly.
      const name = `sse_${randomUUID().replace(/-/g, "")}`;
      await nats.jsm.consumers.add(streamName, {
        durable_name: name,
        filter_subject: subjectFor(spaceId, workflowId),
        ack_policy: "none",
        deliver_policy: "new",
        inactive_threshold: 60_000_000_000, // 60s in ns
      });
      const consumer = await nats.js.consumers.get(streamName, name);
      const iter = await consumer.consume();
      void (async () => {
        try {
          for await (const m of iter) {
            try {
              listener(JSON.parse(dec.decode(m.data)) as RunEvent);
            } catch {
              void 0;
            }
          }
        } catch {
          void 0; // iterator stopped
        }
      })();
      return () => {
        try {
          iter.stop();
        } catch {
          void 0;
        }
        void nats.jsm.consumers.delete(streamName, name).catch(() => {});
      };
    },
  };
}

// ── Facade: callers import emitRun/onRun unchanged. initRunEvents swaps the
// in-memory default for JetStream at boot. ──────────────────────────────────
let impl: RunEventsImpl = inMemoryRunEvents();

export function initRunEvents(next: RunEventsImpl): void {
  impl = next;
}

export function emitRun(spaceId: string, event: RunEvent): void {
  impl.emit(spaceId, event);
}

export function onRun(
  spaceId: string,
  workflowId: string,
  listener: Listener,
): Promise<() => void> {
  return impl.on(spaceId, workflowId, listener);
}
