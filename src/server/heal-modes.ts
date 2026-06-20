import type { ErrorType } from "./error-classify";
import type { Diagnosis, DiagnosisContext, FixEngine, FixMode } from "./fix-engine";
import type { FixEvent, GateResult, HealEventStore, NewFixEvent } from "./heal-events";

// Turns a fix proposal into reality — safely, auditably, reversibly. Three
// modes: notify (just diagnose) / propose (default: await approval) / auto
// (apply only if the gates pass). It writes no fix logic — it wraps the
// FixEngine and puts mode + gating in front, so "an obedient bot can't burn the
// house down".

export interface HealTrigger {
  spaceId: string;
  workflowId: string;
  runId: string;
  errorType: ErrorType;
  error: string; // raw failure message (for the cap-exceedance pre-filter)
}

export interface HealCaps {
  blastMax: number; // max touched nodes for auto-apply
  attemptMax: number; // max heal attempts per flow in the window
  windowMs: number; // loop-protection window
}

// ── pure gating: auto-apply only when ALL gates pass ──────────────────────────
// Reads the signals the diagnosis already computed (errorType, confidence,
// blastRadius) — no graph re-scan, no numeric thresholds.
export function gateAutoApply(
  d: Diagnosis,
  attempts: number,
  caps: { blastMax: number; attemptMax: number },
): GateResult {
  // routing pre-gate: only `logic` is auto-fixable; auth/unknown never auto.
  if (d.errorType !== "logic" || !d.proposedFix) return { allow: false, reason: "not-logic", attempts };
  if (d.confidence !== "high") return { allow: false, reason: "low-confidence", attempts };
  // a fix that touches — or sits upstream of — a costly/catastrophic step is
  // never auto-applied (side-effect / payment / delete → always manual approval).
  if (d.blastRadius.dangerDownstream) return { allow: false, reason: "danger-downstream", attempts };
  if (d.blastRadius.touchedNodeIds.length > caps.blastMax) return { allow: false, reason: "blast-too-wide", attempts };
  if (attempts >= caps.attemptMax) return { allow: false, reason: "loop-cap", attempts };
  return { allow: true, attempts };
}

// A failure caused by a run-safety cap (invocation budget / fan-out / space
// concurrency) is classified `logic` but is infra saturation, NOT an AI-fixable
// code bug — recognised by the "out of range" marker the caps embed.
export function isCapExceedance(error: string | undefined): boolean {
  if (!error) return false;
  return /out of range/i.test(error) && /(invocation budget|fan-out|concurrency)/i.test(error);
}

export interface HealOrchestratorDeps {
  fixEngine: Pick<FixEngine, "diagnose" | "applyFix">;
  buildContext: (spaceId: string, runId: string) => Promise<DiagnosisContext | null>;
  events: HealEventStore;
  // per-flow mode + opt-in (default OFF). Until the settings milestone this is an
  // env/global default; later it becomes a per-flow store read.
  getFlowMode: (spaceId: string, workflowId: string) => Promise<{ enabled: boolean; fixMode: FixMode }>;
  // plan / kill-switch gate (heal disabled → surfaced, never auto-applied).
  canHeal: (spaceId: string, workflowId: string) => Promise<boolean>;
  caps: () => HealCaps;
  log: (
    spaceId: string,
    entry: { level: "info" | "warn" | "error"; message: string; detail?: string; workflowId: string },
  ) => void;
}

export interface HealOrchestrator {
  orchestrate(trigger: HealTrigger): Promise<FixEvent | null>;
}

export function createHealOrchestrator(deps: HealOrchestratorDeps): HealOrchestrator {
  const record = (spaceId: string, ev: NewFixEvent) => deps.events.record(spaceId, ev);

  return {
    async orchestrate(trigger) {
      const { spaceId, workflowId, runId, errorType, error } = trigger;

      const mode = await deps.getFlowMode(spaceId, workflowId).catch(() => ({ enabled: false, fixMode: "propose" as FixMode }));
      if (!mode.enabled) return null; // opt-in default OFF — silent no-op

      // heal enabled for this flow but blocked by plan / kill-switch → surface it
      if (!(await deps.canHeal(spaceId, workflowId).catch(() => false))) {
        return record(spaceId, mkEvent(trigger, mode.fixMode, {
          status: "failed",
          confidence: "low",
          diagnosis: "Healing is disabled for this space (plan or kill-switch).",
          downgradeReason: "kill-switch",
        }));
      }

      // run-safety cap saturation → not AI-fixable; notify-only + critical, no diagnose
      if (isCapExceedance(error)) {
        deps.log(spaceId, { level: "error", message: `Flow '${workflowId}' hit a run-safety cap — not auto-fixable`, detail: error, workflowId });
        return record(spaceId, mkEvent(trigger, mode.fixMode, {
          status: "failed",
          confidence: "low",
          diagnosis: "Run-safety cap exceeded — infrastructure saturation, not a code fix. Review manually.",
          gate: { allow: false, reason: "cap-exceeded", attempts: 0 },
        }));
      }

      const ctx = await deps.buildContext(spaceId, runId);
      if (!ctx) return null; // run vanished / not a failure

      // notify mode: diagnose only, no fix, no fix-event (the log IS the notice)
      if (mode.fixMode === "notify") {
        const d = await deps.fixEngine.diagnose(spaceId, ctx, { propose: false });
        deps.log(spaceId, { level: "info", message: `Diagnosis for '${workflowId}': ${d.plainLanguage}`, workflowId });
        return null;
      }

      const d = await deps.fixEngine.diagnose(spaceId, ctx);
      if (!d.proposedFix) {
        // auth/unknown or the heal-agent produced nothing → notify, no fix-event
        deps.log(spaceId, { level: "info", message: `Diagnosis for '${workflowId}' (no automatic fix): ${d.plainLanguage}`, workflowId });
        return null;
      }

      const base = { errorType: d.errorType, confidence: d.confidence, diagnosis: d.plainLanguage, proposal: d.proposedFix };

      // propose (default): record a proposal awaiting approval — no apply
      if (mode.fixMode === "propose") {
        return record(spaceId, mkEvent(trigger, "propose", { ...base, status: "proposed" }));
      }

      // auto: gate, then apply (or downgrade to a proposal)
      const { blastMax, attemptMax, windowMs } = deps.caps();
      const attempts = await deps.events.recentAttempts(spaceId, workflowId, windowMs);
      const gate = gateAutoApply(d, attempts, { blastMax, attemptMax });
      if (!gate.allow) {
        if (gate.reason === "loop-cap")
          deps.log(spaceId, { level: "error", message: `Auto-heal stopped for '${workflowId}' (loop cap) — manual review needed`, workflowId });
        return record(spaceId, mkEvent(trigger, "auto", { ...base, status: "proposed", gate, downgradeReason: gate.reason }));
      }
      try {
        const { versionId } = await deps.fixEngine.applyFix(spaceId, workflowId, d.proposedFix, { runId, mode: "auto" });
        deps.log(spaceId, { level: "info", message: `Healed '${workflowId}': ${d.plainLanguage}`, workflowId });
        return record(spaceId, mkEvent(trigger, "auto", { ...base, status: "applied", versionId, gate }));
      } catch (e) {
        deps.log(spaceId, { level: "error", message: `Auto-heal apply failed for '${workflowId}'`, detail: e instanceof Error ? e.message : String(e), workflowId });
        return record(spaceId, mkEvent(trigger, "auto", { ...base, status: "failed", gate, downgradeReason: "fix-ineffective" }));
      }
    },
  };
}

function mkEvent(
  trigger: HealTrigger,
  mode: FixMode,
  rest: Partial<NewFixEvent> & Pick<NewFixEvent, "status">,
): NewFixEvent {
  return {
    spaceId: trigger.spaceId,
    workflowId: trigger.workflowId,
    runId: trigger.runId,
    mode,
    errorType: trigger.errorType,
    confidence: "low",
    diagnosis: "",
    ...rest,
  };
}
