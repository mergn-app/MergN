import type { DocStore } from "./docstore";
import { LIMITS } from "../limits";

// Instance-wide token spend guard. A single cumulative token counter across the
// whole deployment (all spaces/users). When it reaches the global cap, new AI
// chat turns are refused. Off by default (cap 0) — self-host never hits it; the
// managed/test deployment sets a cap so a test run can't run up an unbounded LLM
// bill. Approximate (no locking) — fine for a safety ceiling.

const CAP = LIMITS.globalTokenCap; // 0 = disabled (configured in src/limits.ts)
const SYS = "__sys";
const COLLECTION = "usage";
const KEY = "global-tokens";

let store: DocStore | null = null;
let total = 0;
let loaded = false;

export function initUsageCap(s: DocStore): void {
  store = s;
}

export function usageCapEnabled(): boolean {
  return CAP > 0;
}

async function ensureLoaded(): Promise<void> {
  if (loaded || !store) return;
  loaded = true; // set first so concurrent callers don't double-load
  try {
    const doc = await store.get(SYS, COLLECTION, KEY);
    total = Number(doc?.totalTokens) || 0;
  } catch {
    total = 0;
  }
}

// True once the cumulative token usage has reached the cap.
export async function usageCapExceeded(): Promise<boolean> {
  if (!CAP) return false;
  await ensureLoaded();
  return total >= CAP;
}

// Add an LLM call's token usage to the running total and persist it.
export async function recordTokens(tokens: number): Promise<void> {
  if (!CAP || !store || !tokens || tokens < 0) return;
  await ensureLoaded();
  total += tokens;
  try {
    await store.put(SYS, COLLECTION, KEY, {
      totalTokens: total,
      cap: CAP,
      updatedAt: new Date().toISOString(),
    });
  } catch {
    // best-effort; the in-memory total still guards within this process
  }
}

export function usageSnapshot(): { total: number; cap: number } {
  return { total, cap: CAP };
}
