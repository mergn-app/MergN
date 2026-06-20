import type { DocStore } from "../store/docstore";
import { LIMITS } from "../limits";

// Per-space concurrent-run ceiling. A persistent counter (DocStore
// __sys/concurrency/<spaceId>) incremented at run start and decremented at
// finalize — O(1) per run, NOT a listRuns scan on the hot path (which a poll /
// schedule storm would make quadratic). Approximate and lockless: a safety
// ceiling like usage-cap, not an exact quota. Crashed runs can leak the counter
// upward, so when it *appears* full it reconciles once against the real
// running-run count before refusing — otherwise a space could brick forever.

const SYS = "__sys";
const COLLECTION = "concurrency";
const CAP = LIMITS.maxSpaceConcurrency;
const UNCAPPED = CAP === Number.MAX_SAFE_INTEGER; // NO_CAP sentinel (self-host)

export interface ConcurrencyGuard {
  // Increments and returns true when under the cap; false when the cap is
  // reached (the caller refuses the run). Always true when uncapped (no IO).
  tryAcquire(spaceId: string): Promise<boolean>;
  // Decrements, floored at 0. No-op when uncapped.
  release(spaceId: string): Promise<void>;
}

export interface ConcurrencyDeps {
  store: DocStore;
  // Real count of currently-running runs for a space (drift reconciliation).
  countActive: (spaceId: string) => Promise<number>;
}

export function createConcurrencyGuard(deps: ConcurrencyDeps): ConcurrencyGuard {
  const read = async (spaceId: string): Promise<number> => {
    const doc = await deps.store.get(SYS, COLLECTION, spaceId).catch(() => null);
    return Number(doc?.active) || 0;
  };
  const write = (spaceId: string, active: number): Promise<void> =>
    deps.store
      .put(SYS, COLLECTION, spaceId, {
        active,
        cap: CAP,
        updatedAt: new Date().toISOString(),
      })
      .catch(() => {});
  return {
    async tryAcquire(spaceId) {
      if (UNCAPPED) return true; // self-host: no IO, always pass
      let active = await read(spaceId);
      if (active >= CAP) {
        // counter looks full — reconcile against reality before refusing
        active = await deps.countActive(spaceId).catch(() => active);
        if (active >= CAP) {
          await write(spaceId, active);
          return false;
        }
      }
      await write(spaceId, active + 1);
      return true;
    },
    async release(spaceId) {
      if (UNCAPPED) return;
      const active = await read(spaceId);
      await write(spaceId, Math.max(0, active - 1));
    },
  };
}
