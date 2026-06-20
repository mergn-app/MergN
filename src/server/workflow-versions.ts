import { randomUUID } from "node:crypto";
import type { DocStore } from "../store/docstore";
import type { SavedWorkflow } from "./store";
import { contentHash, type WorkflowSnapshot } from "./workflow-diff";
import { LIMITS } from "../limits";

// Append-only workflow version log. HEAD lives in the "workflows"
// collection (unchanged); this store owns the immutable snapshots. Sealing is
// content-hash deduped against the LATEST version so bursty autosave / MCP
// builds coalesce into one version. Restore orchestration (which writes HEAD)
// lives in the endpoint, keeping this store focused on the version collection.
const COLLECTION = "workflow_versions";

export type VersionSource =
  | "editor"
  | "chat"
  | "mcp"
  | "run-snapshot"
  | "healing"
  | "restore";

export interface WorkflowVersion {
  id: string;
  workflowId: string;
  contentHash: string;
  snapshot: WorkflowSnapshot;
  source: VersionSource;
  label?: string;
  message?: string;
  parentVersionId?: string;
  restoredFrom?: string;
  healing?: { runId: string; diagnosis: string };
  createdAt: string;
  createdBy?: string;
}

export interface VersionMeta {
  id: string;
  workflowId: string;
  seq: number; // display number; 1 = oldest (computed at read time, no counter)
  source: VersionSource;
  label?: string;
  message?: string;
  restoredFrom?: string;
  createdAt: string;
}

export interface SealMeta {
  source: VersionSource;
  label?: string;
  message?: string;
  restoredFrom?: string;
  healing?: { runId: string; diagnosis: string };
  createdBy?: string;
}

export interface VersionStore {
  seal(
    spaceId: string,
    head: SavedWorkflow,
    meta: SealMeta,
  ): Promise<{ version: WorkflowVersion; deduped: boolean }>;
  list(spaceId: string, workflowId: string): Promise<VersionMeta[]>;
  get(spaceId: string, versionId: string): Promise<WorkflowVersion | null>;
  latest(spaceId: string, workflowId: string): Promise<WorkflowVersion | null>;
  prune(spaceId: string, workflowId: string): Promise<number>;
}

// Total, stable order: createdAt asc, id as tiebreaker (same-ms seals).
const byCreatedAt = (a: WorkflowVersion, b: WorkflowVersion): number =>
  a.createdAt !== b.createdAt
    ? a.createdAt < b.createdAt
      ? -1
      : 1
    : a.id.localeCompare(b.id);

// Pure prune-selection (policy), testable with an explicit cap (no env needed).
// Keeps healing/restore/labeled always + the most recent `cap` of the rest;
// returns the oldest excess to remove. cap = NO_CAP / ≤0 → never prune.
export function selectPrunable(
  all: WorkflowVersion[],
  cap: number,
): WorkflowVersion[] {
  if (!Number.isFinite(cap) || cap >= Number.MAX_SAFE_INTEGER || cap <= 0)
    return [];
  const keepAlways = (v: WorkflowVersion) =>
    v.source === "healing" || v.source === "restore" || !!v.label;
  const prunable = [...all]
    .sort(byCreatedAt)
    .filter((v) => !keepAlways(v)); // oldest first
  const excess = prunable.length - cap;
  return excess <= 0 ? [] : prunable.slice(0, excess);
}

const snapshotOf = (wf: SavedWorkflow): WorkflowSnapshot => ({
  name: wf.name,
  funcs: wf.funcs,
  wires: wf.wires,
  positions: wf.positions,
  config: wf.config,
  nodeConnections: wf.nodeConnections,
  trigger: wf.trigger,
  inputForm: wf.inputForm,
  variables: wf.variables,
});

export interface VersionStoreOpts {
  // Resolve the provider drafts (clientSource + metadata, secret-free) that the
  // given funcs require, so each sealed version pins the provider code it ran
  // against. Injected (not imported) to keep this store free of the registry.
  pinProviders?: (
    spaceId: string,
    funcs: unknown[],
  ) => Promise<Record<string, unknown>>;
}

export function createVersionStore(
  store: DocStore,
  opts: VersionStoreOpts = {},
): VersionStore {
  // All versions for a workflow, oldest → newest (createdAt asc).
  async function allFor(
    spaceId: string,
    workflowId: string,
  ): Promise<WorkflowVersion[]> {
    const docs = (await store.list(
      spaceId,
      COLLECTION,
    )) as unknown as WorkflowVersion[];
    return docs
      .filter((v) => v.workflowId === workflowId)
      .sort(byCreatedAt);
  }

  async function latest(
    spaceId: string,
    workflowId: string,
  ): Promise<WorkflowVersion | null> {
    const all = await allFor(spaceId, workflowId);
    return all.length ? all[all.length - 1] : null;
  }

  async function prune(spaceId: string, workflowId: string): Promise<number> {
    const all = await allFor(spaceId, workflowId);
    const toRemove = selectPrunable(all, LIMITS.versionRetentionMax);
    for (const v of toRemove) await store.remove(spaceId, COLLECTION, v.id);
    return toRemove.length;
  }

  return {
    latest,
    prune,

    async seal(spaceId, head, meta) {
      const workflowId = head.id;
      const base = snapshotOf(head);
      // Pin the provider code this version requires (if a resolver is wired).
      // Empty result → omit the field (backward-compatible hash for no-provider
      // workflows). Provider-code change → different hash → new version.
      const providers = opts.pinProviders
        ? await opts.pinProviders(spaceId, (head.funcs ?? []) as unknown[])
        : undefined;
      const snapshot: WorkflowSnapshot =
        providers && Object.keys(providers).length
          ? { ...base, providers }
          : base;
      const hash = contentHash(snapshot);
      const prev = await latest(spaceId, workflowId);
      // Dedup vs the latest version only: consecutive identical saves coalesce,
      // but reverting to an older identical state still creates a new point.
      if (prev && prev.contentHash === hash)
        return { version: prev, deduped: true };

      const version: WorkflowVersion = {
        id: randomUUID(),
        workflowId,
        contentHash: hash,
        snapshot,
        source: meta.source,
        ...(meta.label ? { label: meta.label } : {}),
        ...(meta.message ? { message: meta.message } : {}),
        ...(prev ? { parentVersionId: prev.id } : {}),
        ...(meta.restoredFrom ? { restoredFrom: meta.restoredFrom } : {}),
        ...(meta.healing ? { healing: meta.healing } : {}),
        createdAt: new Date().toISOString(),
        ...(meta.createdBy ? { createdBy: meta.createdBy } : {}),
      };
      await store.put(
        spaceId,
        COLLECTION,
        version.id,
        version as unknown as Record<string, unknown>,
      );
      await prune(spaceId, workflowId);
      return { version, deduped: false };
    },

    async list(spaceId, workflowId) {
      const all = await allFor(spaceId, workflowId); // asc
      const metas = all.map(
        (v, i): VersionMeta => ({
          id: v.id,
          workflowId: v.workflowId,
          seq: i + 1, // 1 = oldest
          source: v.source,
          ...(v.label ? { label: v.label } : {}),
          ...(v.message ? { message: v.message } : {}),
          ...(v.restoredFrom ? { restoredFrom: v.restoredFrom } : {}),
          createdAt: v.createdAt,
        }),
      );
      return metas.reverse(); // newest first for the UI
    },

    async get(spaceId, versionId) {
      return (await store.get(
        spaceId,
        COLLECTION,
        versionId,
      )) as unknown as WorkflowVersion | null;
    },
  };
}
