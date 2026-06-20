import type { DocStore } from "../store/docstore";
import type { IdempotencyStore, IdemKey } from "../engine/index";

// DocStore-backed idempotency claim store (cross-instance: the run consumer is a
// separate process, so an in-memory map would not be reliable). One doc per
// (runId, funcId, eventHash). Dormant until a func declares a non-"none"
// idempotency mechanism — no docs are written for the default-"none" path.

const COLLECTION = "idempotency";
const docId = (k: IdemKey) => `${k.runId}:${k.funcId}:${k.eventHash}`;

export function createIdempotencyStore(store: DocStore): IdempotencyStore {
  return {
    async claim(spaceId, key) {
      const id = docId(key);
      const existing = await store.get(spaceId, COLLECTION, id).catch(() => null);
      if (existing?.status === "complete") {
        // side-effect already landed in a prior attempt/replay → reuse output
        return { claimed: false, cachedOutput: existing.output };
      }
      // absent, or a half-finished "claimed" whose run crashed before completing:
      // (re)claim and let the caller run. Half-claims re-run by design — the
      // side-effect may not have happened (at-least-once; the mechanism absorbs
      // the repeat). The cached output is RAW so downstream steps see real
      // values on reuse; it is per-space, written only for opted-in effects.
      await store.put(spaceId, COLLECTION, id, {
        ...key,
        spaceId,
        status: "claimed",
        at: new Date().toISOString(),
      });
      return { claimed: true };
    },
    async complete(spaceId, key, output) {
      await store.put(spaceId, COLLECTION, docId(key), {
        ...key,
        spaceId,
        status: "complete",
        output: output as unknown,
        at: new Date().toISOString(),
      });
    },
  };
}
