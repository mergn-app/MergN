import { classifyError, type ErrorType } from "./error-classify";
import { diffWorkflows, type WorkflowDiff, type WorkflowSnapshot } from "./workflow-diff";
import { downstreamOf } from "../engine/index";
import type { FuncNode } from "../atoms/index";
import type { ProviderDraft, Registry } from "../providers/registry";
import type { SavedWorkflow } from "./store";
import type { SealMeta, WorkflowVersion } from "./workflow-versions";
import { proposeFix } from "./heal-agent";

// ── FixEngine ─────────────────────────────────────────────────────────────────
// Deterministic, background (chat-less) diagnosis + fix-as-version. `diagnose`
// turns a failure into a plain-language explanation + a structured fix proposal;
// `applyFix` writes that proposal as a `source:"healing"` version. The engine
// makes NO mode/auto decision, shows NO UI, exposes NO tool — those are wrapped
// by later layers. It only composes the existing repair surfaces (provider /
// wiring / func authoring) behind one contract.

export type FixKind = "provider" | "wiring" | "step-code" | "retry-policy";
export type FixMode = "notify" | "propose" | "auto";

export interface DiagnosisContext {
  workflowId: string;
  failedRun: {
    runId: string;
    failedNodeId: string;
    error: string;
    resolvedInput: unknown;
    bodySource: string; // sourced from the workflow def — run steps don't carry it
  };
  lastGoodStepIO?: { output: unknown; resolvedInput: unknown };
  workflow: { funcs: unknown[]; wires: unknown[]; trigger: unknown };
}

export interface FixProposal {
  kind: FixKind;
  diff: WorkflowDiff;
  // descriptive surface (UI / audit):
  provider?: { id: string; draft: ProviderDraft; changeNote: string };
  wiring?: { wires: unknown[]; added: unknown[]; variableFields: string[]; diagnostics: string[] };
  stepCode?: { funcId: string; intent: string };
  // concrete next-state, carried from diagnose so applyFix is DETERMINISTIC (no
  // second LLM call): the funcs/wires to write and/or the provider draft to pin.
  apply: { funcs?: unknown[]; wires?: unknown[]; providerDraft?: ProviderDraft };
}

// What the heal-agent returns to the engine (LLM orchestration result).
export interface ProposeResult {
  kind: FixKind;
  plainLanguage: string;
  provider?: { id: string; draft: ProviderDraft; changeNote: string };
  wiring?: { wires: unknown[]; added: unknown[]; variableFields: string[]; diagnostics: string[] };
  stepCode?: { funcId: string; intent: string };
  apply: { funcs?: unknown[]; wires?: unknown[]; providerDraft?: ProviderDraft };
}

export interface Diagnosis {
  workflowId: string;
  runId: string;
  errorType: ErrorType;
  failedNodeId?: string;
  plainLanguage: string;
  proposedFix?: FixProposal;
  confidence: "high" | "medium" | "low";
  blastRadius: { dangerDownstream: boolean; touchedNodeIds: string[] };
}

export interface DiagnoseOptions {
  // language for the human-facing plainLanguage diagnosis (default English —
  // this is a global app). Callers pass the user's locale; the runtime/error
  // codes are language-independent.
  language?: string;
}

export interface FixEngine {
  diagnose(spaceId: string, ctx: DiagnosisContext, opts?: DiagnoseOptions): Promise<Diagnosis>;
  applyFix(
    spaceId: string,
    workflowId: string,
    proposal: FixProposal,
    meta: { runId: string; mode: FixMode },
  ): Promise<{ versionId: string }>;
}

export interface FixEngineDeps {
  registry: Registry;
  getWorkflow: (spaceId: string, id: string) => Promise<SavedWorkflow | null | undefined>;
  saveWorkflow: (spaceId: string, wf: SavedWorkflow) => Promise<unknown>;
  seal: (spaceId: string, head: SavedWorkflow, meta: SealMeta) => Promise<{ version: WorkflowVersion; deduped: boolean }>;
  setCurrentVersion: (spaceId: string, id: string, versionId: string) => Promise<void>;
  pinProviders: (spaceId: string, funcs: unknown[]) => Promise<Record<string, unknown>>;
  // Gate: may this space PRODUCE an LLM fix proposal? false → notify-only
  // (diagnose still returns plainLanguage + confidence, just no proposedFix).
  // Diagnosis itself is NEVER gated. Self-host → always true.
  canProposeFix: (spaceId: string) => Promise<boolean>;
  // The heal-agent orchestrator; injectable for testing (defaults to the real one).
  proposeFix?: (
    registry: Registry,
    spaceId: string,
    ctx: DiagnosisContext,
    errorType: ErrorType,
    language: string,
  ) => Promise<ProposeResult>;
}

// minimal read shapes for the stored func/wire entries (funcs/wires are unknown[])
interface FuncEntry {
  id: string;
  version?: number;
  pure?: boolean;
  requires?: { name: string; provider: string; scopes: string[] }[];
  dangerClass?: string | null;
  bodySource?: string;
}
interface WireEntry {
  from: string;
  to: string;
}

const NO_BLAST = { dangerDownstream: false, touchedNodeIds: [] as string[] };

export function createFixEngine(deps: FixEngineDeps): FixEngine {
  return {
    async diagnose(spaceId, ctx, opts) {
      const language = opts?.language || "English";
      const errorType = classifyError(ctx.failedRun.error);
      const base = {
        workflowId: ctx.workflowId,
        runId: ctx.failedRun.runId,
        errorType,
        failedNodeId: ctx.failedRun.failedNodeId || undefined,
      };

      // ── routing: not every error gets the AI treatment ────────────────────
      if (errorType === "transient") {
        // the runtime owns deterministic retry+backoff — never spend a token here.
        return {
          ...base,
          plainLanguage:
            "A temporary infrastructure error (network / timeout / service blip). It is retried automatically; no flow change is needed.",
          confidence: "high",
          blastRadius: NO_BLAST,
        };
      }
      if (errorType === "auth") {
        // credential is the user's — AI cannot fix it. Point at the reconnect.
        const provider = providerOf(ctx, ctx.failedRun.failedNodeId);
        return {
          ...base,
          plainLanguage: provider
            ? `The '${provider}' connection is invalid or expired. Reconnect it — no code fix is needed.`
            : "A connection/credential is invalid or expired. Reconnect the relevant connection.",
          confidence: "high",
          blastRadius: NO_BLAST,
        };
      }

      // ── logic / unknown → AI diagnosis + fix proposal ──────────────────────
      // Gate ONLY the fix proposal (LLM-fix), never the diagnosis itself.
      if (!(await deps.canProposeFix(spaceId).catch(() => false))) {
        return {
          ...base,
          plainLanguage: notifyOnlyMessage(ctx, errorType),
          confidence: errorType === "unknown" ? "low" : "medium",
          blastRadius: NO_BLAST,
        };
      }

      try {
        const propose = deps.proposeFix ?? proposeFix;
        const r = await propose(deps.registry, spaceId, ctx, errorType, language);
        const { head, proposed } = await buildSnapshots(deps, spaceId, ctx, r);
        const diff = diffWorkflows(head, proposed);
        const touchedNodeIds = computeTouched(diff, ctx.failedRun.failedNodeId);
        const dangerDownstream = computeDanger(ctx.workflow.funcs, ctx.workflow.wires, touchedNodeIds);
        return {
          ...base,
          plainLanguage: r.plainLanguage,
          proposedFix: {
            kind: r.kind,
            diff,
            provider: r.provider,
            wiring: r.wiring,
            stepCode: r.stepCode,
            apply: r.apply,
          },
          confidence: deriveConfidence(errorType, r),
          blastRadius: { dangerDownstream, touchedNodeIds },
        };
      } catch (e) {
        // A repair-surface / LLM failure must not throw into the caller — fall
        // back to a notify-only diagnosis (no proposed fix).
        return {
          ...base,
          plainLanguage: `Could not complete the diagnosis (${e instanceof Error ? e.message : String(e)}). Review this run manually.`,
          confidence: "low",
          blastRadius: NO_BLAST,
        };
      }
    },

    async applyFix(spaceId, workflowId, proposal, meta) {
      const head = await deps.getWorkflow(spaceId, workflowId);
      if (!head) throw new Error(`workflow ${workflowId} not found`);

      // Provider fix: mutate the registry in place. seal pins the new provider
      // code into the healing version (provider pinning), so the fix is revertible.
      if (proposal.apply.providerDraft) {
        deps.registry.registerProviderFromDraft(spaceId, proposal.apply.providerDraft);
        await deps.registry.persistProvider(spaceId, proposal.apply.providerDraft);
      }

      // Graph fix (wiring / step-code): write the proposed funcs/wires to HEAD
      // so future runs use the fix, THEN seal that exact state.
      let next: SavedWorkflow = head;
      if (proposal.apply.funcs || proposal.apply.wires) {
        next = {
          ...head,
          ...(proposal.apply.funcs ? { funcs: proposal.apply.funcs } : {}),
          ...(proposal.apply.wires ? { wires: proposal.apply.wires } : {}),
        };
        await deps.saveWorkflow(spaceId, next);
      }

      const { version, deduped } = await deps.seal(spaceId, next, {
        source: "healing",
        healing: { runId: meta.runId, diagnosis: diagnosisLabel(proposal) },
        createdBy: "heal-agent",
      });
      if (!deduped) await deps.setCurrentVersion(spaceId, workflowId, version.id);
      return { versionId: version.id };
    },
  };
}

// ── helpers ───────────────────────────────────────────────────────────────────

function providerOf(ctx: DiagnosisContext, nodeId: string): string | undefined {
  const f = (ctx.workflow.funcs as FuncEntry[]).find((x) => x.id === nodeId);
  return f?.requires?.[0]?.provider;
}

function notifyOnlyMessage(ctx: DiagnosisContext, errorType: ErrorType): string {
  const where = ctx.failedRun.failedNodeId ? `Step '${ctx.failedRun.failedNodeId}'` : "A step";
  return errorType === "unknown"
    ? `${where} failed for an unclear reason: ${truncate(ctx.failedRun.error, 160)}. Manual review is recommended.`
    : `${where} failed with a logic/configuration error: ${truncate(ctx.failedRun.error, 160)}.`;
}

function diagnosisLabel(proposal: FixProposal): string {
  if (proposal.provider) return `provider '${proposal.provider.id}': ${proposal.provider.changeNote}`;
  if (proposal.wiring) return `wiring: ${proposal.wiring.diagnostics.join("; ") || "rewired inputs"}`;
  if (proposal.stepCode) return `step '${proposal.stepCode.funcId}': ${proposal.stepCode.intent}`;
  return proposal.kind;
}

function deriveConfidence(errorType: ErrorType, r: ProposeResult): "high" | "medium" | "low" {
  if (errorType === "unknown") return "low";
  if (r.kind === "provider") return "high"; // input present, provider rejected — clear
  if (r.kind === "wiring") return (r.wiring?.diagnostics.length ?? 0) === 0 ? "high" : "medium";
  return "medium"; // step-code re-authoring is more speculative
}

function computeTouched(diff: WorkflowDiff, failedNodeId: string): string[] {
  const ids = new Set<string>();
  if (failedNodeId) ids.add(failedNodeId);
  for (const id of diff.nodes.added) ids.add(id);
  for (const id of diff.nodes.removed) ids.add(id);
  for (const m of diff.nodes.modified) ids.add(m.id);
  return [...ids];
}

// Danger signal for fix gating: does the fix touch — or sit upstream of — any
// non-benign (costly/catastrophic) step? Reuses the shared reverse-reachability
// helper (downstreamOf, owned by the engine) so there's one implementation.
function computeDanger(funcs: unknown[], wires: unknown[], touchedNodeIds: string[]): boolean {
  const entries = funcs as FuncEntry[];
  const dangerById = new Map(entries.map((f) => [f.id, f.dangerClass ?? null]));
  const isDanger = (id: string) => {
    const dc = dangerById.get(id);
    return !!dc && dc !== "benign";
  };
  if (touchedNodeIds.some(isDanger)) return true;
  const down = downstreamOf(funcsToNodes(entries, wires as WireEntry[]), touchedNodeIds);
  for (const id of down) if (isDanger(id)) return true;
  return false;
}

// Pseudo-nodes from the wire graph (from→to edges become dependsOn) so the
// shared downstreamOf helper can walk reverse reachability. bindings/gate aren't
// needed: dependenciesOf falls back to dependsOn.
function funcsToNodes(funcs: FuncEntry[], wires: WireEntry[]): FuncNode[] {
  const upstream = new Map<string, string[]>();
  for (const w of wires) {
    if (!w || w.from === "trigger") continue;
    const list = upstream.get(w.to);
    if (list) list.push(w.from);
    else upstream.set(w.to, [w.from]);
  }
  return funcs.map((f) => ({
    nodeId: f.id,
    funcId: f.id,
    funcVersion: f.version ?? 1,
    bindings: {},
    connections: {},
    dependsOn: upstream.get(f.id) ?? [],
  }));
}

async function buildSnapshots(
  deps: FixEngineDeps,
  spaceId: string,
  ctx: DiagnosisContext,
  r: ProposeResult,
): Promise<{ head: WorkflowSnapshot; proposed: WorkflowSnapshot }> {
  const headProviders = await deps.pinProviders(spaceId, ctx.workflow.funcs).catch(() => ({}));
  const head: WorkflowSnapshot = {
    funcs: ctx.workflow.funcs,
    wires: ctx.workflow.wires,
    trigger: ctx.workflow.trigger,
    providers: headProviders,
  };
  const proposed: WorkflowSnapshot = {
    funcs: r.apply.funcs ?? ctx.workflow.funcs,
    wires: r.apply.wires ?? ctx.workflow.wires,
    trigger: ctx.workflow.trigger,
    providers: r.apply.providerDraft
      ? { ...headProviders, [r.apply.providerDraft.id]: r.apply.providerDraft }
      : headProviders,
  };
  return { head, proposed };
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}
