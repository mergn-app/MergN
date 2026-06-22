import { randomUUID } from "node:crypto";
import type { DocStore } from "../store/docstore";
import type { ErrorType } from "./error-classify";
import type { FixMode, FixProposal } from "./fix-engine";

// Durable audit of every heal attempt (one immutable record per attempt). It is
// also the loop-protection counter source — read from here, never in-memory, so
// the cap survives restarts and is consistent across instances.

export type FixStatus = "proposed" | "applied" | "rejected" | "reverted" | "failed";

export type GateReason =
  | "cap-exceeded" // run-safety cap marker (infra saturation, not AI-fixable)
  | "not-logic" // auth/unknown never auto-apply
  | "low-confidence"
  | "danger-downstream"
  | "blast-too-wide"
  | "loop-cap"
  | "fix-ineffective"
  | "kill-switch"; // heal disabled for this space (plan / kill-switch)

export interface GateResult {
  allow: boolean;
  reason?: GateReason; // the first gate that refused
  attempts: number; // heal attempts already in the window (excludes this one)
}

export interface FixEvent {
  id: string;
  spaceId: string;
  workflowId: string;
  runId: string;
  versionId?: string; // present on applied/reverted
  mode: FixMode;
  status: FixStatus;
  errorType: ErrorType;
  confidence: "high" | "medium" | "low";
  diagnosis: string; // plain-language (already masked upstream)
  gate?: GateResult; // gating trace (auto mode)
  downgradeReason?: GateReason; // auto → propose downgrade cause
  proposal?: FixProposal; // carried so an approve can apply it deterministically
  revertedToVersionId?: string;
  approvedBy?: string;
  at: string; // ISO
}

export type NewFixEvent = Omit<FixEvent, "id" | "at">;

export interface HealEventStore {
  record(spaceId: string, ev: NewFixEvent): Promise<FixEvent>;
  get(spaceId: string, id: string): Promise<FixEvent | null>;
  update(spaceId: string, id: string, patch: Partial<FixEvent>): Promise<FixEvent | null>;
  // heal attempts for a flow within the trailing window (loop-protection counter)
  recentAttempts(spaceId: string, workflowId: string, windowMs: number): Promise<number>;
  listForWorkflow(spaceId: string, workflowId: string, limit?: number): Promise<FixEvent[]>;
}

const COLLECTION = "heal_events";

export function createHealEventStore(
  store: DocStore,
  now: () => number = () => Date.now(),
): HealEventStore {
  const all = async (spaceId: string): Promise<FixEvent[]> =>
    (await store.list(spaceId, COLLECTION)) as unknown as FixEvent[];
  return {
    async record(spaceId, ev) {
      const doc: FixEvent = { ...ev, id: randomUUID(), at: new Date(now()).toISOString() };
      await store.put(spaceId, COLLECTION, doc.id, doc as unknown as Record<string, unknown>);
      return doc;
    },
    async get(spaceId, id) {
      return (await store.get(spaceId, COLLECTION, id)) as unknown as FixEvent | null;
    },
    async update(spaceId, id, patch) {
      const existing = (await store.get(spaceId, COLLECTION, id)) as unknown as FixEvent | null;
      if (!existing) return null;
      const merged = { ...existing, ...patch, id: existing.id };
      await store.put(spaceId, COLLECTION, id, merged as unknown as Record<string, unknown>);
      return merged;
    },
    async recentAttempts(spaceId, workflowId, windowMs) {
      const cutoff = now() - windowMs;
      return (await all(spaceId)).filter(
        (e) => e.workflowId === workflowId && Date.parse(e.at) >= cutoff,
      ).length;
    },
    async listForWorkflow(spaceId, workflowId, limit) {
      const rows = (await all(spaceId))
        .filter((e) => e.workflowId === workflowId)
        .sort((a, b) => (a.at < b.at ? 1 : -1)); // newest-first
      return limit && limit > 0 ? rows.slice(0, limit) : rows;
    },
  };
}
