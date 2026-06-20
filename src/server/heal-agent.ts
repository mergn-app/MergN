import { repairProvider } from "../agent/provider-author";
import { reconcileWiring } from "../agent/wiring-repair";
import { authorFunc } from "../agent/func-author";
import { genObject } from "../agent/generate";
import { trace } from "../observability";
import { z } from "zod";
import { funcToWire } from "./func-wire";
import type { Registry } from "../providers/registry";
import type { ErrorType } from "./error-classify";
import type { DiagnosisContext, ProposeResult } from "./fix-engine";

// The heal-agent orchestrates the existing repair surfaces (provider/wiring/func
// authoring) behind a deterministic pre-triage — it invents no new repair logic.
// Lives in the server layer (not src/agent) because it composes server concerns
// (funcToWire stored shape, FixEngine types) on top of the agent primitives.

interface FuncEntry {
  id: string;
  version?: number;
  pure?: boolean;
  requires?: { name: string; provider: string; scopes: string[] }[];
}

// Turns a logic/unknown failure into a concrete fix proposal. Pre-triage is
// DETERMINISTIC (no LLM); only the chosen repair surface + the plain-language
// diagnosis spend tokens (auto-budgeted inside genObject).
export async function proposeFix(
  registry: Registry,
  spaceId: string,
  ctx: DiagnosisContext,
  _errorType: ErrorType,
  language = "English",
): Promise<ProposeResult> {
  const meta = { spaceId };
  const funcs = ctx.workflow.funcs as FuncEntry[];
  const failed = funcs.find((f) => f.id === ctx.failedRun.failedNodeId);
  const providerId = failed?.requires?.[0]?.provider;
  const inputPresent = !isEmptyObject(ctx.failedRun.resolvedInput);

  // ── pre-triage (chat-prose → code): provider rejection vs flow problem ──────
  // Data present but an effectful step's provider rejected it → repair provider.
  if (providerId && inputPresent) {
    const draft = await registry.getProviderDraft(spaceId, providerId).catch(() => null);
    if (draft) {
      const { draft: repaired, changeNote } = await repairProvider(
        draft,
        ctx.failedRun.error,
        ctx.failedRun.bodySource || undefined,
        safeJson(ctx.failedRun.resolvedInput),
        meta,
      );
      return {
        kind: "provider",
        plainLanguage: await diagnoseSentence(ctx, "provider", changeNote, spaceId, language),
        provider: { id: providerId, draft: repaired, changeNote },
        apply: { providerDraft: repaired },
      };
    }
    // no editable draft (builtin / missing) → fall through to a flow fix
  }

  // ── flow problem (missing data) or pure-func code bug ──────────────────────
  // Try a deterministic wiring repair first; only re-author the step if wiring
  // has nothing to bridge.
  const eventFields = (ctx.workflow.trigger as { eventFields?: string[] } | undefined)?.eventFields ?? [];
  const recon = await reconcileWiring(
    ctx.workflow.funcs as Parameters<typeof reconcileWiring>[0],
    ctx.workflow.wires as Parameters<typeof reconcileWiring>[1],
    eventFields,
    meta,
  ).catch(() => null);
  if (recon && recon.added.length > 0) {
    return {
      kind: "wiring",
      plainLanguage: await diagnoseSentence(ctx, "wiring", recon.diagnostics.join("; ") || "rewired inputs", spaceId, language),
      wiring: { wires: recon.wires, added: recon.added, variableFields: recon.variableFields, diagnostics: recon.diagnostics },
      apply: { wires: recon.wires },
    };
  }

  // ── step-code: re-author the failing step (same id) to handle the error ─────
  const intent = `Fix this step so it no longer fails with: "${truncate(ctx.failedRun.error, 200)}". Keep its original purpose and read its inputs the same way.`;
  const authored = await authorFunc(
    registry,
    { spaceId, intent, provider: providerId, triggerHint: triggerHint(ctx) },
    meta,
  );
  const newFunc = funcToWire({ ...authored.def, id: ctx.failedRun.failedNodeId }, authored.title, authored.summary);
  const nextFuncs = (ctx.workflow.funcs as FuncEntry[]).map((f) =>
    f.id === ctx.failedRun.failedNodeId ? (newFunc as unknown as FuncEntry) : f,
  );
  return {
    kind: "step-code",
    plainLanguage: await diagnoseSentence(ctx, "step-code", authored.summary, spaceId, language),
    stepCode: { funcId: ctx.failedRun.failedNodeId, intent },
    apply: { funcs: nextFuncs },
  };
}

// One short plain-language diagnosis sentence (the headline diagnosis output).
// Budget is enforced + counted automatically inside genObject.
async function diagnoseSentence(
  ctx: DiagnosisContext,
  kind: string,
  fixNote: string,
  spaceId: string,
  language: string,
): Promise<string> {
  const out = await genObject({
    schema: z.object({
      plainLanguage: z
        .string()
        .describe(`ONE short plain-language sentence in ${language}: why the step failed and what the fix changes`),
    }),
    system: `You explain a workflow step failure to a non-technical user in ONE short sentence, written in ${language}. State plainly why it failed and what the proposed fix does. No jargon, no stack traces, no code.`,
    prompt: [
      `Failed step: ${ctx.failedRun.failedNodeId}`,
      `Error: ${ctx.failedRun.error}`,
      ctx.failedRun.bodySource ? `Step code:\n${truncate(ctx.failedRun.bodySource, 1200)}` : "",
      `Resolved input: ${safeJson(ctx.failedRun.resolvedInput)}`,
      ctx.lastGoodStepIO ? `A previous SUCCESSFUL run of this step had input: ${safeJson(ctx.lastGoodStepIO.resolvedInput)}` : "",
      `Proposed fix type: ${kind}. What the fix does: ${fixNote}`,
    ]
      .filter(Boolean)
      .join("\n\n"),
    telemetry: trace("heal-diagnose", { spaceId }),
    spaceId,
  });
  return out.plainLanguage.trim();
}

function triggerHint(ctx: DiagnosisContext): string | undefined {
  const t = ctx.workflow.trigger as { kind?: string; eventFields?: string[] } | undefined;
  if (t?.eventFields?.length)
    return `The trigger delivers items with these exact fields: ${t.eventFields.join(", ")}. Read event data from those input names.`;
  return undefined;
}

function isEmptyObject(v: unknown): boolean {
  return !v || (typeof v === "object" && !Array.isArray(v) && Object.keys(v as object).length === 0);
}
function safeJson(v: unknown): string {
  try {
    return truncate(JSON.stringify(v) ?? "null", 800);
  } catch {
    return "null";
  }
}
function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}
