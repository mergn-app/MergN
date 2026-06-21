import { randomUUID } from "node:crypto";
import type { DocStore } from "../store/docstore";

// Deployment-wide governance: the global auto-fix kill-switch + an immutable
// audit trail. The kill-switch GATES AI-fix application only — it never stops
// signals, runs, or alerts. The audit trail is append-only and separate from the
// capped log ring buffer, so a governance record is never overwritten.

const SYS = "__sys"; // deployment-wide pseudo-space (same convention as usage-cap)
const GOV = "governance";
const KILL = "heal-kill-switch";

export interface Governance {
  killSwitch(): Promise<boolean>;
  setKillSwitch(on: boolean): Promise<void>;
}

export function createGovernance(store: DocStore): Governance {
  let cached: boolean | null = null; // in-memory mirror (best-effort), like usage-cap
  return {
    async killSwitch() {
      if (cached === null) {
        const doc = (await store.get(SYS, GOV, KILL)) as { on?: boolean } | null;
        cached = !!doc?.on;
      }
      return cached;
    },
    async setKillSwitch(on) {
      cached = on;
      await store.put(SYS, GOV, KILL, { on, updatedAt: new Date().toISOString() });
    },
  };
}

// ── Immutable audit trail (append-only; one doc per entry, never mutated) ──
const AUDIT = "audit";

export type AuditKind =
  | "settings.changed"
  | "killswitch.toggled"
  | "heal.applied"
  | "heal.rejected";

export interface AuditEntry {
  id: string;
  ts: string;
  kind: AuditKind;
  message: string;
  workflowId?: string;
  actor?: string; // userId / "system" / "mcp"
}

export interface AuditStore {
  record(spaceId: string, e: Omit<AuditEntry, "id" | "ts">): Promise<void>;
  list(spaceId: string, opts?: { workflowId?: string; limit?: number }): Promise<AuditEntry[]>;
}

export function createAuditStore(store: DocStore): AuditStore {
  return {
    async record(spaceId, e) {
      const entry: AuditEntry = { id: randomUUID(), ts: new Date().toISOString(), ...e };
      await store.put(spaceId, AUDIT, entry.id, entry as unknown as Record<string, unknown>);
    },
    async list(spaceId, opts) {
      const docs = (await store.list(spaceId, AUDIT)) as unknown as AuditEntry[];
      return docs
        .filter((d) => !opts?.workflowId || d.workflowId === opts.workflowId)
        .sort((a, b) => (a.ts < b.ts ? 1 : -1))
        .slice(0, opts?.limit ?? 100);
    },
  };
}
