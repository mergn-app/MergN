import { trace, flushTraces } from "../observability";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { existsSync } from "node:fs";
import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";
import { HTTPException } from "hono/http-exception";
import {
  streamText,
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  createIdGenerator,
  tool,
  stepCountIs,
  type ToolSet,
  type UIMessage,
  type UIMessageStreamWriter,
} from "ai";
import {
  getModel,
  setLlmConfig,
  getLlmConfig,
  setSpaceLlmConfig,
  getSpaceLlmConfig,
  spaceUsesOwnKey,
  type LlmConfig,
} from "../agent/model";
import { z } from "zod";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { authorFunc } from "../agent/func-author";
import { createWorkflowStore, type TriggerConfig, type WorkflowStore } from "./store";
import { createVersionStore } from "./workflow-versions";
import { diffWorkflows } from "./workflow-diff";
import { createRunStore, type RunDoc, type RunHeader } from "./runs";
import { createBufferStore } from "./trigger-buffer";
import { replayBuffer, testRunFirst, type ReplayDeps } from "./buffer-replay";
import { computeAnalytics } from "./analytics";
import { createFlowSettingsStore, type FlowSettings } from "./flow-settings";
import { createGovernance, createAuditStore } from "./governance";
import { maskValue, maskErrorString, resolveMaskLevel, type MaskLevel } from "./pii-mask";
import { createSettingsStore } from "./settings";
import { createMcpTokenStore } from "./mcp-tokens";
import { createMcpOAuth, OAuthError } from "./mcp-oauth";
import { createRemoteMcpServer, type RemoteMcpDeps } from "./mcp-remote";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  createMemoryRateLimiter,
  type RateLimitResult,
  type RateLimitRule,
} from "./ratelimit";
import { runWorkflow } from "./run";
import { createIdempotencyStore } from "./idempotency";
import { createConcurrencyGuard } from "./concurrency";
import { createFixEngine, type FixMode } from "./fix-engine";
import { buildDiagnosisContext } from "./diagnosis-context";
import { createHealEventStore } from "./heal-events";
import { createHealOrchestrator } from "./heal-modes";
import { createHealDispatcher } from "./heal-dispatcher";
import {
  emitRun,
  onRun,
  initRunEvents,
  jetStreamRunEvents,
} from "./run-events";
import { classifyError, type ErrorType } from "./error-classify";
import {
  evaluateOutcome,
  maskedIsEmpty,
  type OutcomeConfig,
  type OutcomeFail,
} from "./outcome";
import type { LivenessConfig } from "./webhook-liveness";
import { checkConnectionBindings, bindingsOf } from "./connection-check";
import {
  createHealthMonitor,
  type HealthState,
  type HealthStatus,
} from "./health";
import { createAlertChannelStore } from "./alert-store";
import { createAlertHandlerStore } from "./alert-handlers";
import { createAlertService } from "./alert-service";
import type { ChannelKind, ChannelSecret } from "./alert-channels";
import type { Severity, AlertCategory } from "./alert-router";
import { createLivenessEvaluator } from "./liveness";
import { createRegistry, publicAuth, type ProviderDraft } from "../providers/registry";
import { assertSpace, type DocStore } from "../store/docstore";
import { createStorage, createCipher } from "../store/factory";
import {
  initUsageCap,
  recordTokens,
  usageCapExceeded,
} from "../store/usage-cap";
import {
  authorProvider,
  repairProvider,
  updateProvider,
} from "../agent/provider-author";
import {
  designWorkflow,
  planWorkflow,
  providerMethodNames,
} from "../agent/workflow-designer";
import { reconcileWiring, type Wire } from "../agent/wiring-repair";
import { normalizeGraph, type NormFunc } from "../agent/normalize";
import { probeModel } from "../agent/probe";
import { validateApiKey, validateModelName } from "../agent/validate-model";
import { authorInputForm } from "../agent/form-author";
import { setLlmBudgetHooks } from "../agent/llm-budget";
import { LIMITS } from "../limits";
import { createConnections } from "./connections";
import { createChatStore } from "./chat";
import { createLogStore } from "./logs";
import { createFileService, FileLimitError } from "./files";
import { createBlobStore } from "../store/blobs";
import { createBillingStub } from "./billing-stub";
import type { BillingService } from "./billing-types";
import { createUsageStore } from "./usage";
import {
  createWebhookAuthStore,
  type WebhookAuthType,
} from "./webhook-auth";
import { checkForUpdates } from "./update-check";
import {
  connectNats,
  initSchedulerStream,
  initRunEventsStream,
  type NatsCtx,
} from "./nats";
import { createScheduler, missingRequiredParams, type Scheduler } from "./scheduler";
import { createSchedulerConsumer, fireWorkflow } from "./scheduler-consumer";
import { createScheduleStore, type ScheduleStore } from "../store/schedules";
import { createPollRunner } from "./poll-runner";
import { resolveEgressHost } from "./egress";
import { createOAuth } from "./oauth";
import { auth, getSessionUser, emailVerificationRequired } from "./auth";
import { createMembership } from "./membership";
import type { FuncDefinition, StepRecord } from "../atoms/index";
import { funcToWire } from "./func-wire";

const SYSTEM = [
  "You are a workflow builder assistant for an AI-native automation product.",
  "A workflow has a built-in 'trigger' node (carrying the user's run-time input) and typed steps (funcs) wired together. A step input gets its value EITHER from a trigger field OR from an upstream step's output. There is no implicit binding.",
  "PRIMARY — to build a workflow from the user's description, call design_workflow ONCE. Give every step: id, title, summary, effectful (true if it calls an external service), provider (for external services, e.g. 'stripe','slack'), a DETAILED intent (say exactly what values the step needs and what it returns), its outputs, and deps — the inputs that come from an UPSTREAM step's output (input name, fromStep id, fromOutput field).",
  "You do NOT list trigger inputs and you do NOT write wires. The server writes each step body from your intent, reads which inputs the body uses, takes any input not provided by a dep from the user's trigger input by that name, and wires everything deterministically. So: make each intent precise (especially the values an external call needs, e.g. a Slack message needs a channel and the text), and declare inter-step deps with consistent field names. For external services just name the provider; the server creates it if missing.",
  "EDITS — when a workflow already exists (its live state is given below the system prompt), do NOT call design_workflow. Make the smallest change with the edit tools: author_func + wire to ADD a step; update_func to CHANGE a step in place (same id, new body); delete_func to REMOVE a step (and its wires); wire/unwire to reconnect or disconnect an input. Target every step by its exact [id] from the current state, and reuse the exact field names shown. After changing a step, re-wire any inputs/outputs that changed. search_providers/create_provider support the add path.",
  "When the user reports a failed step, FIRST diagnose whether it is a provider bug or a workflow/flow problem — do not jump to repairing the provider:",
  "- Look at the step's resolved input. If it is empty ({}) or missing the field the error is about (e.g. the error says 'amount required' and the resolved input has no amount), then the step is NOT receiving its data. That is a FLOW problem — a missing input declaration on the func, or a missing wire / missing trigger value — NOT the provider. In that case do NOT call repair_provider. Tell the user clearly that the problem is in the flow, point at the missing input, and suggest the fix (declare the input on the step, or wire it / add it to the trigger input).",
  "- Only if the resolved input clearly contains the data but the provider still rejects it, call repair_provider (with provider id, error, call site, sample input) and say what you fixed.",
  "CONNECTIONS (credentials/secrets) are separate from providers: a provider is the code that calls a service, a connection is the user's stored credential for it. To answer whether the user has a credential for a service (e.g. 'do I have Slack connected?'), call list_connections — it returns metadata only, never the secret value. When the user wants to connect a service, or a workflow needs a provider that has no connection yet, call request_connection with the provider id to open the secure setup dialog where the user enters the secret themselves. NEVER ask the user to type or paste an API key, token, password, or any secret into the chat — you must not handle secret values; always route them through request_connection.",
  "EDITING A CONNECTION — this product has NO OAuth flow; every provider uses a non-OAuth credential (an API key/token, a service-account JSON key, or a client id+secret for a server-to-server token exchange). If the user wants to CHANGE how a connection is set up — a different credential method (e.g. 'Google Sheets should ask for a Service Account JSON key, or client id+secret'), a missing/wrong setup guide, or a credential field with no explanation — call update_provider with the provider id and a one-line instruction. It re-authors the provider's credential fields + setup guide + client code together, and the updated dialog shows next time the connection is opened. Do NOT tell the user a connection can't be changed; fix it with update_provider.",
  "The user may have uploaded FILES to this space (CSV/JSON/text/etc.). Use list_files to see them and read_file to inspect content before building a workflow that processes a file. A workflow step can receive a file's content via a 'file' input the user picks.",
  "Keep replies short. After building, briefly summarize the steps and how they connect.",
].join("\n");

function leanFunc(f: {
  id: string;
  title: string;
  summary: string;
  pure: boolean;
  inputs: { name: string }[];
  outputSchema: unknown;
  requires: { provider: string }[];
}) {
  const s = f.outputSchema as
    | { properties?: Record<string, unknown>; required?: string[] }
    | undefined;
  return {
    id: f.id,
    title: f.title,
    summary: f.summary,
    pure: f.pure,
    inputs: f.inputs.map((p) => p.name),
    outputs: s?.properties ? Object.keys(s.properties) : (s?.required ?? []),
    requires: f.requires.map((r) => r.provider),
  };
}

const MAX_USER_MESSAGE_CHARS = 16000;
const MAX_TOOL_RESULT_CHARS = 8000;

function truncate(s: string, max: number): string {
  return s.length <= max
    ? s
    : s.slice(0, max) +
        `\n\n[truncated: ${s.length - max} more characters omitted]`;
}

function clampUserMessage(message: UIMessage): UIMessage {
  if (!Array.isArray(message.parts)) return message;
  let budget = MAX_USER_MESSAGE_CHARS;
  let truncated = false;
  const parts = message.parts.map((p) => {
    if (p.type !== "text" || typeof p.text !== "string") return p;
    if (p.text.length <= budget) {
      budget -= p.text.length;
      return p;
    }
    truncated = true;
    const text = budget > 0 ? p.text.slice(0, budget) : "";
    budget = 0;
    return { ...p, text };
  });
  if (truncated) {
    parts.push({
      type: "text",
      text: "\n\n[Note: your message was truncated because it exceeded the length limit.]",
    } as (typeof parts)[number]);
  }
  return { ...message, parts };
}

function clampModelOutput(out: { type: string; value: unknown }): {
  type: string;
  value: unknown;
} {
  if (out.type === "text" && typeof out.value === "string") {
    return { type: "text", value: truncate(out.value, MAX_TOOL_RESULT_CHARS) };
  }
  if (out.type === "json") {
    const s = JSON.stringify(out.value ?? null);
    if (s.length > MAX_TOOL_RESULT_CHARS) {
      return { type: "text", value: truncate(s, MAX_TOOL_RESULT_CHARS) };
    }
  }
  return out;
}

function withResultLimits(tools: ToolSet): ToolSet {
  for (const t of Object.values(tools)) {
    const prev = t.toModelOutput?.bind(t);
    t.toModelOutput = (async (opts: { output: unknown }) => {
      const base = prev
        ? ((await prev(opts as never)) as { type: string; value: unknown })
        : typeof opts.output === "string"
          ? { type: "text", value: opts.output }
          : { type: "json", value: opts.output ?? null };
      return clampModelOutput(base);
    }) as NonNullable<(typeof t)["toModelOutput"]>;
  }
  return tools;
}

const MANAGED =
  process.env.MANAGED === "1" || process.env.MANAGED === "true";
// PII masking default for persisted run step IO. Deployment-aware, env-
// overridable: managed = "shape" (multi-tenant privacy), self-host = "full"
// (operator's own data, best diagnosis). Same env-?:-MANAGED pattern as MCP.
const MASK_DEFAULT: MaskLevel = (["shape", "keys", "full"] as const).includes(
  process.env.PII_MASK_DEFAULT as MaskLevel,
)
  ? (process.env.PII_MASK_DEFAULT as MaskLevel)
  : MANAGED
    ? "shape"
    : "full";
// MCP support is a SELF-HOST-only feature: never on a managed/prod instance, and
// even self-host must opt in with ENABLE_MCP. Gates the /api/mcp/* endpoints.
const MCP_ENABLED = !MANAGED && /^(1|true)$/i.test(process.env.ENABLE_MCP ?? "");
// Hard-lock the model picker for the whole deployment. Parsed as a real boolean so
// DISABLE_LLM_SETTINGS=0 / false / "" all mean OFF — a non-empty string like "0"
// would otherwise be truthy and stay locked.
const LLM_SETTINGS_DISABLED = /^(1|true|yes)$/i.test(
  process.env.DISABLE_LLM_SETTINGS ?? "",
);
// Remote MCP endpoint (/mcp) to drive workflows from Claude / ChatGPT / Gemini.
// Self-host: ON by default (zero-config — no .env needed). Managed/prod: OFF by
// default and plan-gated (Pro/Test/Ent). Either way an explicit ENABLE_REMOTE_MCP
// env value wins, so self-host can turn it OFF with ENABLE_REMOTE_MCP=0.
const REMOTE_MCP_ENABLED = (() => {
  const env = process.env.ENABLE_REMOTE_MCP;
  if (env != null && env.trim() !== "") return /^(1|true|yes)$/i.test(env);
  return !MANAGED;
})();
// OAuth issuer (= this server's public origin). Prefer APP_URL; else derive from
// the request so self-host behind any host still serves correct metadata.
const issuerFrom = (reqUrl: string): string =>
  process.env.APP_URL?.replace(/\/+$/, "") || new URL(reqUrl).origin;

const { store, vault } = createStorage();
initUsageCap(store);
const registry = createRegistry(store);
const oauth = createOAuth({ store, vault, registry });
const connections = createConnections({ store, vault, oauth });
const workflows = createWorkflowStore(store);
// Captures the (secret-free) provider drafts a workflow's funcs require, so a
// sealed version restores its own provider code — not whatever the registry was
// last re-authored to. Shared by the version store (pinning) and the fix engine
// (diffing a provider repair).
const pinProviders = async (spaceId: string, funcs: unknown[]): Promise<Record<string, unknown>> => {
  const ids = new Set<string>();
  for (const f of funcs as Array<{ requires?: Array<{ provider?: string }> }>)
    for (const r of f?.requires ?? []) if (r?.provider) ids.add(r.provider);
  const out: Record<string, unknown> = {};
  for (const id of ids) {
    const draft = await registry.getProviderDraft(spaceId, id);
    if (draft) out[id] = draft; // builtins (e.g. "http") return null → excluded
  }
  return out;
};
const versions = createVersionStore(store, { pinProviders });
const mcpTokens = createMcpTokenStore(store);
const mcpOauth = createMcpOAuth(store);
const runs = createRunStore(store);
// Same cipher as secret-at-rest (Vault Transit on managed, null on self-host).
// Used to seal/unseal the raw resume-seed capsule so masked managed runs still
// resume from step with real values (null → self-host stores raw already).
const seedCipher = createCipher();
// No-data-loss trigger buffer (events held while a flow is paused). Shares the
// cipher so buffered event payloads are encrypted at rest on managed.
const buffer = createBufferStore(store, seedCipher);
// Wiring for the no-data-loss buffer drain — it orchestrates the existing
// idempotency + resume primitives, writing no new dedup/resume logic.
// runSavedWorkflow is hoisted.
const replayDeps: ReplayDeps = {
  buffer,
  getWorkflow: (s, w) => workflows.getWorkflow(s, w),
  runSavedWorkflow: (s, wf, input, trigger, runId, resumeFrom) =>
    runSavedWorkflow(s, wf, input, trigger, runId, resumeFrom),
  setPaused: (s, w, p) => workflows.setPaused(s, w, p),
};
// Governance + per-flow policy. Declared before canHeal so the gate can
// read the global kill-switch.
const flowSettings = createFlowSettingsStore(store);
const governance = createGovernance(store);
const audit = createAuditStore(store);
// Run-safety: idempotency dedup for effectful steps + per-space concurrent
// run ceiling. Both no-op on self-host (no declared mechanisms / uncapped).
const idempotency = createIdempotencyStore(store);
const concurrency = createConcurrencyGuard({
  store,
  countActive: async (spaceId) =>
    (await runs.listRuns(spaceId)).filter((r) => r.status === "running").length,
});
// Per-flow health. onChange fires on status transitions: we log it and hand it
// to the alert pipeline (late-bound below, after its deps exist).
let onHealthTransition: (
  spaceId: string,
  state: HealthState,
  prev: HealthStatus | undefined,
) => void = () => {};
const health = createHealthMonitor({
  runs,
  onChange: (spaceId, state, prev) => {
    console.log(
      `[health] ${spaceId}/${state.workflowId}: ${prev ?? "—"} → ${state.status}`,
    );
    onHealthTransition(spaceId, state, prev);
  },
});
const settings = createSettingsStore(store);

// load the saved LLM config (in-app settings) into the model factory at boot;
// it overrides env. Self-host can configure the model from the UI, no .env.
void settings
  .getLlm()
  .then((cfg) => {
    if (cfg) setLlmConfig(cfg);
    const active = getLlmConfig();
    console.log(
      `[llm] provider=${active.provider} model=${active.model ?? "(default)"}`,
    );
  })
  .catch((e) => console.error("llm settings load failed", e));
const membership = createMembership(store);
const chats = createChatStore(store);
const userLogs = createLogStore(store);
// Alerting: deliver health transitions to the activity log (always) + any
// configured external channels (Telegram/Slack/Discord/email), engine-bypass.
const alertChannels = createAlertChannelStore(store, vault);
const alertHandlers = createAlertHandlerStore(store);
const alerts = createAlertService({
  channels: alertChannels,
  logs: userLogs,
  workflowName: async (spaceId, workflowId) =>
    (await workflows.getWorkflow(spaceId, workflowId))?.name,
  // a flow is a handler if it's an enabled entry in the registry (loop guard)
  isHandler: (spaceId, workflowId) => alertHandlers.isEnabled(spaceId, workflowId),
  // external alerts are opt-in per flow (default OFF) — no notification spam
  alertsEnabled: async (spaceId, workflowId) =>
    (await workflows.getWorkflow(spaceId, workflowId))?.alertsEnabled === true,
  // the user's chosen handler flows (enabled entries fire on every alert)
  listHandlers: async (spaceId) =>
    (await alertHandlers.list(spaceId)).filter((h) => h.enabled).map((h) => ({ workflowId: h.workflowId })),
  // run a registered handler flow with the alert payload as its input
  dispatchWorkflow: async (spaceId, workflowId, payload) => {
    const wf = await workflows.getWorkflow(spaceId, workflowId);
    if (!wf) return;
    await runSavedWorkflow(spaceId, wf, payload as unknown as Record<string, unknown>, "monitor");
  },
});
onHealthTransition = (spaceId, state, prev) =>
  void alerts.onHealthChange(spaceId, state, prev).catch(() => {});
const fileService = createFileService(store, createBlobStore());
const usage = createUsageStore(store);
const billing: BillingService =
  MANAGED && process.env.STRIPE_SECRET_KEY
    ? await (
        await import("./billing-stripe")
      ).createStripeBilling(store, {
        onRenewal: (spaceId) => usage.reset(spaceId),
      })
    : createBillingStub();
const webhookAuth = createWebhookAuthStore(store, vault);

// Make EVERY internal authoring LLM call (genObject) budget-aware: count its
// tokens toward the space's real usage, and refuse before spending once the
// space is over its token limit or the deployment global cap is hit. This is
// what stops a single design_workflow (planWorkflow + N step bodies + provider
// + wiring + form) — or the standalone repair/probe endpoints — from running up
// an unbounded Gemini bill outside the chat loop's caps.
// Lazily load a space's own LLM config (managed/prod: a Pro space can set its own
// model + key) into the model factory, once per process. In self-host the single
// global override already covers every space, so this is a managed-only concern.
const llmLoaded = new Set<string>();
async function ensureSpaceLlm(spaceId: string): Promise<void> {
  if (!MANAGED || llmLoaded.has(spaceId)) return;
  llmLoaded.add(spaceId);
  try {
    const cfg = await settings.getLlm(spaceId);
    if (cfg) setSpaceLlmConfig(spaceId, cfg);
  } catch (e) {
    console.error("space llm load failed", spaceId, e);
  }
}

// Plans allowed to bring their own model/key in managed/prod: Pro, the internal
// Test plan, and Enterprise (everyone except Free). Self-host has no plan gate.
// DISABLE_LLM_SETTINGS hard-locks everyone.
const OWN_MODEL_PLANS = new Set(["pro", "test", "enterprise"]);
async function canUseOwnModel(spaceId: string): Promise<boolean> {
  if (LLM_SETTINGS_DISABLED) return false;
  if (!MANAGED) return true; // self-host
  if (!billing.enabled()) return false;
  const plan = await billing.planOf(spaceId);
  return OWN_MODEL_PLANS.has(plan.slug);
}

// Remote MCP: opt-in per deployment, and in managed/prod only Pro/Test/Enterprise
// spaces (Free is excluded). Self-host has no plan gate.
async function canUseRemoteMcp(spaceId: string): Promise<boolean> {
  if (!REMOTE_MCP_ENABLED) return false;
  if (!MANAGED) return true; // self-host (opt-in already true here)
  if (!billing.enabled()) return false;
  const plan = await billing.planOf(spaceId);
  return OWN_MODEL_PLANS.has(plan.slug);
}

// May this space PRODUCE an AI fix proposal? Diagnosis is NEVER gated; only the
// LLM-fix proposal is. HEAL_DISABLED is a hard kill (kill-switch). Self-host →
// always on; managed → paid plans only (Free gets notify-only diagnosis).
const HEAL_DISABLED = /^(1|true|yes)$/i.test(process.env.HEAL_DISABLED ?? "");
async function canHeal(spaceId: string): Promise<boolean> {
  if (HEAL_DISABLED) return false;
  if (await governance.killSwitch()) return false; // deployment-wide emergency stop
  if (!MANAGED) return true; // self-host: open, uncapped
  if (!billing.enabled()) return false;
  const plan = await billing.planOf(spaceId);
  return OWN_MODEL_PLANS.has(plan.slug);
}
const fixEngine = createFixEngine({
  registry,
  getWorkflow: (spaceId, id) => workflows.getWorkflow(spaceId, id),
  saveWorkflow: (spaceId, wf) => workflows.saveWorkflow(spaceId, wf),
  seal: (spaceId, head, meta) => versions.seal(spaceId, head, meta),
  setCurrentVersion: (spaceId, id, versionId) => workflows.setCurrentVersion(spaceId, id, versionId),
  pinProviders,
  canProposeFix: canHeal,
});

// Self-healing orchestration. Per-flow heal is OPT-IN, default OFF — until the
// per-flow settings store lands, the default mode/enable is env-driven
// (self-host operator can flip HEAL_DEFAULT_ENABLED=1 + HEAL_DEFAULT_MODE=auto).
const HEAL_DEFAULT_ENABLED = /^(1|true|yes)$/i.test(process.env.HEAL_DEFAULT_ENABLED ?? "");
const HEAL_DEFAULT_MODE: FixMode = (["notify", "propose", "auto"] as const).includes(
  process.env.HEAL_DEFAULT_MODE as FixMode,
)
  ? (process.env.HEAL_DEFAULT_MODE as FixMode)
  : "propose";
const HEAL_WINDOW_MS = Number(process.env.HEAL_WINDOW_MS) || 3_600_000; // loop-counter window (engineering constant)
const healEvents = createHealEventStore(store);
const healOrchestrator = createHealOrchestrator({
  fixEngine,
  buildContext: (spaceId, runId) =>
    buildDiagnosisContext({ getRun: runs.getRun, listRuns: runs.listRuns, getWorkflow: workflows.getWorkflow }, spaceId, runId),
  events: healEvents,
  getFlowMode: async (spaceId, workflowId) => {
    // untouched flows fall back to the deployment env defaults
    const s = await flowSettings.get(spaceId, workflowId, {
      enabled: HEAL_DEFAULT_ENABLED,
      fixMode: HEAL_DEFAULT_MODE,
      autoReplay: false,
    });
    return { enabled: s.enabled, fixMode: s.fixMode };
  },
  canHeal,
  caps: () => ({ blastMax: LIMITS.healBlastRadiusMax, attemptMax: LIMITS.healAttemptMax, windowMs: HEAL_WINDOW_MS }),
  log: (spaceId, e) => void userLogs.append(spaceId, { ...e, source: "healing" }).catch(() => {}),
});
const healDispatcher = createHealDispatcher({
  orchestrate: async (t) => {
    const ev = await healOrchestrator.orchestrate(t);
    if (ev?.status === "applied") {
      void audit.record(t.spaceId, { kind: "heal.applied", message: ev.diagnosis || "auto-heal applied", workflowId: t.workflowId, actor: "system" });
      // auto-replay: opt-in per flow + still gated by canHeal (a kill-switch
      // stops the automatic continuation; the manual Replay button is unaffected).
      const s = await flowSettings.get(t.spaceId, t.workflowId);
      if (s.autoReplay && (await canHeal(t.spaceId))) {
        await replayBuffer(replayDeps, t.spaceId, t.workflowId).catch((e) => console.error("[heal] auto-replay failed", e));
      }
    }
    return ev;
  },
  onError: (e) => console.error("[heal] orchestrate failed", e),
});

// MCP write-capability (pause/resume/buffer-replay + apply_fix). Self-host on;
// managed opt-in. Read + diagnose stay on whenever remote MCP is enabled.
const MCP_WRITE_ENABLED = !MANAGED || /^(1|true|yes)$/i.test(process.env.MCP_WRITE_ENABLED ?? "");

const remoteMcpDeps: RemoteMcpDeps = {
  workflows,
  registry,
  registerProvider: async (spaceId, draft) => {
    const d = draft as unknown as import("../providers/registry").ProviderDraft;
    const spec = registry.registerProviderFromDraft(spaceId, d);
    await registry.persistProvider(spaceId, d);
    return { id: spec.id, name: spec.name };
  },
  runSaved: async (spaceId, wf, input) => {
    const run = await runSavedWorkflow(spaceId, wf, input, "mcp");
    return { records: run.records };
  },
  reconcileSchedule: async (spaceId, id) => {
    const wf = await workflows.getWorkflow(spaceId, id);
    if (wf) await scheduler.reconcile(spaceId, wf);
  },
  // ── Monitoring / diagnosis (read-only; on whenever remote MCP is enabled) ──
  monitoring: {
    listRuns: (s, wf, limit) => runs.listRuns(s, wf, limit),
    getRun: (s, id) => runs.getRun(s, id),
    getHealth: async (s, wf) => (wf ? await health.recompute(s, wf) : await health.summary(s)),
    getAnalytics: async (s, wf) => computeAnalytics(await runs.listRuns(s, wf), Date.now()),
    listVersions: (s, wf) => versions.list(s, wf),
    listHealEvents: (s, wf, limit) => healEvents.listForWorkflow(s, wf, limit),
    diagnose: async (s, runId, language) => {
      const ctx = await buildDiagnosisContext(
        { getRun: runs.getRun, listRuns: runs.listRuns, getWorkflow: workflows.getWorkflow },
        s,
        runId,
      );
      if (!ctx) return null;
      return fixEngine.diagnose(s, ctx, { language: language ?? "English" });
    },
  },
  // ── Fix (write-capability): propose (stage) + approve (apply via the in-app
  // approve path; human-gated, never raw). Wired only when write-enabled. ──
  heal: MCP_WRITE_ENABLED
    ? {
        proposeFix: async (s, runId) => {
          const ctx = await buildDiagnosisContext(
            { getRun: runs.getRun, listRuns: runs.listRuns, getWorkflow: workflows.getWorkflow },
            s,
            runId,
          );
          if (!ctx) return { fixable: false, error: "run not found or not a failure" };
          const d = await fixEngine.diagnose(s, ctx, { language: "English" });
          if (!d.proposedFix) return { fixable: false, plainLanguage: d.plainLanguage, errorType: d.errorType };
          const ev = await healEvents.record(s, {
            spaceId: s,
            workflowId: d.workflowId,
            runId,
            mode: "propose",
            errorType: d.errorType,
            confidence: d.confidence,
            diagnosis: d.plainLanguage,
            proposal: d.proposedFix,
            status: "proposed",
          });
          return {
            fixable: true,
            eventId: ev.id,
            workflowId: d.workflowId,
            kind: d.proposedFix.kind,
            plainLanguage: d.plainLanguage,
            confidence: d.confidence,
            blastRadius: d.blastRadius,
            needsConfirm: true,
          };
        },
        approveFix: async (s, workflowId, eventId) => {
          const ev = await healEvents.get(s, eventId);
          if (!ev || ev.workflowId !== workflowId) return { ok: false, error: "fix event not found" };
          if (ev.status !== "proposed") return { ok: false, error: `fix is '${ev.status}', not awaiting approval` };
          if (!ev.proposal) return { ok: false, error: "fix event has no proposal to apply" };
          const { versionId } = await fixEngine.applyFix(s, workflowId, ev.proposal, { runId: ev.runId, mode: "propose" });
          await healEvents.update(s, ev.id, { status: "applied", versionId, approvedBy: "mcp" });
          return { ok: true, versionId };
        },
      }
    : undefined,
  // ── Operational actions (write-capability): pause/resume/buffer ──
  ops: MCP_WRITE_ENABLED
    ? {
        pause: async (s, wf) => {
          await workflows.setPaused(s, wf, true, "manual");
          if (scheduler) await scheduler.pause(s, wf);
        },
        resume: async (s, wf) => {
          await workflows.setPaused(s, wf, false);
          if (scheduler) await scheduler.resume(s, wf);
        },
        listBuffer: async (s, wf) =>
          (await buffer.list(s, wf)).map((e) => ({
            id: e.id,
            seq: e.seq,
            status: e.status,
            receivedAt: e.receivedAt,
            preview: maskValue(e.payload, MASK_DEFAULT),
          })),
        testBuffer: (s, wf) => testRunFirst(replayDeps, s, wf, new Date().toISOString()),
        replayBuffer: (s, wf) => replayBuffer(replayDeps, s, wf),
      }
    : undefined,
};

setLlmBudgetHooks({
  // a space on its OWN key pays for its own tokens — don't count them as ours
  record: (spaceId, tokens) => {
    if (spaceUsesOwnKey(spaceId)) return;
    void usage.addTokens(spaceId, tokens);
  },
  guard: async (spaceId) => {
    if (spaceUsesOwnKey(spaceId)) return; // own key → no caps
    if (await usageCapExceeded())
      throw new Error("The AI usage limit for this deployment has been reached.");
    if (!billing.enabled()) return; // self-host: no per-space plan enforcement
    const plan = await billing.planOf(spaceId); // returns the resolved plan
    if (plan.limits.aiTokens < 0) return; // unlimited tier
    const u = await usage.get(spaceId);
    if (u.aiTokens >= plan.limits.aiTokens)
      throw new Error(
        "You've used all your AI tokens for this month. They reset next cycle, or upgrade for a higher limit.",
      );
  },
});

const rateLimiter = createMemoryRateLimiter();
const min = (limit: number): RateLimitRule => ({ limit, windowMs: 60_000 });
// All limit VALUES live in src/limits.ts (single source of truth, env-tunable,
// auto-bypassed for self-host). These just wrap them as rate-limit rules.
const CHAT_USER_LIMIT = min(LIMITS.chatPerUserPerMin);
// Shared "chat:global" bucket: one cross-user cap for the whole deployment.
const CHAT_GLOBAL_LIMIT = min(LIMITS.chatGlobalPerMin);
const HOOK_LIMIT = min(LIMITS.hookPerMin);
// Direct LLM-triggering endpoints (repair-wiring, input-form, provider repair,
// model probe) bypass the chat handler, so they get their own per-user bucket
// PLUS the shared chat:global bucket — covering EVERY LLM entry point.
const LLM_DIRECT_USER_LIMIT = min(LIMITS.llmDirectPerUserPerMin);

async function llmRateLimit(c: Context): Promise<Response | null> {
  // own-key spaces aren't rate limited (they pay for their own tokens)
  await ensureSpaceLlm(c.get("spaceId"));
  if (spaceUsesOwnKey(c.get("spaceId"))) return null;
  const u = await rateLimiter.take(
    `llm:user:${c.get("userId")}`,
    LLM_DIRECT_USER_LIMIT,
  );
  const g = u.ok ? await rateLimiter.take("chat:global", CHAT_GLOBAL_LIMIT) : u;
  if (!g.ok)
    return c.json(
      {
        error: "rate_limited",
        message: "Too many AI requests. Please wait a moment and try again.",
        retryAfterMs: g.retryAfterMs,
      },
      429,
      { "Retry-After": String(Math.ceil(g.retryAfterMs / 1000)) },
    );
  return null;
}

// Outcome health: did a green (done) run actually do its job? Evaluates the
// flow's opt-in outcome config against this run's RAW step outputs (no PII
// leaves — the result is just kind/nodeId/detail). For drift-to-empty it reads
// a bounded window of prior done runs' (masked) outputs; array/object emptiness
// survives masking, so the "zero rows" case is caught.
const OUTCOME_DRIFT_WINDOW = 5;
async function evaluateRunOutcome(
  spaceId: string,
  wf: { id: string; funcs: unknown[]; outcome?: OutcomeConfig },
  records: StepRecord[],
  currentRunId: string,
): Promise<OutcomeFail | null> {
  const cfg = wf.outcome;
  if (!cfg) return null;
  const pureById = new Map(
    (wf.funcs as Array<{ id: string; pure?: boolean }>).map((f) => [f.id, !!f.pure]),
  );
  const outputs = records
    .filter((r) => r.nodeId !== "trigger" && r.status === "done")
    .map((r) => ({
      nodeId: r.nodeId,
      output: r.output,
      effectful: !pureById.get(r.nodeId),
    }));

  let driftBaseline: Record<string, number> | undefined;
  let driftHistory = 0;
  if (cfg.driftToEmpty) {
    const prior = (await runs.listRuns(spaceId, wf.id))
      .filter((m) => m.status === "done" && m.id !== currentRunId)
      .slice(0, OUTCOME_DRIFT_WINDOW);
    driftHistory = prior.length;
    driftBaseline = {};
    for (const m of prior) {
      const run = await runs.getRun(spaceId, m.id);
      for (const rec of run?.records ?? []) {
        if (rec.nodeId === "trigger") continue;
        if (!maskedIsEmpty(rec.output)) // masked history: «string:0» counts as empty
          driftBaseline[rec.nodeId] = (driftBaseline[rec.nodeId] ?? 0) + 1;
      }
    }
  }
  return evaluateOutcome({ outputs, config: cfg, driftBaseline, driftHistory });
}

// Shared resume seed: a prior run's `done` steps + its input. Both the manual
// /api/run path and runSavedWorkflow (all triggers + auto-heal) use this, so
// the "what counts as already-done" rule lives in exactly one place.
async function loadResumeSeed(
  spaceId: string,
  priorRunId: string,
): Promise<{ seed: StepRecord[]; input: Record<string, unknown> } | null> {
  // Prefer the encrypted raw capsule (sealed on failed+masked runs): getRun's
  // step IO is PII-masked at persist, so under managed masking it can't seed a
  // correct resume. Self-host (no cipher / mask "full") falls through to getRun,
  // whose records are already raw.
  if (seedCipher) {
    const sealed = await runs.readResumeSeed(spaceId, priorRunId);
    if (sealed) {
      try {
        const raw = JSON.parse(await seedCipher.decrypt(sealed)) as {
          input: Record<string, unknown>;
          seed: StepRecord[];
        };
        return { seed: raw.seed.filter((r) => r.status === "done"), input: raw.input };
      } catch (e) {
        console.error(`resume seed unseal failed [${priorRunId}] — falling back to masked`, e);
      }
    }
  }
  const prior = await runs.getRun(spaceId, priorRunId);
  if (!prior) return null;
  return {
    seed: prior.records.filter((r) => r.status === "done"),
    input: prior.input,
  };
}

async function runSavedWorkflow(
  spaceId: string,
  wf: {
    id: string;
    name: string;
    funcs: unknown[];
    wires: unknown[];
    config?: Record<string, Record<string, string>>;
    nodeConnections?: Record<string, Record<string, string>>;
    variables?: Record<string, unknown>;
    outcome?: OutcomeConfig;
    maskLevel?: MaskLevel;
  },
  input: Record<string, unknown>,
  trigger: string,
  runId?: string,
  // Resume from a prior run: its `done` steps seed this run (re-run continues
  // from where it failed). Available to ALL triggers + auto-heal/replay, not
  // just manual /api/run. NOTE: the seed comes from getRun, whose step IO is
  // PII-masked at persist time — so seeded values are raw only when this
  // deployment stores raw (self-host / mask "full"). Under managed masking the
  // seed carries masked values (the same long-standing limit /api/run has);
  // restoring raw-value resume is a separate, deliberate change.
  resumeFrom?: { runId: string },
): Promise<RunDoc> {
  // Unified recorder for saved-workflow triggers (webhook/schedule/poll).
  // Seals the running version → writes a "running" header → persists each step
  // append-only (PII-masked) → finalizes → emits + prunes. Returns the RunDoc
  // with RAW (unmasked) records for the immediate caller.
  const id = runId ?? randomUUID();
  const startedAt = new Date().toISOString();
  const maskLevel = resolveMaskLevel(wf.maskLevel, MASK_DEFAULT); // per-flow override
  let merged = { ...(wf.variables ?? {}), ...input };

  // Run-safety: refuse the run when the space is already at its concurrent-run
  // ceiling (a schedule/poll storm must not drown a space). Recorded as a failed
  // run so it's visible; "out of range" ⇒ errorType `logic` ⇒ not auto-retried.
  // No-op on self-host (uncapped). A future buffering layer can hold these
  // instead of failing.
  if (!(await concurrency.tryAcquire(spaceId))) {
    const at = new Date().toISOString();
    const failMessage = "space concurrency cap reached: active run count out of range";
    const errorType = classifyError(failMessage);
    await runs.saveRun(spaceId, {
      id,
      workflowId: wf.id,
      workflowName: wf.name,
      trigger,
      status: "failed",
      errorType,
      input: maskValue(merged, maskLevel) as Record<string, unknown>,
      records: [],
      startedAt: at,
      finishedAt: at,
      failReason: failMessage,
      maskLevel,
    });
    void userLogs.append(spaceId, {
      level: "error",
      source: "run",
      message: `Run rejected: ${wf.name} (${trigger})`,
      detail: failMessage,
      workflowId: wf.id,
    });
    emitRun(spaceId, { id, workflowId: wf.id, status: "failed", trigger, errorType });
    return {
      id,
      workflowId: wf.id,
      workflowName: wf.name,
      trigger,
      status: "failed",
      errorType,
      input: merged,
      records: [],
      startedAt: at,
      finishedAt: at,
      maskLevel,
    };
  }

  // Resume seeding: replay this run's prior `done` steps so it continues from
  // the failed step (input carries over). Idempotency keeps any already-fired
  // effect from re-firing past the seed (when funcs declare a mechanism).
  let seed: StepRecord[] | undefined;
  if (resumeFrom) {
    const loaded = await loadResumeSeed(spaceId, resumeFrom.runId);
    if (loaded) {
      seed = loaded.seed;
      merged = loaded.input;
    }
  }

  let workflowVersionId: string | undefined;
  const head = await workflows.getWorkflow(spaceId, wf.id);
  if (head) {
    const { version } = await versions.seal(spaceId, head, {
      source: "run-snapshot",
    });
    workflowVersionId = version.id;
  }

  const headerDoc: RunHeader = {
    id,
    workflowId: wf.id,
    workflowName: wf.name,
    trigger,
    status: "running",
    input: maskValue(merged, maskLevel) as Record<string, unknown>,
    startedAt,
    ...(workflowVersionId ? { workflowVersionId } : {}),
    maskLevel,
  };
  await runs.startRun(spaceId, headerDoc);

  const records: StepRecord[] = [];
  let seq = 0;
  let engineError: string | undefined;
  try {
    await runWorkflow(
      { spaceId, registry, connections, files: fileService, idempotency },
      wf.funcs as Parameters<typeof runWorkflow>[1],
      wf.wires as Parameters<typeof runWorkflow>[2],
      merged,
      wf.config ?? {},
      wf.nodeConnections ?? {},
      async (record) => {
        records.push(record);
        await runs.appendStep(spaceId, {
          ...record,
          runId: id, // runWorkflow uses an internal "run" id — use the real one
          resolvedInput: maskValue(record.resolvedInput, maskLevel),
          output:
            record.output === undefined
              ? undefined
              : maskValue(record.output, maskLevel),
          error: maskErrorString(record.error, maskLevel),
          spaceId,
          workflowId: wf.id,
          seq: seq++,
          at: new Date().toISOString(),
        });
      },
      seed, // generalized resume: prior done-steps (undefined for a fresh run)
      id, // runKey: the real run id so idempotency dedup keys are run-stable
    );
  } catch (e) {
    // Systemic engine error (not a per-step failure) — always finalize the run
    // so the header never stays stuck "running".
    engineError = e instanceof Error ? e.message : String(e);
    console.error(`run engine error [${wf.id}]`, e);
  }

  const status =
    engineError || records.some((r) => r.status === "failed")
      ? "failed"
      : "done";
  const finishedAt = new Date().toISOString();
  // Classify the failure (if any) BEFORE finalize so the run header stores its
  // errorType — the monitoring breakdown reads it from listRuns.
  let errorType: ErrorType | undefined;
  let failMessage: string | undefined;
  if (status === "failed") {
    const errs = records
      .filter((r) => r.status === "failed")
      .map((r) => `${r.nodeId}: ${r.error ?? "failed"}`)
      .join("; ");
    failMessage = errs || engineError || "unknown error";
    errorType = classifyError(failMessage); // transient|auth|logic|unknown
  }
  // Store failReason + errorType so a run that died at setup still shows WHY.
  await runs.finalizeRun(spaceId, id, status, finishedAt, engineError, errorType);

  if (status === "failed") {
    // Seal the RAW done-step IO + input so a later resume-from-step (manual or
    // buffer replay) restores real values even though persisted records are masked.
    // Only when masking is lossy AND a cipher exists; best-effort (a seal failure
    // must never fail the run — resume degrades to masked seed). Self-host
    // ("full" / no cipher) needs no capsule: its records are already raw.
    if (seedCipher && maskLevel !== "full") {
      try {
        const seed = records.filter((r) => r.status === "done");
        const sealed = await seedCipher.encrypt(JSON.stringify({ input: merged, seed }));
        await runs.sealResumeSeed(spaceId, id, sealed);
      } catch (e) {
        console.error(`resume seed seal failed [${wf.id}/${id}]`, e);
      }
    }
    void userLogs.append(spaceId, {
      level: "error",
      source: "run",
      message: `Run failed: ${wf.name} (${trigger})`,
      detail: failMessage,
      workflowId: wf.id,
    });
    void health
      .recompute(spaceId, wf.id, {
        lastError: { type: errorType ?? "unknown", message: failMessage ?? "unknown error" },
      })
      .catch(() => {});
    // Fire self-healing on a separate queue — NEVER inline (must not block or
    // crash the run engine). No-op unless heal is enabled for this flow.
    healDispatcher.enqueue({
      spaceId,
      workflowId: wf.id,
      runId: id,
      errorType: errorType ?? "unknown",
      error: failMessage ?? "unknown error",
    });
  } else {
    // done run — check it actually did its job (silent-success), then refresh.
    const outcome = wf.outcome
      ? await evaluateRunOutcome(spaceId, wf, records, id).catch(() => null)
      : null;
    void health
      .recompute(spaceId, wf.id, { outcome: outcome ?? null })
      .catch(() => {});
  }
  emitRun(spaceId, {
    id,
    workflowId: wf.id,
    status,
    trigger,
    ...(errorType ? { errorType } : {}),
  });
  void runs.pruneRuns(spaceId).catch(() => {});
  // Release the concurrency slot. A throw before here leaks the counter by one,
  // which tryAcquire's reconcile-against-running-runs self-corrects at the cap.
  await concurrency.release(spaceId);

  return {
    id,
    workflowId: wf.id,
    workflowName: wf.name,
    trigger,
    status,
    input: merged,
    records,
    startedAt,
    finishedAt,
    ...(workflowVersionId ? { workflowVersionId } : {}),
    maskLevel,
  };
}

async function recoverSchedules(
  sched: Scheduler,
  scheduleStore: ScheduleStore,
  workflowStore: WorkflowStore,
  docStore: DocStore,
): Promise<number> {
  let count = 0;
  const spaceIds = await docStore.spaces();
  for (const spaceId of spaceIds) {
    const metas = await workflowStore.listWorkflows(spaceId);
    const live = new Set(metas.map((m) => m.id));
    for (const meta of metas) {
      const wf = await workflowStore.getWorkflow(spaceId, meta.id);
      if (!wf) continue;
      try {
        await sched.reconcile(spaceId, wf, { force: true });
        if (wf.trigger?.kind === "schedule" || wf.trigger?.kind === "poll") count++;
      } catch (e) {
        console.error("recovery reconcile failed", spaceId, meta.id, e);
      }
    }
    const jobs = await scheduleStore.listBySpace(spaceId);
    for (const job of jobs) {
      if (live.has(job.workflowId)) continue;
      try {
        await sched.cancelByWorkflow(spaceId, job.workflowId);
      } catch (e) {
        console.error("recovery cancel failed", spaceId, job.workflowId, e);
      }
    }
  }
  return count;
}

const scheduleStore = createScheduleStore(store);
const pollRunner = createPollRunner({ registry, connections });

const SCHEDULER_STREAM = process.env.WF_SCHEDULER_STREAM ?? "WF_SCHEDULER";
const SCHEDULER_SUBJECT_PREFIX = "wf.scheduled";
const RUN_EVENTS_STREAM = process.env.WF_RUN_EVENTS_STREAM ?? "WF_RUN_EVENTS";
const RUN_EVENTS_SUBJECT_PREFIX = "mergn.runs";

let nats: NatsCtx | null = null;
try {
  if (process.env.NATS_URL) nats = await connectNats(process.env.NATS_URL);
} catch (e) {
  console.error("NATS connection error:", e instanceof Error ? e.message : e);
}
if (!nats) {
  console.error(
    "\n  ✖ NATS is required but not reachable" +
      (process.env.NATS_URL ? ` at ${process.env.NATS_URL}` : " (NATS_URL is not set)") +
      ".\n" +
      "    MergN needs NATS (JetStream) to run scheduled & poll workflows.\n" +
      "    • Docker:  it's bundled — `docker compose up -d` (keep the nats service running).\n" +
      "    • Native:  docker run -d --name mergn-nats -p 4222:4222 nats:2.14-alpine -js\n" +
      "               then set NATS_URL=nats://localhost:4222 and restart.\n",
  );
  process.exit(1);
}
const scheduler = createScheduler({
  nats,
  scheduleStore,
  subjectPrefix: SCHEDULER_SUBJECT_PREFIX,
});

let schedulerConsumer: { start(): Promise<void>; stop(): void } | null = null;
if (nats) {
  await initSchedulerStream(
    nats,
    SCHEDULER_STREAM,
    SCHEDULER_SUBJECT_PREFIX,
    Number(process.env.WF_SCHEDULER_REPLICAS) || 1,
  );
  // Run-event bus over JetStream — crosses the API↔scheduler-consumer process
  // boundary (a scheduled run's events now reach the UI's live stream) and works
  // multi-instance. Replaces the in-memory bus (still the fallback if unwired).
  await initRunEventsStream(
    nats,
    RUN_EVENTS_STREAM,
    RUN_EVENTS_SUBJECT_PREFIX,
    Number(process.env.WF_SCHEDULER_REPLICAS) || 1,
  );
  initRunEvents(jetStreamRunEvents(nats, RUN_EVENTS_STREAM, RUN_EVENTS_SUBJECT_PREFIX));
  console.log("run-event bus: JetStream");
  schedulerConsumer = createSchedulerConsumer({
    nats,
    streamName: SCHEDULER_STREAM,
    filterSubject: `${SCHEDULER_SUBJECT_PREFIX}.fired.>`,
    durableName: "wf-scheduler-fire",
    scheduleStore,
    pollRunner,
    workflows,
    runSavedWorkflow,
    recordFailure: async (spaceId, wf, trigger, error) => {
      const message = error instanceof Error ? error.message : String(error);
      const id = randomUUID();
      const now = new Date().toISOString();
      const errorType = classifyError(message);
      const run: RunDoc = {
        id,
        workflowId: wf.id,
        workflowName: wf.name,
        trigger,
        status: "failed",
        errorType,
        input: {},
        records: [
          {
            runId: id,
            nodeId: wf.trigger?.poll?.provider ?? "trigger",
            funcId: "trigger",
            funcVersion: 1,
            attempt: 1,
            status: "failed",
            resolvedInput: {},
            error: message,
          },
        ],
        startedAt: now,
        finishedAt: now,
      };
      await runs.saveRun(spaceId, run);
      void health
        .recompute(spaceId, wf.id, { lastError: { type: errorType, message } })
        .catch(() => {});
      emitRun(spaceId, { id, workflowId: wf.id, status: "failed", trigger, errorType });
    },
  });
  await schedulerConsumer.start();
  console.log("scheduler started");

  void recoverSchedules(scheduler, scheduleStore, workflows, store)
    .then((n) => console.log(`scheduler recovery: reconciled ${n} scheduling workflow(s)`))
    .catch((e) => console.error("scheduler recovery failed", e));

  // Liveness: periodically check that active interval schedules are still
  // firing on cadence; record a liveness fail on the flow's health if not.
  const liveness = createLivenessEvaluator({
    scheduleStore,
    health,
    store,
    workflows,
    runs,
  });
  liveness.start();
  console.log("liveness evaluator started");
}

// A fresh process can have no live runs — any "running" header is an orphan
// from a crash/restart. Mark them failed(orphaned) at startup so the UI/health
// doesn't show a run stuck "running" forever.
void (async () => {
  try {
    let n = 0;
    for (const spaceId of await store.spaces())
      n += await runs.markOrphaned(spaceId, 0);
    if (n) console.log(`run recovery: marked ${n} orphaned run(s) failed`);
  } catch (e) {
    console.error("orphan run reconcile failed", e);
  }
})();

function makeTools(
  spaceId: string,
  writer: UIMessageStreamWriter,
  sessionId: string,
  triggerCtx?: { kind?: string; eventFields?: string[] },
) {
  const meta = { spaceId, sessionId };
  // Tell the single-step author (author_func/update_func) how this workflow's
  // trigger feeds event data, so an edited step reads it the same way the
  // designer wired it — instead of inventing a flat input or asking the user
  // for a path into the event body.
  const triggerHint = ((): string | undefined => {
    const kind = triggerCtx?.kind;
    if (kind === "webhook") {
      return "This workflow's trigger is a WEBHOOK: the entire raw request body the external service POSTs arrives as `input.payload` (already-parsed JSON). To use a value from the event, READ IT FROM input.payload IN CODE. Webhook events commonly wrap the entity in an envelope, so unwrap the common shapes first (e.g. input.payload?.data?.object ?? input.payload?.data ?? input.payload?.object ?? input.payload) and read fields off that. NEVER invent a flat trigger input like input.customerName for event data, and NEVER create a user input that asks for a PATH/field-location (no `*_path`/`*_field`/`*_key` input + lodash get). The user only provides destinations/actions.";
    }
    if (kind === "poll" && triggerCtx?.eventFields?.length) {
      return `This workflow's trigger POLLS for new items; each item arrives with these EXACT fields: ${triggerCtx.eventFields.join(", ")}. Read event data from those input names directly. Do NOT invent other trigger field names.`;
    }
    if (kind === "schedule") {
      return "This workflow's trigger is a SCHEDULE: the only event field is input.timestamp. Do NOT invent other trigger field names.";
    }
    return undefined;
  })();
  return {
  design_workflow: tool({
    description:
      "Design and BUILD an entire workflow in one call from the user's goal. Pass the goal as a single clear sentence naming the services and the data involved (e.g. 'create a stripe customer from email and name, charge them, then post a receipt to a slack channel'). The server plans the steps, writes their bodies, and wires everything deterministically. Use this to build a workflow from scratch.",
    inputSchema: z.object({
      goal: z
        .string()
        .describe(
          "the automation to build, restated as one clear sentence including the services and the data involved",
        ),
    }),
    execute: async ({ goal }) => {
      const progressId = `design-${randomUUID()}`;
      const items: {
        key: string;
        label: string;
        status: "active" | "pending" | "done" | "failed";
      }[] = [{ key: "plan", label: "Planning steps", status: "active" }];
      const emit = () =>
        writer.write({ type: "data-design", id: progressId, data: { items } });
      emit();
      // Keepalive: a single step (e.g. authoring the input form) is one slow LLM
      // call with no bytes flowing; re-emit progress every 15s so the streaming
      // connection doesn't idle out at the proxy/browser ("Load failed").
      const heartbeat = setInterval(emit, 15_000);
      try {
        const plan = await planWorkflow(goal, meta);
        items[0].status = "done";
        emit();
        const result = await designWorkflow(registry, spaceId, plan, goal, (ev) => {
          const key = `${ev.kind}:${ev.id}`;
          const found = items.find((i) => i.key === key);
          if (found) found.status = ev.status;
          else items.push({ key, label: ev.label, status: ev.status });
          emit();
        }, meta);
        for (const it of items) it.status = "done";
        emit();
        return result;
      } catch (e) {
        console.error("design_workflow failed:", e);
        for (const it of items) if (it.status === "active") it.status = "failed";
        emit();
        const failed = items.find((it) => it.status === "failed");
        void userLogs.append(spaceId, {
          level: "error",
          source: "build",
          message: `Workflow build failed${failed ? ` at "${failed.label}"` : ""}`,
          detail: e instanceof Error ? e.message : String(e),
        });
        throw e;
      } finally {
        clearInterval(heartbeat);
      }
    },
    toModelOutput: ({ output }) => {
      const r = output as {
        name: string;
        funcs: Parameters<typeof leanFunc>[0][];
        wires: { from: string; fromOutput: string; to: string; toInput: string }[];
        trigger: { kind: string };
        inputForm?: { fields: { name: string }[] } | null;
      };
      return {
        type: "json",
        value: {
          name: r.name,
          steps: r.funcs.map(leanFunc),
          wires: r.wires,
          trigger: r.trigger,
          inputForm: r.inputForm
            ? { fields: r.inputForm.fields.map((f) => f.name) }
            : null,
        },
      };
    },
  }),
  search_providers: tool({
    description:
      "Search available external providers by keyword. Returns matches with their connection API. If nothing matches, use create_provider.",
    inputSchema: z.object({
      query: z.string().describe("keywords, e.g. 'slack message' or 'notion page'"),
    }),
    execute: async ({ query }) =>
      registry.searchProviders(spaceId, query).map((p) => ({
        id: p.id,
        name: p.name,
        scopes: p.scopes,
        apiDoc: p.apiDoc,
      })),
  }),
  create_provider: tool({
    description:
      "Generate a NEW external provider when search_providers returns nothing for the service you need. Then call author_func with the returned provider id.",
    inputSchema: z.object({
      service: z.string().describe("the service name, e.g. 'Notion'"),
      docsUrl: z
        .string()
        .optional()
        .describe("optional API docs URL or notes to ground the client"),
    }),
    execute: async ({ service, docsUrl }) => {
      const draft = await authorProvider(service, docsUrl, meta);
      registry.registerProviderFromDraft(spaceId, draft);
      await registry.persistProvider(spaceId, draft);
      return {
        id: draft.id,
        name: draft.name,
        apiDoc: draft.apiDoc,
        authEnv: draft.authEnv,
        egressDomain: draft.sandbox?.egressDomain,
      };
    },
  }),
  author_func: tool({
    description:
      "Author a step from an intent. For a pure transform, omit provider. For an external-service step, pass the provider id (from search_providers or create_provider).",
    inputSchema: z.object({
      intent: z
        .string()
        .describe("what the step should do, in one sentence"),
      provider: z
        .string()
        .optional()
        .describe("provider id, if this step calls an external service"),
    }),
    execute: async ({ intent, provider }) => {
      const r = await authorFunc(registry, { spaceId, intent, provider, triggerHint }, meta);
      return funcToWire(r.def, r.title, r.summary);
    },
    toModelOutput: ({ output }) => ({ type: "json", value: leanFunc(output) }),
  }),
  update_func: tool({
    description:
      "Edit an EXISTING step in place: re-author its body from a new intent while KEEPING its id, so it overwrites the step. Use this to change what a step does. Pass the step's current [id], the new intent, and (for external steps) the provider id. After editing, check whether its inputs/outputs changed and re-wire with wire/unwire if needed.",
    inputSchema: z.object({
      id: z
        .string()
        .describe("the existing step id to overwrite, e.g. 'charge_customer'"),
      intent: z
        .string()
        .describe("the new behavior for the step, in one sentence"),
      provider: z
        .string()
        .optional()
        .describe("provider id if this step calls an external service"),
    }),
    execute: async ({ id, intent, provider }) => {
      const r = await authorFunc(registry, { spaceId, intent, provider, triggerHint }, meta);
      return funcToWire({ ...r.def, id }, r.title, r.summary);
    },
    toModelOutput: ({ output }) => ({ type: "json", value: leanFunc(output) }),
  }),
  delete_func: tool({
    description:
      "Remove a step from the workflow entirely, together with every wire into or out of it. Pass the step's [id].",
    inputSchema: z.object({
      id: z.string().describe("the step id to delete"),
    }),
    execute: async ({ id }) => ({ id, deleted: true }),
  }),
  unwire: tool({
    description:
      "Disconnect a step's input by removing the wire feeding it. Pass the target step id and optionally the specific input name; omit the input name to remove ALL incoming wires of that step.",
    inputSchema: z.object({
      targetFunc: z
        .string()
        .describe("the step id whose incoming wire should be removed"),
      inputName: z
        .string()
        .optional()
        .describe(
          "the specific input to disconnect; omit to remove all incoming wires",
        ),
    }),
    execute: async ({ targetFunc, inputName }) => ({
      to: targetFunc,
      toInput: inputName,
    }),
  }),
  repair_provider: tool({
    description:
      "Repair an existing provider when a step failed because of a provider bug. Pass the provider id, the error, and (when available) the call site (how the step calls the provider) and the sample input values.",
    inputSchema: z.object({
      providerId: z.string().describe("the provider id to repair, e.g. 'stripe'"),
      error: z.string().describe("the error message from the failed step"),
      callSite: z
        .string()
        .optional()
        .describe("how the failing step calls the provider (the step's code)"),
      sampleInput: z
        .string()
        .optional()
        .describe("the failing step's resolved input values, as JSON"),
    }),
    execute: async ({ providerId, error, callSite, sampleInput }) => {
      const draft = await registry.getProviderDraft(spaceId, providerId);
      if (!draft) return { ok: false, message: `provider '${providerId}' not found` };
      const { draft: repaired, changeNote } = await repairProvider(
        draft,
        error,
        callSite,
        sampleInput,
        meta,
      );
      registry.registerProviderFromDraft(spaceId, repaired);
      await registry.persistProvider(spaceId, repaired);
      return { ok: true, providerId: repaired.id, changeNote };
    },
  }),
  update_provider: tool({
    description:
      "Edit an existing AI-authored provider per a user request — e.g. switch its credential to a Service Account JSON key or client id+secret, add/fix the setup guide, add help text to a field, or rename a credential field. Use this (NOT repair_provider) when the user wants to CHANGE how a connection is set up or what credential it asks for. After it returns, the next time the user opens that provider's connection dialog they'll see the updated fields + guide.",
    inputSchema: z.object({
      providerId: z.string().describe("the provider id to edit, e.g. 'google_sheets'"),
      instruction: z
        .string()
        .describe(
          "what to change, in one sentence — e.g. 'use a Service Account JSON key instead', 'add a setup guide explaining where to get the Slack bot token', 'the token field needs help text'",
        ),
    }),
    execute: async ({ providerId, instruction }) => {
      const draft = await registry.getProviderDraft(spaceId, providerId);
      if (!draft)
        return {
          ok: false,
          message: `provider '${providerId}' not found (only AI-authored providers can be edited)`,
        };
      const { draft: updated, changeNote } = await updateProvider(
        draft,
        instruction,
        meta,
      );
      registry.registerProviderFromDraft(spaceId, updated);
      await registry.persistProvider(spaceId, updated);
      return { ok: true, providerId: updated.id, changeNote };
    },
  }),
  wire: tool({
    description:
      "Connect funcs by feeding an upstream func's output into a downstream func's input. Pass ALL the connections you need as a single batch in one call — never call this repeatedly for the same edit. Call after the funcs are authored.",
    inputSchema: z.object({
      wires: z
        .array(
          z.object({
            sourceFunc: z
              .string()
              .describe("upstream func id (the step data comes from)"),
            targetFunc: z
              .string()
              .describe("downstream func id (the step data goes to)"),
            outputField: z
              .string()
              .optional()
              .describe("output field name of the source func"),
            inputName: z
              .string()
              .optional()
              .describe("input name of the target func"),
          }),
        )
        .min(1)
        .describe("every connection to make, batched into one call"),
    }),
    execute: async ({ wires }) => ({
      wires: wires.map((w) => ({
        from: w.sourceFunc,
        to: w.targetFunc,
        fromOutput: w.outputField ?? "",
        toInput: w.inputName ?? "",
      })),
    }),
  }),
  list_files: tool({
    description:
      "List files the user uploaded to this space (id, name, mime type, size). Use it to see what files are available — e.g. a CSV/JSON/text the user wants a workflow to process. Call read_file to read a file's content.",
    inputSchema: z.object({}),
    execute: async () =>
      (await fileService.list(spaceId)).map((f) => ({
        id: f.id,
        name: f.name,
        mime: f.mime,
        size: f.size,
      })),
  }),
  read_file: tool({
    description:
      "Read an uploaded file's content by id (from list_files). Returns text for text/CSV/JSON/XML/YAML files (truncated if large); for binary files returns metadata only. Use it to understand a file's columns/structure before building a workflow around it.",
    inputSchema: z.object({
      fileId: z.string().describe("the file id from list_files"),
    }),
    execute: async ({ fileId }) => {
      const meta = await fileService.get(spaceId, fileId);
      if (!meta) return { error: "file not found" };
      const isText =
        /^text\/|json|csv|xml|ya?ml|javascript|ndjson|plain/i.test(meta.mime) ||
        /\.(csv|tsv|json|txt|md|xml|ya?ml|log)$/i.test(meta.name);
      if (!isText)
        return {
          id: meta.id,
          name: meta.name,
          mime: meta.mime,
          size: meta.size,
          note: "binary file — content not shown",
        };
      const buf = await fileService.content(spaceId, fileId);
      if (!buf) return { error: "file content missing" };
      const text = buf.toString("utf8");
      const MAX = 7000;
      return {
        id: meta.id,
        name: meta.name,
        mime: meta.mime,
        size: meta.size,
        content:
          text.length > MAX
            ? `${text.slice(0, MAX)}\n…[truncated, ${text.length - MAX} more chars]`
            : text,
      };
    },
  }),
  list_connections: tool({
    description:
      "List the provider connections (credentials) the user has set up in this space. A provider can have MORE THAN ONE connection (e.g. a work and a personal account); each is returned separately with its own id and account label. Returns metadata only — id, provider, account label, and when it was connected. It NEVER returns the secret value itself. Use this to answer questions like 'do I have a connection for X', to tell apart multiple accounts for the same provider, or to check before telling the user whether a step can run.",
    inputSchema: z.object({}),
    execute: async () =>
      (await connections.listConnections(spaceId)).map((cn) => ({
        id: cn.id,
        provider: cn.provider,
        account: cn.account,
        connectedAt: cn.createdAt,
      })),
  }),
  request_connection: tool({
    description:
      "Open the secure connection setup dialog for a provider so the user can enter their own credentials. Use this when the user wants to connect a service, when a workflow needs a provider that has no connection yet, or when the user wants to add ANOTHER account for a provider they already connected (a provider can hold multiple connections). NEVER ask the user to paste an API key, token, password, or any secret into the chat — always use this tool so the secret is entered in the secure dialog and stored encrypted; you never see it. Pass the provider id (e.g. 'slack', 'stripe'); optionally pass a label when adding an additional account.",
    inputSchema: z.object({
      provider: z
        .string()
        .describe("the provider id to connect, e.g. 'slack' or 'stripe'"),
      account: z
        .string()
        .optional()
        .describe(
          "optional label for this connection, useful when adding an extra account for a provider, e.g. 'work' or 'personal'",
        ),
    }),
    execute: async ({ provider, account }) => {
      const existing = (await connections.listConnections(spaceId)).filter(
        (cn) => cn.provider === provider,
      );
      return {
        provider,
        account,
        alreadyConnected: existing.length > 0,
        connectionCount: existing.length,
      };
    },
  }),
  };
}

// ── MergN Doctor: a monitoring/self-healing chat scoped to ONE flow. Reads run
// history/health/analytics/versions/heal-events/buffer; diagnoses + fixes; never
// builds workflows (that's the editor). Fix + version suggestions stream a card
// to the UI that opens the ChangeReview screen. ──
const DOCTOR_SYSTEM = [
  "You are Doctor, MergN's monitoring & self-healing assistant for ONE workflow (given below).",
  "You READ this flow's run history, health, analytics, version history, self-heal events and buffered events; you explain failures in plain language; and you can FIX them.",
  "You do NOT build or author workflows — never propose new steps, wires, or providers. If the user wants to build or edit the flow's logic, tell them to use the editor.",
  "Workflow to diagnose: use the tools to ground EVERY claim in real data — never invent run counts, errors, or numbers.",
  "When the user asks WHY runs are failing without giving a run id: be proactive — call get_analytics and list_runs to see the failure breakdown by errorType, summarize the categories (e.g. '3 logic, 2 transient'), then diagnose_failure on the most recent representative failed run YOURSELF. Never ask the user to hand you a run id, and don't rely on list_heal_events for the cause (that's only past fix attempts).",
  "Failure classes are not the same: a `transient` error (network/timeout/rate-limit/blip) is auto-retried by the runtime and is NOT a code bug — say it self-heals, don't propose a fix; a failure caused by bad INCOMING data/input is the caller's problem, not this flow's bug; only a genuine logic/code/wiring bug in the flow gets a proposed fix. If runs fail for more than one reason, pick a representative one of EACH class — don't fixate on whichever run is newest.",
  "When a run fails, work in this order: (1) check_connection — many failures are just an expired/missing credential; (2) compare_runs — diff the failed run against the last good one to see what changed (often a missing input); (3) for a transient error (timeout/rate-limit/blip) try retry_run, which resumes from the failed step with no double side-effects; (4) only then diagnose_failure + fix_failure for a real code/wiring bug.",
  "Only call fix_failure for a genuine logic/code/wiring bug in the flow. NEVER call fix_failure — and never say you are 'trying to fix' or 'preparing a fix' — for a transient error (it auto-retries; nothing to change) or a bad-input failure (the caller must send valid data). For those, state plainly up front that there is nothing in the flow to fix; do not attempt a fix you already know will be declined. When fix_failure DOES run: if the flow's auto-fix is on it applies the fix (a new healing version is created); otherwise it stages a proposal the user reviews + approves in the diff screen.",
  "If a recent change broke the flow, suggest switching to an earlier version with suggest_version. If a self-heal itself made things worse, use revert_heal to roll back to the pre-heal version. Both open a diff for the user to confirm.",
  "Use incident_summary to write a short postmortem of what happened and what you did.",
  "After a failure, events may buffer while the flow is paused. Use get_buffer to see how many, test_buffer to verify a fix on the first real event, and replay_buffer to process the backlog (idempotent; each resumes from where it left off). You can pause_flow / resume_flow.",
  "Be concise and concrete. Answer in the user's language.",
].join("\n");

// Builds the per-request flow context appended to DOCTOR_SYSTEM (health snapshot
// + last failed run) so the Doctor is grounded without the user pasting anything.
async function buildDoctorContext(spaceId: string, workflowId: string): Promise<string> {
  const wf = await workflows.getWorkflow(spaceId, workflowId);
  const state = await health.recompute(spaceId, workflowId).catch(() => null);
  const recent = await runs.listRuns(spaceId, workflowId, 1).catch(() => []);
  const lastFailed = (await runs.listRuns(spaceId, workflowId, 20).catch(() => [])).find((r) => r.status === "failed");
  const lines = [
    `\n\n--- FLOW UNDER CARE ---`,
    `name: ${wf?.name ?? workflowId}`,
    `id: ${workflowId}`,
    state ? `health: ${state.status}${state.lastError ? ` (last error: ${state.lastError.type})` : ""}` : "",
    recent[0] ? `last run: ${recent[0].status} at ${recent[0].startedAt}` : "no runs yet",
    lastFailed ? `most recent FAILED run id: ${lastFailed.id} (${lastFailed.errorType ?? "unknown"})` : "",
    `--- end ---`,
  ].filter(Boolean);
  return lines.join("\n");
}

// The Doctor's tool set — bound to one workflowId. Read + diagnose + fix (auto or
// propose by the flow's settings) + version-switch + buffer ops. Calls the same
// stores the rest of the app uses; no new engine.
function makeDoctorTools(spaceId: string, writer: UIMessageStreamWriter, workflowId: string) {
  const diagCtx = (runId: string) =>
    buildDiagnosisContext({ getRun: runs.getRun, listRuns: runs.listRuns, getWorkflow: workflows.getWorkflow }, spaceId, runId);
  // this chat is bound to ONE flow — a runId only counts if it belongs to it
  // (prevents acting on another flow's run that shares the same space)
  const ownRun = async (runId: string) => {
    const r = await runs.getRun(spaceId, runId);
    return r && r.workflowId === workflowId ? r : null;
  };

  return {
    list_runs: tool({
      description: "List this flow's recent runs (newest first): id, status, errorType, timestamps. Use to see what's failing and pick a run to diagnose.",
      inputSchema: z.object({ limit: z.number().int().positive().max(50).optional() }),
      execute: async ({ limit }) => runs.listRuns(spaceId, workflowId, limit ?? 20),
    }),
    get_run: tool({
      description: "Full detail of one run: per-step status, error, and resolved input/output (PII-masked on managed). Use after list_runs to understand WHY a run failed.",
      inputSchema: z.object({ runId: z.string() }),
      execute: async ({ runId }) => (await ownRun(runId)) ?? { error: "run not found for this flow" },
    }),
    get_health: tool({
      description: "This flow's current health: status, lastError, liveness/outcome fails.",
      inputSchema: z.object({}),
      execute: async () => (await health.recompute(spaceId, workflowId)) ?? { status: "nodata" },
    }),
    get_analytics: tool({
      description: "This flow's run analytics: success rate, error breakdown by type, latency p50/p95, 24h/7d volume.",
      inputSchema: z.object({}),
      execute: async () => computeAnalytics(await runs.listRuns(spaceId, workflowId), Date.now()),
    }),
    list_versions: tool({
      description: "This flow's version history (source: editor/chat/healing/restore, label, time). Use to spot when a change landed, then suggest_version to roll back.",
      inputSchema: z.object({}),
      execute: async () => versions.list(spaceId, workflowId),
    }),
    list_heal_events: tool({
      description: "Past self-healing attempts for this flow (status, confidence, diagnosis).",
      inputSchema: z.object({ limit: z.number().int().positive().max(50).optional() }),
      execute: async ({ limit }) => healEvents.listForWorkflow(spaceId, workflowId, limit ?? 30),
    }),
    get_buffer: tool({
      description: "Events buffered while this flow was paused (count + FIFO list with masked previews). Use to tell the user how many runs are waiting to be replayed.",
      inputSchema: z.object({}),
      execute: async () => {
        const entries = await buffer.list(spaceId, workflowId);
        return {
          count: entries.length,
          entries: entries.map((e) => ({ id: e.id, seq: e.seq, status: e.status, receivedAt: e.receivedAt, preview: maskValue(e.payload, MASK_DEFAULT) })),
        };
      },
    }),
    diagnose_failure: tool({
      description: "Diagnose a failed run: plain-language cause + whether a fix is possible. Read-only.",
      inputSchema: z.object({ runId: z.string(), language: z.string().optional() }),
      execute: async ({ runId, language }) => {
        if (!(await ownRun(runId))) return { error: "run not found for this flow" };
        const ctx = await diagCtx(runId);
        if (!ctx) return { error: "run not found or not a failure" };
        return fixEngine.diagnose(spaceId, ctx, { language: language ?? "English" });
      },
    }),
    fix_failure: tool({
      description: "Fix a failed run. If this flow's auto-fix is ON it applies the fix directly (new healing version); otherwise it stages a proposal and opens the review screen for the user to approve. Never applies silently when auto-fix is off.",
      inputSchema: z.object({ runId: z.string() }),
      execute: async ({ runId }) => {
        if (!(await ownRun(runId))) return { error: "run not found for this flow" };
        const ctx = await diagCtx(runId);
        if (!ctx) return { error: "run not found or not a failure" };
        const d = await fixEngine.diagnose(spaceId, ctx);
        if (!d.proposedFix) return { fixable: false, plainLanguage: d.plainLanguage, errorType: d.errorType };
        const settings = await flowSettings.get(spaceId, workflowId);
        const allowed = await canHeal(spaceId);
        if (settings.enabled && settings.fixMode === "auto" && allowed) {
          const { versionId } = await fixEngine.applyFix(spaceId, workflowId, d.proposedFix, { runId, mode: "auto" });
          await healEvents.record(spaceId, { spaceId, workflowId, runId, mode: "auto", errorType: d.errorType, confidence: d.confidence, diagnosis: d.plainLanguage, proposal: d.proposedFix, status: "applied", versionId });
          void audit.record(spaceId, { kind: "heal.applied", message: `Doctor auto-applied a fix: ${d.plainLanguage}`, workflowId, actor: "doctor" });
          return { applied: true, versionId, plainLanguage: d.plainLanguage, kind: d.proposedFix.kind };
        }
        const ev = await healEvents.record(spaceId, { spaceId, workflowId, runId, mode: "propose", errorType: d.errorType, confidence: d.confidence, diagnosis: d.plainLanguage, proposal: d.proposedFix, status: "proposed" });
        writer.write({ type: "data-doctor-fix", id: `fix-${randomUUID()}`, data: { event: ev } });
        return { proposed: true, eventId: ev.id, plainLanguage: d.plainLanguage, kind: d.proposedFix.kind, confidence: d.confidence };
      },
    }),
    suggest_version: tool({
      description: "Suggest rolling this flow back to an earlier version (from list_versions). Opens the version diff for the user to review + confirm the switch.",
      inputSchema: z.object({ versionId: z.string() }),
      execute: async ({ versionId }) => {
        const version = (await versions.list(spaceId, workflowId)).find((v) => v.id === versionId);
        if (!version) return { error: "version not found" };
        writer.write({ type: "data-doctor-version", id: `ver-${randomUUID()}`, data: { version } });
        return { suggested: true, versionId, seq: version.seq, source: version.source };
      },
    }),
    pause_flow: tool({
      description: "Pause this flow: webhook events buffer (not lost), schedule/poll ticks stop. Use to stop a misbehaving flow before fixing.",
      inputSchema: z.object({}),
      execute: async () => {
        await workflows.setPaused(spaceId, workflowId, true, "manual");
        if (scheduler) await scheduler.pause(spaceId, workflowId);
        return { ok: true, paused: true };
      },
    }),
    resume_flow: tool({
      description: "Resume this paused flow (re-enables triggers). Does NOT replay buffered events — use replay_buffer for that.",
      inputSchema: z.object({}),
      execute: async () => {
        await workflows.setPaused(spaceId, workflowId, false);
        if (scheduler) await scheduler.resume(spaceId, workflowId);
        return { ok: true, paused: false };
      },
    }),
    test_buffer: tool({
      description: "Test-run the first buffered event's REAL payload (does not consume it) to verify a fix before replaying everything.",
      inputSchema: z.object({}),
      execute: async () => testRunFirst(replayDeps, spaceId, workflowId, new Date().toISOString()),
    }),
    replay_buffer: tool({
      description: "Replay all buffered events FIFO, then unpause. Idempotent; each resumes from where it left off. Use after a fix is verified.",
      inputSchema: z.object({}),
      execute: async () => replayBuffer(replayDeps, spaceId, workflowId),
    }),
    retry_run: tool({
      description: "Re-run a failed run, RESUMING from the step that failed (completed steps are not redone — no double side-effects). First move for a transient error (timeout, rate-limit, brief outage) before attempting a code fix.",
      inputSchema: z.object({ runId: z.string() }),
      execute: async ({ runId }) => {
        if (!(await ownRun(runId))) return { error: "run not found for this flow" };
        const wf = await workflows.getWorkflow(spaceId, workflowId);
        if (!wf) return { error: "workflow not found" };
        const run = await runSavedWorkflow(spaceId, wf, {}, "manual", undefined, { runId });
        return { ok: true, newRunId: run.id, status: run.status };
      },
    }),
    compare_runs: tool({
      description: "Compare a failed run to this flow's most recent SUCCESSFUL run, step by step — surfaces what changed (e.g. an input field that's now empty/missing). Read-only; the strongest root-cause tool.",
      inputSchema: z.object({ runId: z.string() }),
      execute: async ({ runId }) => {
        const failed = await ownRun(runId);
        if (!failed) return { error: "run not found for this flow" };
        const goodMeta = (await runs.listRuns(spaceId, workflowId)).find((r) => r.status === "done");
        const good = goodMeta ? await runs.getRun(spaceId, goodMeta.id) : null;
        const byNode = (recs: { nodeId: string; status: string; resolvedInput?: unknown; output?: unknown; error?: string }[]) =>
          Object.fromEntries(
            recs.filter((x) => x.nodeId !== "trigger").map((x) => [x.nodeId, { status: x.status, resolvedInput: x.resolvedInput, output: x.output, error: x.error }]),
          );
        return {
          failedRunId: runId,
          lastGoodRunId: good?.id ?? null,
          input: { failed: failed.input, lastGood: good?.input ?? null },
          steps: { failed: byNode(failed.records ?? []), lastGood: good ? byNode(good.records ?? []) : null },
          note: good ? "Compare each node's resolvedInput between failed and lastGood to spot what changed." : "No successful run to compare against — diagnose from the failed run alone.",
        };
      },
    }),
    check_connection: tool({
      description: "Check whether a failure is caused by a missing or expired provider connection (credential). Looks at the failed step's required provider + the user's connections. Use when the error looks like auth/401/403/token/credential.",
      inputSchema: z.object({ runId: z.string() }),
      execute: async ({ runId }) => {
        const run = await ownRun(runId);
        if (!run) return { error: "run not found for this flow" };
        const failedStep = (run.records ?? []).find((r) => r.status === "failed");
        const wf = await workflows.getWorkflow(spaceId, workflowId);
        const func = (wf?.funcs as Array<{ id: string; requires?: { provider?: string }[] }> | undefined)?.find((f) => f.id === failedStep?.nodeId);
        const providers = (func?.requires ?? []).map((r) => r.provider).filter((p): p is string => !!p);
        const conns = await connections.listConnections(spaceId);
        const providerStatus = providers.map((p) => ({ provider: p, connected: conns.some((c) => c.provider === p) }));
        const authish = run.errorType === "auth" || /401|403|unauthor|forbidden|token|credential|api[_ -]?key|expired/i.test(failedStep?.error ?? "");
        return {
          failedStep: failedStep?.nodeId,
          error: failedStep?.error,
          errorType: run.errorType,
          providers: providerStatus,
          looksLikeAuth: authish,
          hint: providerStatus.some((s) => !s.connected)
            ? "A required provider has NO connection — ask the user to connect it (it can't authenticate)."
            : authish
              ? "Auth-style error but a connection exists — the credential is likely expired/invalid; ask the user to reconnect it."
              : "Doesn't look connection-related.",
        };
      },
    }),
    revert_heal: tool({
      description: "Roll back a self-heal that made things worse: targets the version BEFORE the most recent healing change and opens the diff for the user to confirm the rollback.",
      inputSchema: z.object({}),
      execute: async () => {
        const vers = await versions.list(spaceId, workflowId); // newest-first
        const lastHeal = vers.find((v) => v.source === "healing");
        if (!lastHeal) return { error: "no healing version to revert" };
        const parent = lastHeal.parentVersionId ? vers.find((v) => v.id === lastHeal.parentVersionId) : null;
        if (!parent) return { error: "the healing version has no pre-heal parent to revert to" };
        writer.write({ type: "data-doctor-version", id: `ver-${randomUUID()}`, data: { version: parent } });
        return { reverting: true, toVersionId: parent.id, toSeq: parent.seq, fromHealVersion: lastHeal.id };
      },
    }),
    incident_summary: tool({
      description: "Produce a postmortem of this flow's recent incident: failures, what was diagnosed, which fixes were applied/proposed/rejected, and kill-switch/settings events. Use to summarize 'what happened'.",
      inputSchema: z.object({}),
      execute: async () => {
        const heals = await healEvents.listForWorkflow(spaceId, workflowId, 20);
        const auditEvts = await audit.list(spaceId, { workflowId, limit: 20 });
        const failedRuns = (await runs.listRuns(spaceId, workflowId, 40)).filter((r) => r.status === "failed").slice(0, 10);
        return {
          failedRuns: failedRuns.map((r) => ({ id: r.id, errorType: r.errorType, at: r.startedAt })),
          healEvents: heals.map((e) => ({ status: e.status, confidence: e.confidence, diagnosis: e.diagnosis, mode: e.mode, at: e.at })),
          audit: auditEvts.map((a) => ({ kind: a.kind, message: a.message, at: a.ts, actor: a.actor })),
          note: "Write a short postmortem: what failed, the likely cause, what was done, and the current state.",
        };
      },
    }),
  };
}

function oauthResultPage(ok: boolean, detail: string): string {
  const payload = JSON.stringify({ type: "oauth-result", ok, detail });
  const title = ok ? "Connected" : "Connection failed";
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>body{font-family:ui-sans-serif,system-ui;background:#1a1a1e;color:#eee;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}div{text-align:center}</style></head>
<body><div><h3>${title}</h3><p style="color:#999">${ok ? detail : detail.replace(/</g, "&lt;")}</p><p style="color:#666;font-size:13px">You can close this window.</p></div>
<script>try{window.opener&&window.opener.postMessage(${payload},"*")}catch(e){}setTimeout(function(){window.close()},${ok ? 600 : 2500})</script>
</body></html>`;
}

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (ch) =>
    ch === "&"
      ? "&amp;"
      : ch === "<"
        ? "&lt;"
        : ch === ">"
          ? "&gt;"
          : ch === '"'
            ? "&quot;"
            : "&#39;",
  );

const mcpPageShell = (inner: string) =>
  `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>MergN</title>
<style>body{font-family:ui-sans-serif,system-ui;background:#0f0f12;color:#eaeaea;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
.card{background:#1a1a1f;border:1px solid #2a2a32;border-radius:14px;padding:28px;max-width:380px;width:90%}
h2{margin:0 0 6px;font-size:18px}p{color:#9a9aa5;font-size:14px;line-height:1.5}
label{display:block;font-size:12px;color:#9a9aa5;margin:14px 0 6px}
select{width:100%;padding:9px;border-radius:8px;background:#0f0f12;color:#eaeaea;border:1px solid #2a2a32;font-size:14px}
.row{display:flex;gap:10px;margin-top:20px}button{flex:1;padding:10px;border-radius:8px;border:0;font-size:14px;cursor:pointer}
.approve{background:#6d5efc;color:#fff}.deny{background:#26262e;color:#cfcfd6}.app{color:#cfcfd6;font-weight:600}</style></head>
<body><div class="card">${inner}</div></body></html>`;

function mcpErrorPage(msg: string): string {
  return mcpPageShell(
    `<h2>Connection failed</h2><p>${esc(msg)}</p><p style="color:#666;font-size:13px">You can close this window.</p>`,
  );
}

function mcpConsentPage(
  clientName: string | undefined,
  q: Record<string, string>,
  spaces: { id: string; name: string }[],
  email: string,
): string {
  const hidden = [
    "client_id",
    "redirect_uri",
    "response_type",
    "code_challenge",
    "code_challenge_method",
    "state",
    "scope",
    "resource",
  ]
    .filter((k) => q[k] != null)
    .map((k) => `<input type="hidden" name="${k}" value="${esc(q[k])}">`)
    .join("");
  const opts = spaces
    .map((s) => `<option value="${esc(s.id)}">${esc(s.name)}</option>`)
    .join("");
  const who = clientName ? esc(clientName) : "An application";
  return mcpPageShell(`
<h2>Connect to MergN</h2>
<p><span class="app">${who}</span> wants to access your workflows and run them on your behalf.</p>
<form method="post" action="/authorize">
${hidden}
<p style="font-size:12px;color:#6f6f78">Signed in as ${esc(email)}</p>
<label>Workspace</label>
<select name="space_id">${opts}</select>
<div class="row">
<button class="deny" name="deny" value="1" type="submit">Deny</button>
<button class="approve" name="approve" value="1" type="submit">Allow</button>
</div>
</form>`);
}

const app = new Hono<{ Variables: { spaceId: string; userId: string } }>();

app.on(["POST", "GET"], "/api/auth/*", (c) => auth.handler(c.req.raw));

// Self-host single-user mode: skip auth entirely and act as one local user.
const DISABLE_AUTH =
  process.env.DISABLE_AUTH === "1" || process.env.DISABLE_AUTH === "true";
const LOCAL_USER = {
  id: "local",
  email: "local@localhost",
  name: "Local",
  emailVerified: true,
};

app.get("/api/config", (c) =>
  c.json({
    authDisabled: DISABLE_AUTH,
    managed: MANAGED,
    mcpEnabled: MCP_ENABLED,
    remoteMcp: REMOTE_MCP_ENABLED,
    maxSpaces: LIMITS.maxSpacesPerUser,
    requireEmailVerification: emailVerificationRequired,
  }),
);

app.use("/api/*", async (c, next) => {
  const path = c.req.path;
  if (
    path.startsWith("/api/auth/") ||
    path.startsWith("/api/hooks/") ||
    path === "/api/config" ||
    (MANAGED && path === "/api/billing/webhook")
  )
    return next();

  const user = DISABLE_AUTH
    ? LOCAL_USER
    : await getSessionUser(c.req.raw.headers);
  if (!user) return c.json({ error: "unauthorized" }, 401);

  // Gate unverified users out of the app API (the verify flow itself runs under
  // /api/auth/, already excluded above). Frontend shows the verification screen.
  if (emailVerificationRequired && !user.emailVerified)
    return c.json({ error: "email_not_verified" }, 403);

  const personal = await membership.ensurePersonalSpace(user);
  let spaceId = personal.id;
  const raw = c.req.header("x-space-id");
  if (raw) {
    let candidate: string;
    try {
      candidate = assertSpace(raw);
    } catch {
      return c.json({ error: "invalid space id" }, 400);
    }
    if (!DISABLE_AUTH && !(await membership.canAccess(user.id, candidate)))
      return c.json({ error: "forbidden" }, 403);
    spaceId = candidate;
  }
  await registry.ensureSpace(spaceId);
  c.set("spaceId", spaceId);
  c.set("userId", user.id);
  await next();
});

app.get("/api/chat/conversations", async (c) => {
  // builder list — exclude Doctor (monitoring) chats, which live per-flow under
  // a `doctor_<workflowId>_` conversation id.
  const all = await chats.listConversations(c.get("spaceId"), c.get("userId"));
  return c.json(all.filter((d) => !d.id.startsWith("doctor_")));
});

app.get("/api/chat/conversations/:id", async (c) => {
  const doc = await chats.getConversation(
    c.get("spaceId"),
    c.get("userId"),
    c.req.param("id"),
  );
  return c.json(doc?.messages ?? []);
});

app.delete("/api/chat/conversations/:id", async (c) => {
  await chats.deleteConversation(
    c.get("spaceId"),
    c.get("userId"),
    c.req.param("id"),
  );
  return c.json({ ok: true });
});

app.post("/api/chat", async (c) => {
  const spaceId = c.get("spaceId");
  const userId = c.get("userId");
  const { message: rawMessage, conversationId, workflowState, triggerKind, eventFields } =
    await c.req.json<{
      message: UIMessage;
      conversationId: string;
      workflowState?: string;
      triggerKind?: string;
      eventFields?: string[];
    }>();
  if (!/^[A-Za-z0-9_-]+$/.test(conversationId ?? ""))
    return c.json({ error: "bad conversation id" }, 400);

  // a space on its OWN api key pays for its own tokens, so it bypasses our rate
  // limits + usage caps and is not counted toward our usage.
  await ensureSpaceLlm(spaceId);
  const ownKey = spaceUsesOwnKey(spaceId);

  if (!ownKey) {
    const userLimit = await rateLimiter.take(
      `chat:user:${userId}`,
      CHAT_USER_LIMIT,
    );
    const limit: RateLimitResult = userLimit.ok
      ? await rateLimiter.take("chat:global", CHAT_GLOBAL_LIMIT)
      : userLimit;
    if (!limit.ok) {
      return c.json(
        {
          error: "rate_limited",
          message:
            "You're sending messages a bit too fast. Please wait a moment and try again.",
          retryAfterMs: limit.retryAfterMs,
        },
        429,
        { "Retry-After": String(Math.ceil(limit.retryAfterMs / 1000)) },
      );
    }

    if (await usageCapExceeded()) {
      return c.json(
        {
          error: "usage_cap",
          message:
            "The AI usage limit for this deployment has been reached. Please try again later.",
        },
        402,
      );
    }
  }

  const message = clampUserMessage(rawMessage);
  const previous =
    (await chats.getConversation(spaceId, userId, conversationId))?.messages ??
    [];

  // Plan limits: Free is capped on number of conversations, Pro on monthly
  // tokens. A new conversation is one with no prior messages. Only enforced when
  // billing (Stripe) is configured — otherwise there's no way to upgrade, so we
  // leave usage uncapped (the global GLOBAL_TOKEN_CAP still applies).
  const plan = await billing.planOf(spaceId);
  const spaceUsage = await usage.get(spaceId);
  const isNewChat = previous.length === 0;
  if (
    MANAGED &&
    billing.enabled() &&
    plan.limits.chats >= 0 &&
    isNewChat &&
    spaceUsage.chats >= plan.limits.chats
  ) {
    return c.json(
      {
        error: "plan_limit",
        limit: "chats",
        plan: plan.slug,
        message: `You've used all ${plan.limits.chats} chats on the Free plan this month. Upgrade to Pro to keep building.`,
      },
      402,
    );
  }
  if (
    !ownKey &&
    MANAGED &&
    billing.enabled() &&
    plan.limits.aiTokens >= 0 &&
    spaceUsage.aiTokens >= plan.limits.aiTokens
  ) {
    return c.json(
      {
        error: "plan_limit",
        limit: "tokens",
        plan: plan.slug,
        message:
          "You've used all your AI tokens for this month. They reset at the start of next month, or contact us for a higher limit.",
      },
      402,
    );
  }
  // NOTE: the chat is counted in onFinish (below), NOT here — so a chat is only
  // billed once it actually completes and is saved. Counting up-front would burn
  // a chat on a failed/empty response, and double-count a retry of a first
  // message that errored before it was ever persisted (previous stays []).

  const messages = [...(previous as UIMessage[]), message];
  const modelMessages = await convertToModelMessages(messages);

  const system =
    workflowState && workflowState.trim()
      ? SYSTEM +
        "\n\n--- CURRENT WORKFLOW (live state, may be unsaved) ---\n" +
        workflowState +
        "\n--- end of current workflow ---\n" +
        "This is what already exists. For edits, target steps by their [id] and reuse exact field names shown above. Use author_func/wire for small changes; only call design_workflow to build a brand-new workflow from scratch, never for an edit."
      : SYSTEM;

  const sessionId = `chat-${randomUUID()}`;

  const stream = createUIMessageStream({
    originalMessages: messages,
    generateId: createIdGenerator({ prefix: "msg", size: 16 }),
    execute: ({ writer }) => {
      const result = streamText({
        model: getModel(spaceId),
        system,
        messages: modelMessages,
        stopWhen: [
          stepCountIs(20),
          // bound a runaway prompt — but a space on its own key pays for its own
          // tokens, so don't cap its per-prompt usage.
          ({ steps }) =>
            !ownKey &&
            steps.reduce((sum, s) => sum + (s.usage?.totalTokens ?? 0), 0) >=
              LIMITS.promptTokenCap,
        ],
        maxOutputTokens: LIMITS.maxOutputTokens,
        tools: withResultLimits(
          makeTools(spaceId, writer, sessionId, { kind: triggerKind, eventFields }),
        ),
        providerOptions: {
          google: { thinkingConfig: { includeThoughts: true } },
        },
        experimental_telemetry: trace("builder-chat", { spaceId, sessionId }),
        onFinish: (event) => {
          const t = event.totalUsage?.totalTokens ?? 0;
          // own-key spaces pay their own way — don't count their tokens as ours
          if (!ownKey) {
            void recordTokens(t);
            void usage.addTokens(spaceId, t);
          }
          void flushTraces();
        },
      });
      // Keep generating + saving even if the client disconnects mid-stream (e.g.
      // the user navigated away or reloaded). Without this the model stream is
      // tied to the HTTP response, so a disconnect would drop the in-flight
      // assistant message before onFinish persists it. consumeStream drains the
      // model independently; the writer.merge below still streams to the client
      // while it's connected, and on return useConversation reloads the saved
      // message.
      void result.consumeStream();
      writer.merge(
        result.toUIMessageStream({
          sendReasoning: true,
          messageMetadata: ({ part }) =>
            part.type === "finish"
              ? { totalUsage: part.totalUsage }
              : undefined,
        }),
      );
    },
    onFinish: async ({ messages }) => {
      await chats.saveConversation(spaceId, userId, conversationId, messages);
      // Count the chat only now that it completed and was persisted. Fires once
      // per new conversation; consumeStream() guarantees this runs even if the
      // client disconnected mid-stream, so a completed-but-disconnected chat is
      // still counted, while a failed one (onError, no onFinish) is not.
      if (isNewChat) await usage.recordChat(spaceId);
    },
    onError: (error) => {
      console.error("STREAM ERROR:", error);
      const msg = error instanceof Error ? error.message : String(error);
      void userLogs.append(spaceId, {
        level: "error",
        source: "chat",
        message: "Chat/build stream error",
        detail: msg,
      });
      return msg;
    },
  });

  return createUIMessageStreamResponse({ stream });
});

// MergN Doctor — a monitoring/self-healing chat scoped to one flow. Same agentic
// stream + budget/plan guards as /api/chat, but a diagnostic persona + a
// read/diagnose/fix/version/buffer tool set (no workflow authoring).
app.post("/api/doctor/chat", async (c) => {
  const spaceId = c.get("spaceId");
  const userId = c.get("userId");
  const { message: rawMessage, conversationId, workflowId } = await c.req.json<{
    message: UIMessage;
    conversationId: string;
    workflowId?: string;
  }>();
  if (!/^[A-Za-z0-9_-]+$/.test(conversationId ?? "")) return c.json({ error: "bad conversation id" }, 400);
  if (!workflowId) return c.json({ error: "workflowId required" }, 400);

  await ensureSpaceLlm(spaceId);
  const ownKey = spaceUsesOwnKey(spaceId);
  if (!ownKey) {
    const userLimit = await rateLimiter.take(`chat:user:${userId}`, CHAT_USER_LIMIT);
    const limit: RateLimitResult = userLimit.ok ? await rateLimiter.take("chat:global", CHAT_GLOBAL_LIMIT) : userLimit;
    if (!limit.ok)
      return c.json({ error: "rate_limited", message: "You're sending messages a bit too fast. Please wait a moment and try again.", retryAfterMs: limit.retryAfterMs }, 429, { "Retry-After": String(Math.ceil(limit.retryAfterMs / 1000)) });
    if (await usageCapExceeded())
      return c.json({ error: "usage_cap", message: "The AI usage limit for this deployment has been reached. Please try again later." }, 402);
  }

  const message = clampUserMessage(rawMessage);
  const previous = (await chats.getConversation(spaceId, userId, conversationId))?.messages ?? [];
  const plan = await billing.planOf(spaceId);
  const spaceUsage = await usage.get(spaceId);
  const isNewChat = previous.length === 0;
  if (MANAGED && billing.enabled() && plan.limits.chats >= 0 && isNewChat && spaceUsage.chats >= plan.limits.chats)
    return c.json({ error: "plan_limit", limit: "chats", plan: plan.slug, message: `You've used all ${plan.limits.chats} chats on the Free plan this month. Upgrade to Pro to keep building.` }, 402);
  if (!ownKey && MANAGED && billing.enabled() && plan.limits.aiTokens >= 0 && spaceUsage.aiTokens >= plan.limits.aiTokens)
    return c.json({ error: "plan_limit", limit: "tokens", plan: plan.slug, message: "You've used all your AI tokens for this month. They reset at the start of next month, or contact us for a higher limit." }, 402);

  const messages = [...(previous as UIMessage[]), message];
  const modelMessages = await convertToModelMessages(messages);
  const system = DOCTOR_SYSTEM + (await buildDoctorContext(spaceId, workflowId));
  const sessionId = `doctor-${randomUUID()}`;

  const stream = createUIMessageStream({
    originalMessages: messages,
    generateId: createIdGenerator({ prefix: "msg", size: 16 }),
    execute: ({ writer }) => {
      const result = streamText({
        model: getModel(spaceId),
        system,
        messages: modelMessages,
        stopWhen: [
          stepCountIs(20),
          ({ steps }) => !ownKey && steps.reduce((sum, s) => sum + (s.usage?.totalTokens ?? 0), 0) >= LIMITS.promptTokenCap,
        ],
        maxOutputTokens: LIMITS.maxOutputTokens,
        tools: withResultLimits(makeDoctorTools(spaceId, writer, workflowId)),
        providerOptions: { google: { thinkingConfig: { includeThoughts: true } } },
        experimental_telemetry: trace("doctor-chat", { spaceId, sessionId }),
        onFinish: (event) => {
          const t = event.totalUsage?.totalTokens ?? 0;
          if (!ownKey) {
            void recordTokens(t);
            void usage.addTokens(spaceId, t);
          }
          void flushTraces();
        },
      });
      void result.consumeStream();
      writer.merge(
        result.toUIMessageStream({
          sendReasoning: true,
          messageMetadata: ({ part }) => (part.type === "finish" ? { totalUsage: part.totalUsage } : undefined),
        }),
      );
    },
    onFinish: async ({ messages }) => {
      await chats.saveConversation(spaceId, userId, conversationId, messages);
      if (isNewChat) await usage.recordChat(spaceId);
    },
    onError: (error) => {
      console.error("DOCTOR STREAM ERROR:", error);
      const msg = error instanceof Error ? error.message : String(error);
      void userLogs.append(spaceId, { level: "error", source: "chat", message: "Doctor stream error", detail: msg });
      return msg;
    },
  });

  return createUIMessageStreamResponse({ stream });
});

app.get("/api/workflows", async (c) => {
  return c.json(await workflows.listWorkflows(c.get("spaceId")));
});

app.get("/api/workflows/:id", async (c) => {
  const wf = await workflows.getWorkflow(c.get("spaceId"), c.req.param("id"));
  return wf ? c.json(wf) : c.json({ error: "not found" }, 404);
});

// Per-flow health for a workflow. Recompute from run history, preserving any
// liveness fail the evaluator has flagged.
app.get("/api/workflows/:id/health", async (c) => {
  const state = await health.recompute(c.get("spaceId"), c.req.param("id"));
  return c.json(state);
});

// Toggle external alerts for one flow (default OFF). Reads current + merges so
// the gear can flip it without re-sending the whole workflow.
app.patch("/api/workflows/:id/alerts", async (c) => {
  const spaceId = c.get("spaceId");
  const id = c.req.param("id");
  const { enabled } = await c.req.json<{ enabled?: boolean }>();
  if (typeof enabled !== "boolean") return c.json({ error: "enabled (boolean) required" }, 400);
  const wf = await workflows.getWorkflow(spaceId, id);
  if (!wf) return c.json({ error: "not found" }, 404);
  await workflows.saveWorkflow(spaceId, { ...wf, alertsEnabled: enabled });
  return c.json({ ok: true, alertsEnabled: enabled });
});

// Space-wide health summary.
app.get("/api/health", async (c) => {
  return c.json(await health.summary(c.get("spaceId")));
});

// ── Alert channels (Telegram / Slack / Discord / email / webhook / workflow) ─
const ALERT_KINDS: ChannelKind[] = [
  "telegram", "slack", "discord", "email", "webhook",
];
const ALERT_SEVERITIES: Severity[] = ["info", "warn", "critical"];
const ALERT_CATEGORIES: AlertCategory[] = [
  "error", "silent_failure", "silent_success", "recovered", "healed",
];

app.get("/api/alert-channels", async (c) => {
  return c.json(await alertChannels.list(c.get("spaceId"))); // meta only, no secrets
});

// Flows eligible to handle alerts = those with the "monitor" trigger. The UI
// lists these so the user can pick one for a "workflow" channel.
app.get("/api/monitor-handlers", async (c) => {
  const spaceId = c.get("spaceId");
  const metas = await workflows.listWorkflows(spaceId);
  const out: { id: string; name: string }[] = [];
  for (const m of metas) {
    const wf = await workflows.getWorkflow(spaceId, m.id);
    if (wf?.trigger?.kind === "monitor") out.push({ id: wf.id, name: wf.name });
  }
  return c.json(out);
});

app.post("/api/alert-channels", async (c) => {
  const body = await c.req.json<{
    kind?: string;
    label?: string;
    minSeverity?: string;
    categories?: string[];
    secret?: ChannelSecret;
  }>();
  if (!body.kind || !ALERT_KINDS.includes(body.kind as ChannelKind))
    return c.json({ error: "invalid channel kind" }, 400);
  if (!body.secret || typeof body.secret !== "object")
    return c.json({ error: "secret required" }, 400);
  // kind-specific config validation
  if (body.kind === "webhook" && !(body.secret as { url?: string }).url)
    return c.json({ error: "webhook channel needs secret.url" }, 400);
  const minSeverity =
    body.minSeverity && ALERT_SEVERITIES.includes(body.minSeverity as Severity)
      ? (body.minSeverity as Severity)
      : undefined;
  const categories = Array.isArray(body.categories)
    ? body.categories.filter((x): x is AlertCategory => ALERT_CATEGORIES.includes(x as AlertCategory))
    : undefined;
  const meta = await alertChannels.add(c.get("spaceId"), {
    kind: body.kind as ChannelKind,
    label: body.label,
    minSeverity,
    categories: categories?.length ? categories : undefined,
    secret: body.secret,
  });
  return c.json(meta);
});

app.patch("/api/alert-channels/:id", async (c) => {
  const body = await c.req.json<{ enabled?: boolean }>();
  if (typeof body.enabled !== "boolean")
    return c.json({ error: "enabled (boolean) required" }, 400);
  await alertChannels.setEnabled(c.get("spaceId"), c.req.param("id"), body.enabled);
  return c.json({ ok: true });
});

app.delete("/api/alert-channels/:id", async (c) => {
  await alertChannels.remove(c.get("spaceId"), c.req.param("id"));
  return c.json({ ok: true });
});

// Send a test alert through all configured channels (verifies setup).
app.post("/api/alert-channels/test", async (c) => {
  await alerts.deliver(
    c.get("spaceId"),
    {
      workflowId: "test",
      status: "degraded",
      severity: "warn",
      reason: "error",
      category: "error",
      title: "Test alert",
      detail: "If you can read this, your alert channel works.",
    },
    true, // force — a test always sends, bypassing the per-flow opt-in
  );
  return c.json({ ok: true });
});

// ── Alert handler flows (the user's chosen flows that run on an alert) ──
app.get("/api/alert-handlers", async (c) => {
  const spaceId = c.get("spaceId");
  const entries = await alertHandlers.list(spaceId);
  const rows = await Promise.all(
    entries.map(async (h) => ({
      workflowId: h.workflowId,
      enabled: h.enabled,
      name: (await workflows.getWorkflow(spaceId, h.workflowId))?.name ?? h.workflowId,
    })),
  );
  return c.json(rows);
});

app.post("/api/alert-handlers", async (c) => {
  const spaceId = c.get("spaceId");
  const { workflowId } = await c.req.json<{ workflowId?: string }>().catch(() => ({ workflowId: undefined }));
  if (!workflowId) return c.json({ error: "workflowId required" }, 400);
  if (!(await workflows.getWorkflow(spaceId, workflowId))) return c.json({ error: "workflow not found" }, 404);
  return c.json(await alertHandlers.add(spaceId, workflowId));
});

app.patch("/api/alert-handlers/:workflowId", async (c) => {
  const { enabled } = await c.req.json<{ enabled?: boolean }>().catch(() => ({ enabled: undefined }));
  if (typeof enabled !== "boolean") return c.json({ error: "enabled (boolean) required" }, 400);
  await alertHandlers.setEnabled(c.get("spaceId"), c.req.param("workflowId"), enabled);
  return c.json({ ok: true });
});

app.delete("/api/alert-handlers/:workflowId", async (c) => {
  await alertHandlers.remove(c.get("spaceId"), c.req.param("workflowId"));
  return c.json({ ok: true });
});

// Deterministic (LLM-free) graph normalize: re-derive each step's ports from its
// edited code, drop wires/gates referencing fields that no longer exist, and
// recompute the run-form fields. The editor calls this after a manual code edit
// so hand-edits stay as consistent as AI-authored graphs.
app.post("/api/workflows/normalize", async (c) => {
  const body = await c.req.json<{
    funcs?: NormFunc[];
    wires?: Wire[];
    eventFields?: string[];
  }>();
  return c.json(
    normalizeGraph(body.funcs ?? [], body.wires ?? [], body.eventFields ?? []),
  );
});

app.put("/api/workflows/:id", async (c) => {
  const id = c.req.param("id");
  if (!/^[A-Za-z0-9_-]+$/.test(id)) return c.json({ error: "bad id" }, 400);
  const body = await c.req.json<{
    name?: string;
    funcs?: unknown[];
    wires?: unknown[];
    positions?: Record<string, { x: number; y: number }>;
    config?: Record<string, Record<string, string>>;
    nodeConnections?: Record<string, Record<string, string>>;
    trigger?: TriggerConfig;
    inputForm?: unknown;
    variables?: Record<string, unknown>;
    conversationId?: string;
    outcome?: OutcomeConfig;
    maskLevel?: MaskLevel;
    liveness?: LivenessConfig;
    alertsEnabled?: boolean;
  }>();
  const wf = await workflows.saveWorkflow(c.get("spaceId"), {
    id,
    name: body.name ?? "untitled",
    funcs: body.funcs ?? [],
    wires: body.wires ?? [],
    positions: body.positions ?? {},
    config: body.config ?? {},
    nodeConnections: body.nodeConnections ?? {},
    trigger: body.trigger ?? { kind: "manual" },
    inputForm: body.inputForm,
    variables: body.variables,
    conversationId: body.conversationId,
    ...(body.outcome ? { outcome: body.outcome } : {}),
    ...(body.maskLevel ? { maskLevel: body.maskLevel } : {}),
    ...(body.liveness ? { liveness: body.liveness } : {}),
    ...(typeof body.alertsEnabled === "boolean" ? { alertsEnabled: body.alertsEnabled } : {}),
  });
  if (body.conversationId) {
    await chats.linkWorkflow(
      c.get("spaceId"),
      c.get("userId"),
      body.conversationId,
      id,
    );
  }
  if (scheduler) {
    try {
      await scheduler.reconcile(c.get("spaceId"), wf);
    } catch (e) {
      console.error("schedule reconcile failed", e);
    }
  }
  return c.json(wf);
});

app.delete("/api/workflows/:id", async (c) => {
  const spaceId = c.get("spaceId");
  const id = c.req.param("id");
  if (scheduler) {
    try {
      await scheduler.cancelByWorkflow(spaceId, id);
    } catch (e) {
      console.error("schedule cancel failed", e);
    }
  }
  await workflows.deleteWorkflow(spaceId, id);
  return c.json({ ok: true });
});

// ── workflow versioning ───────────────────────────────────────────────────
// HEAD (the "workflows" doc) is unchanged; these add an append-only version
// log. Sealing is content-hash deduped (bursty autosave/MCP builds coalesce).
app.get("/api/workflows/:id/versions", async (c) =>
  c.json(await versions.list(c.get("spaceId"), c.req.param("id"))),
);

app.get("/api/workflows/:id/versions/:versionId", async (c) => {
  const v = await versions.get(c.get("spaceId"), c.req.param("versionId"));
  if (!v || v.workflowId !== c.req.param("id"))
    return c.json({ error: "version not found" }, 404);
  return c.json(v);
});

// Explicit checkpoint: seal the current HEAD as a version (optional label).
app.post("/api/workflows/:id/versions", async (c) => {
  const spaceId = c.get("spaceId");
  const id = c.req.param("id");
  const head = await workflows.getWorkflow(spaceId, id);
  if (!head) return c.json({ error: "workflow not found" }, 404);
  const body = (await c.req.json().catch(() => ({}))) as {
    label?: string;
    message?: string;
  };
  const { version, deduped } = await versions.seal(spaceId, head, {
    source: "editor",
    label: body.label,
    message: body.message,
    createdBy: c.get("userId"),
  });
  if (!deduped) await workflows.setCurrentVersion(spaceId, id, version.id);
  return c.json({ id: version.id, deduped });
});

// Structured diff between two versions (powers node badges).
app.get("/api/workflows/:id/diff", async (c) => {
  const spaceId = c.get("spaceId");
  const id = c.req.param("id");
  const from = c.req.query("from");
  const to = c.req.query("to");
  if (!from || !to) return c.json({ error: "from and to required" }, 400);
  const a = await versions.get(spaceId, from);
  const b = await versions.get(spaceId, to);
  if (!a || !b || a.workflowId !== id || b.workflowId !== id)
    return c.json({ error: "version not found" }, 404);
  return c.json(diffWorkflows(a.snapshot, b.snapshot));
});

// Everything the change-review screen needs for ONE version: the before
// (parent) + after (this version) snapshots + their diff. before is empty when
// the version has no parent (initial version → everything is "added").
app.get("/api/workflows/:id/versions/:vid/review", async (c) => {
  const spaceId = c.get("spaceId");
  const id = c.req.param("id");
  const v = await versions.get(spaceId, c.req.param("vid"));
  if (!v || v.workflowId !== id) return c.json({ error: "version not found" }, 404);
  const parent = v.parentVersionId ? await versions.get(spaceId, v.parentVersionId) : null;
  const before = parent?.snapshot ?? { funcs: [], wires: [], trigger: null };
  return c.json({ before, after: v.snapshot, diff: diffWorkflows(before, v.snapshot) });
});

// Restore: write a past version's snapshot to HEAD, then seal a NEW version
// marking the restore. History is never mutated (re-restorable).
app.post("/api/workflows/:id/versions/:versionId/restore", async (c) => {
  const spaceId = c.get("spaceId");
  const id = c.req.param("id");
  const target = await versions.get(spaceId, c.req.param("versionId"));
  if (!target || target.workflowId !== id)
    return c.json({ error: "version not found" }, 404);
  const head = await workflows.getWorkflow(spaceId, id);
  if (!head) return c.json({ error: "workflow not found" }, 404);
  const s = target.snapshot;
  await workflows.saveWorkflow(spaceId, {
    id,
    name: s.name ?? head.name,
    funcs: s.funcs ?? [],
    wires: s.wires ?? [],
    positions: s.positions ?? {},
    config: s.config ?? {},
    nodeConnections: s.nodeConnections ?? {},
    trigger: (s.trigger as TriggerConfig) ?? head.trigger ?? { kind: "manual" },
    inputForm: s.inputForm,
    variables: s.variables,
    conversationId: head.conversationId, // keep chat continuity
  });
  // Restore the version's pinned provider code so HEAD runs exactly what this
  // version ran (not a later re-author). Drafts are secret-free; credentials
  // stay live on the connection. This overwrites the provider id space-wide —
  // intended: "restore = go back to this version's behaviour".
  for (const [pid, draft] of Object.entries(
    (s.providers ?? {}) as Record<string, ProviderDraft>,
  )) {
    try {
      await registry.persistProvider(spaceId, draft);
      registry.registerProviderFromDraft(spaceId, draft);
    } catch (e) {
      console.error(`restore: re-register provider ${pid} failed`, e);
    }
  }
  const restored = await workflows.getWorkflow(spaceId, id);
  const { version } = await versions.seal(spaceId, restored!, {
    source: "restore",
    restoredFrom: target.id,
    createdBy: c.get("userId"),
    message: `Restored from ${target.id.slice(0, 8)}`,
  });
  await workflows.setCurrentVersion(spaceId, id, version.id);
  // Flag any node whose pinned connection is now stale (deleted / different
  // provider) so the UI can prompt a reconnect instead of a silent run failure.
  const conns = await connections.listConnections(spaceId);
  const reconnect = checkConnectionBindings(
    bindingsOf(restored?.funcs ?? [], restored?.nodeConnections),
    conns.map((cn) => ({ id: cn.id, provider: cn.provider })),
  );
  return c.json({
    ok: true,
    newVersionId: version.id,
    ...(reconnect.length ? { reconnect } : {}),
  });
});

app.get("/api/workflows/:id/status", async (c) => {
  if (!scheduler) return c.json({ state: "none" });
  return c.json(await scheduler.status(c.get("spaceId"), c.req.param("id")));
});

app.post("/api/workflows/:id/pause", async (c) => {
  const spaceId = c.get("spaceId");
  const id = c.req.param("id");
  const reason =
    ((await c.req.json().catch(() => ({}))) as { reason?: string }).reason === "heal" ? "heal" : "manual";
  // Flow-level pause (durable): webhook events buffer, schedule/poll ticks stop.
  // Works for a webhook-only flow that has no scheduler job.
  await workflows.setPaused(spaceId, id, true, reason);
  if (scheduler) await scheduler.pause(spaceId, id);
  return c.json({ ok: true, state: "paused" });
});

app.post("/api/workflows/:id/resume", async (c) => {
  const spaceId = c.get("spaceId");
  const id = c.req.param("id");
  const wf = await workflows.getWorkflow(spaceId, id);
  if (wf?.trigger?.kind === "poll" && missingRequiredParams(wf.trigger.poll)) {
    return c.json({ error: "missing required parameters", state: "paused" }, 400);
  }
  // resume ≠ replay: clear the flag; buffered events drain via /buffer/replay (D3).
  await workflows.setPaused(spaceId, id, false);
  if (scheduler) await scheduler.resume(spaceId, id);
  if (scheduler && wf && wf.trigger?.kind === "poll") {
    const job = (await scheduleStore.findByWorkflow(spaceId, id))[0];
    if (job) {
      try {
        await fireWorkflow(
          { pollRunner, scheduleStore, runSavedWorkflow },
          spaceId,
          wf,
          job.jobId,
          "poll",
          job.cursor,
        );
      } catch (e) {
        console.error("resume seed poll failed", e);
      }
    }
  }
  return c.json({ ok: true, state: "active" });
});

// ── No-data-loss buffer: list / test / replay / drop held trigger events ──
app.get("/api/workflows/:id/buffer", async (c) => {
  const spaceId = c.get("spaceId");
  const id = c.req.param("id");
  const wf = await workflows.getWorkflow(spaceId, id);
  const entries = await buffer.list(spaceId, id);
  // Mask each payload for the UI list — the raw event stays sealed in storage.
  const rows = entries.map((e) => ({
    id: e.id,
    seq: e.seq,
    status: e.status,
    receivedAt: e.receivedAt,
    preview: maskValue(e.payload, MASK_DEFAULT),
  }));
  return c.json({
    entries: rows,
    paused: !!wf?.paused,
    pausedAt: wf?.pausedAt,
    pausedReason: wf?.pausedReason,
  });
});

app.post("/api/workflows/:id/buffer/test", async (c) => {
  const spaceId = c.get("spaceId");
  const id = c.req.param("id");
  const res = await testRunFirst(replayDeps, spaceId, id, new Date().toISOString());
  return c.json(res);
});

app.post("/api/workflows/:id/buffer/replay", async (c) => {
  const spaceId = c.get("spaceId");
  const id = c.req.param("id");
  const res = await replayBuffer(replayDeps, spaceId, id);
  return c.json({ ok: true, ...res });
});

app.delete("/api/workflows/:id/buffer/:entryId", async (c) => {
  await buffer.remove(c.get("spaceId"), c.req.param("entryId"));
  return c.json({ ok: true });
});

app.post("/api/run", async (c) => {
  const spaceId = c.get("spaceId");
  const body = await c.req.json<{
    funcs?: Parameters<typeof runWorkflow>[1];
    wires?: Parameters<typeof runWorkflow>[2];
    input?: Record<string, unknown>;
    config?: Record<string, Record<string, string>>;
    nodeConnections?: Record<string, Record<string, string>>;
    workflowId?: string;
    workflowName?: string;
    runId?: string;
    resumeRunId?: string;
  }>();
  let input = body.input ?? {};
  let seed: StepRecord[] | undefined;
  if (body.resumeRunId) {
    const loaded = await loadResumeSeed(spaceId, body.resumeRunId);
    if (loaded) {
      seed = loaded.seed;
      input = loaded.input;
    }
  }
  const runDocId = body.runId ?? randomUUID();
  return streamSSE(c, async (stream) => {
    const startedAt = new Date().toISOString();
    const records: StepRecord[] = [];
    await runWorkflow(
      { spaceId, registry, connections, files: fileService },
      body.funcs ?? [],
      body.wires ?? [],
      input,
      body.config ?? {},
      body.nodeConnections ?? {},
      async (record) => {
        records.push(record);
        await stream.writeSSE({ data: JSON.stringify(record) });
      },
      seed,
    );
    await stream.writeSSE({ data: "[DONE]" });
    if (body.workflowId) {
      const status = records.some((r) => r.status === "failed")
        ? "failed"
        : "done";
      let errorType: ErrorType | undefined;
      let failMessage: string | undefined;
      if (status === "failed") {
        const errs = records
          .filter((r) => r.status === "failed")
          .map((r) => `${r.nodeId}: ${r.error ?? "failed"}`)
          .join("; ");
        failMessage = errs || "unknown error";
        errorType = classifyError(failMessage);
        void userLogs.append(spaceId, {
          level: "error",
          source: "run",
          message: `Run failed: ${body.workflowName ?? "untitled"} (manual)`,
          detail: failMessage,
          workflowId: body.workflowId,
        });
      }
      await runs.saveRun(spaceId, {
        id: runDocId,
        workflowId: body.workflowId,
        workflowName: body.workflowName ?? "untitled",
        trigger: body.resumeRunId ? "resume" : "manual",
        status,
        ...(errorType ? { errorType } : {}),
        input,
        records,
        startedAt,
        finishedAt: new Date().toISOString(),
      });
      // manual runs feed health too (errorType + status), same as the recorder
      void health
        .recompute(
          spaceId,
          body.workflowId,
          errorType && failMessage
            ? { lastError: { type: errorType, message: failMessage } }
            : {},
        )
        .catch(() => {});
      emitRun(spaceId, {
        id: runDocId,
        workflowId: body.workflowId,
        status,
        trigger: body.resumeRunId ? "resume" : "manual",
        ...(errorType ? { errorType } : {}),
      });
    }
  });
});

app.post("/api/hooks/:spaceId/:workflowId", async (c) => {
  let spaceId: string;
  try {
    spaceId = assertSpace(c.req.param("spaceId"));
  } catch {
    return c.json({ error: "invalid space id" }, 400);
  }
  const workflowId = c.req.param("workflowId");

  const rl = await rateLimiter.take(`hook:${spaceId}:${workflowId}`, HOOK_LIMIT);
  if (!rl.ok)
    return c.json({ error: "rate_limited" }, 429, {
      "Retry-After": String(Math.ceil(rl.retryAfterMs / 1000)),
    });

  await registry.ensureSpace(spaceId);
  const wf = await workflows.getWorkflow(spaceId, workflowId);
  if (!wf) {
    console.log(`[hook] ${spaceId}/${workflowId} -> 404 workflow not found`);
    return c.json({ error: "workflow not found" }, 404);
  }
  if (wf.trigger?.kind !== "webhook")
    return c.json({ error: "workflow has no webhook trigger" }, 400);

  const rawBody = await c.req.text();
  const headers = Object.fromEntries(c.req.raw.headers.entries()); // keys lowercased
  const authOk = await webhookAuth.verify(spaceId, workflowId, headers, rawBody);
  console.log(
    `[hook] ${workflowId} authOk=${authOk} sigHeaders=${Object.keys(headers).filter((k) => /sign/i.test(k)).join(",") || "none"} bodyLen=${rawBody.length}`,
  );
  if (!authOk) return c.json({ error: "unauthorized" }, 401);

  // auth-only probe used by the "Test" button — verifies without running
  if (c.req.header("x-webhook-test")) return c.json({ ok: true, test: true });

  let body: Record<string, unknown> = {};
  try {
    body = rawBody ? (JSON.parse(rawBody) as Record<string, unknown>) : {};
  } catch {
    body = {};
  }
  // No-data-loss: a paused flow buffers the event (ack 200) instead of running
  // it inline — the sender doesn't retry, the event isn't lost. The non-paused
  // path below is byte-for-byte unchanged.
  if (wf.paused) {
    const r = await buffer.enqueue(spaceId, workflowId, body, { headers });
    if (r.overflow) {
      // Cap reached — hard-stop (never drop the oldest = data loss). Transition-
      // only critical signal; 503 + Retry-After so the sender retries/backs off.
      if (wf.pausedReason !== "buffer-full") {
        await workflows.setPaused(spaceId, workflowId, true, "buffer-full");
        void userLogs.append(spaceId, {
          level: "error",
          source: "run",
          message: `Trigger buffer full: ${wf.name}`,
          detail: "buffer at capacity — flow hard-stopped, new events rejected until drained",
          workflowId,
        });
      }
      return c.json({ error: "buffer_full" }, 503, { "Retry-After": "60" });
    }
    return c.json({ ok: true, buffered: true, entryId: r.entry!.id });
  }

  const run = await runSavedWorkflow(spaceId, wf, body, "webhook");
  return c.json({ ok: true, runId: run.id, status: run.status });
});

// --- Webhook auth config (per workflow) ---
app.get("/api/workflows/:id/webhook-auth", async (c) => {
  return c.json(
    await webhookAuth.getPublic(c.get("spaceId"), c.req.param("id")),
  );
});

app.post("/api/workflows/:id/webhook-auth", async (c) => {
  const body = await c.req.json<{
    type: WebhookAuthType;
    header?: string;
    secret?: string;
  }>();
  await webhookAuth.set(c.get("spaceId"), c.req.param("id"), {
    type: body.type,
    header: body.header,
    secret: body.secret,
  });
  return c.json({ ok: true });
});

app.post("/api/workflows/:id/webhook-auth/test", async (c) => {
  return c.json({ ok: await webhookAuth.selfTest(c.get("spaceId"), c.req.param("id")) });
});

// On-demand "Fix with AI": runs the same deterministic-detect + LLM-bridge
// wiring repair the builder uses at design time, but on the CURRENT (saved or
// hand-edited) workflow. Returns the wires it added so the client can apply them.
app.post("/api/repair-wiring", async (c) => {
  const rl = await llmRateLimit(c);
  if (rl) return rl;
  const spaceId = c.get("spaceId");
  const body = await c.req.json<{
    funcs?: {
      id: string;
      pure: boolean;
      inputs: { name: string; role: string }[];
      outputSchema?: { properties?: Record<string, unknown>; required?: string[] };
    }[];
    wires?: { from: string; fromOutput: string; to: string; toInput: string }[];
    trigger?: { eventFields?: string[] };
  }>();
  const result = await reconcileWiring(
    body.funcs ?? [],
    body.wires ?? [],
    body.trigger?.eventFields ?? [],
    { spaceId },
  );
  return c.json(result);
});

app.post("/api/input-form", async (c) => {
  const rl = await llmRateLimit(c);
  if (rl) return rl;
  const body = await c.req.json<{
    goal?: string;
    fields?: string[];
    fieldHints?: Record<string, string>;
  }>();
  const form = await authorInputForm(
    body.goal ?? "",
    body.fields ?? [],
    body.fieldHints,
    { spaceId: c.get("spaceId") },
  );
  return c.json(form);
});

app.get("/api/settings/llm", async (c) => {
  const spaceId = c.get("spaceId");
  await ensureSpaceLlm(spaceId);
  const cfg = getLlmConfig(spaceId);
  const p = cfg.provider;
  // "configured" = a usable model is actually set: local needs a model name,
  // cloud providers need a key (google can also use the GEMINI env key).
  const configured =
    p === "local" || p === "openai-compatible"
      ? !!cfg.model
      : p === "google"
        ? !!cfg.apiKey || !!process.env.GOOGLE_GENERATIVE_AI_API_KEY
        : !!cfg.apiKey;
  // built-in "MergN" default = our gemini, used when the space has no own config
  const usingOwn = !!getSpaceLlmConfig(spaceId) || (!MANAGED && !!getLlmConfig().apiKey);
  const canSet = await canUseOwnModel(spaceId);
  // why it's locked: 'instance' = the deployment forces its model (hide the
  // picker); 'plan' = a Free space that can pick MergN but must upgrade to bring
  // its own model (show MergN + upgrade hint).
  const lockReason: "instance" | "plan" | null = LLM_SETTINGS_DISABLED
    ? "instance"
    : !canSet
      ? "plan"
      : null;
  return c.json({
    provider: usingOwn ? cfg.provider : "mergn",
    model: usingOwn ? (cfg.model ?? "") : "MergN",
    baseURL: cfg.baseURL ?? "",
    hasApiKey: !!cfg.apiKey,
    configured,
    usingOwn,
    locked: !canSet,
    lockReason,
  });
});

app.post("/api/settings/llm", async (c) => {
  const spaceId = c.get("spaceId");
  if (!(await canUseOwnModel(spaceId)))
    return c.json(
      { error: "llm settings require a Pro plan on this instance" },
      403,
    );
  const body = (await c.req.json()) as Partial<LlmConfig>;
  const provider = String(body.provider ?? "").toLowerCase();
  // empty or the built-in "mergn"/"default" => revert to the built-in MergN model
  if (!provider || provider === "mergn" || provider === "default") {
    if (MANAGED) {
      await settings.clearLlm(spaceId);
      setSpaceLlmConfig(spaceId, null);
    } else {
      await settings.clearLlm("_global");
      setLlmConfig(null);
    }
    return c.json({ ok: true, usingOwn: false });
  }
  const current = MANAGED ? getSpaceLlmConfig(spaceId) : await settings.getLlm();
  const requestedModel =
    body.model === undefined ? undefined : String(body.model).trim() || undefined;
  const resolvedBaseURL = body.baseURL || current?.baseURL || undefined;
  const newApiKey = body.apiKey?.trim() || undefined;
  const resolvedApiKey = newApiKey || current?.apiKey || undefined;
  const creds = { apiKey: resolvedApiKey, baseURL: resolvedBaseURL };

  let keyRejected = false;
  let modelIds: string[] | undefined;

  // 1) API key validation always comes first.
  const keyCheck = await validateApiKey(
    provider,
    newApiKey ? { apiKey: newApiKey, baseURL: resolvedBaseURL } : creds,
  );
  if (!keyCheck.valid) {
    keyRejected = true;
  } else if (keyCheck.ids) {
    modelIds = keyCheck.ids;
  }

  // 2) Model name validation only after the key check passes.
  let modelRejected = false;
  let resolvedModel = requestedModel;
  if (requestedModel && !keyRejected) {
    const check = await validateModelName(provider, requestedModel, creds, modelIds);
    if (!check.valid) {
      modelRejected = true;
      resolvedModel =
        current?.provider === provider ? current?.model || undefined : undefined;
    }
  }

  const cfg: LlmConfig = {
    provider,
    model: resolvedModel,
    baseURL: body.baseURL || undefined,
    // the key is never sent back to the client, so an empty value means
    // "keep the existing one".
    apiKey: keyRejected ? current?.apiKey || undefined : resolvedApiKey,
  };
  if (MANAGED) {
    await settings.setLlm(spaceId, cfg);
    setSpaceLlmConfig(spaceId, cfg);
  } else {
    await settings.setLlm("_global", cfg);
    setLlmConfig(cfg);
  }
  return c.json({
    ok: true,
    usingOwn: true,
    keyRejected,
    modelRejected,
    ...(keyRejected
      ? { error: "Invalid API key" }
      : modelRejected
        ? { error: `Model not found: ${requestedModel}` }
        : {}),
  });
});

// Capability probe for the active model. Detects a model too weak to produce
// the structured (JSON-schema) output the builder needs and flags it so the UI
// can suggest a stronger model. `weak` true => steer the user to upgrade.
app.post("/api/settings/llm/probe", async (c) => {
  const rl = await llmRateLimit(c);
  if (rl) return rl;
  const spaceId = c.get("spaceId");
  await ensureSpaceLlm(spaceId);
  const cfg = getLlmConfig(spaceId);
  const r = await probeModel(spaceId);
  const local = cfg.provider === "local" || cfg.provider === "openai-compatible";
  const weak = !r.structured || !r.accurate;
  return c.json({
    provider: cfg.provider,
    model: cfg.model ?? "",
    local,
    structured: r.structured,
    accurate: r.accurate,
    latencyMs: r.latencyMs,
    error: r.error,
    weak,
  });
});

app.get("/api/logs", async (c) => {
  const limit = Math.min(Number(c.req.query("limit")) || 200, 500);
  return c.json(await userLogs.list(c.get("spaceId"), limit));
});

app.post("/api/logs", async (c) => {
  const body = await c.req.json<{
    level?: string;
    source?: string;
    message?: string;
    detail?: string;
    workflowId?: string;
  }>();
  if (!body.message) return c.json({ error: "message required" }, 400);
  const level = (["error", "warn", "info"].includes(body.level ?? "")
    ? body.level
    : "error") as "error" | "warn" | "info";
  // client-reported logs are always tagged 'client' regardless of claimed source
  const entry = await userLogs.append(c.get("spaceId"), {
    level,
    source: "client",
    message: String(body.message),
    detail: body.detail ? String(body.detail) : undefined,
    workflowId: body.workflowId,
  });
  return c.json(entry);
});

app.delete("/api/logs", async (c) => {
  await userLogs.clear(c.get("spaceId"));
  return c.json({ ok: true });
});

app.post("/api/files", async (c) => {
  const spaceId = c.get("spaceId");
  const body = await c.req.parseBody();
  const f = body.file;
  if (!(f instanceof File))
    return c.json({ error: "multipart field 'file' required" }, 400);
  // Early reject (before buffering the whole file into memory) when the file
  // alone already exceeds the workspace storage limit.
  if (f.size > LIMITS.maxStorageBytes)
    return c.json(
      {
        error: `file too large (max ${Math.floor(LIMITS.maxStorageBytes / 1024 / 1024 / 1024)} GB per workspace)`,
      },
      413,
    );
  const buf = Buffer.from(await f.arrayBuffer());
  try {
    return c.json(
      await fileService.upload(spaceId, { name: f.name, mime: f.type, body: buf }),
    );
  } catch (e) {
    if (e instanceof FileLimitError) return c.json({ error: e.message }, 413);
    throw e;
  }
});

app.get("/api/files", async (c) =>
  c.json(await fileService.list(c.get("spaceId"))),
);

app.get("/api/files/:id", async (c) => {
  const m = await fileService.get(c.get("spaceId"), c.req.param("id"));
  return m ? c.json(m) : c.json({ error: "not found" }, 404);
});

app.get("/api/files/:id/content", async (c) => {
  const spaceId = c.get("spaceId");
  const id = c.req.param("id");
  const meta = await fileService.get(spaceId, id);
  const content = meta ? await fileService.content(spaceId, id) : null;
  if (!meta || !content) return c.json({ error: "not found" }, 404);
  return new Response(new Uint8Array(content), {
    status: 200,
    headers: {
      "Content-Type": meta.mime,
      "Content-Length": String(content.length),
      "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(meta.name)}`,
    },
  });
});

app.delete("/api/files/:id", async (c) => {
  await fileService.remove(c.get("spaceId"), c.req.param("id"));
  return c.json({ ok: true });
});

app.get("/api/runs", async (c) => {
  const workflowId = c.req.query("workflow") || undefined;
  // bound the payload (newest-first); default 200 covers the graph window (60)
  // + the run list (100) with headroom. `?limit=0` opts out (full history).
  const raw = c.req.query("limit");
  const limit = raw === undefined ? 200 : Math.max(0, Number(raw) || 0);
  return c.json(await runs.listRuns(c.get("spaceId"), workflowId, limit));
});

app.get("/api/runs/stream", async (c) => {
  const spaceId = c.get("spaceId");
  const workflowId = c.req.query("workflow");
  if (!workflowId) return c.json({ error: "workflow required" }, 400);
  return streamSSE(c, async (stream) => {
    const off = await onRun(spaceId, workflowId, (event) => {
      void stream.writeSSE({ data: JSON.stringify(event) });
    });
    const ping = setInterval(() => {
      void stream.writeSSE({ data: '{"type":"ping"}' });
    }, 25000);
    await new Promise<void>((resolve) => {
      stream.onAbort(() => {
        off();
        clearInterval(ping);
        resolve();
      });
    });
  });
});

app.get("/api/runs/:id", async (c) => {
  const run = await runs.getRun(c.get("spaceId"), c.req.param("id"));
  return run ? c.json(run) : c.json({ error: "not found" }, 404);
});

// Diagnose a failed run: plain-language cause + a structured fix proposal (diff).
// READ-ONLY — never applies a fix (auto-apply gating is a later milestone). The
// fix proposal is only produced when the space may heal; otherwise notify-only.
app.post("/api/runs/:id/diagnose", async (c) => {
  const spaceId = c.get("spaceId");
  const ctx = await buildDiagnosisContext(
    { getRun: runs.getRun, listRuns: runs.listRuns, getWorkflow: workflows.getWorkflow },
    spaceId,
    c.req.param("id"),
  );
  if (!ctx) return c.json({ error: "run not found or not a failure" }, 404);
  // Diagnosis language (default English — global app). Accepts a locale code or
  // a language name; the UI passes the user's locale.
  const LANGS: Record<string, string> = { en: "English", tr: "Turkish", de: "German", es: "Spanish", fr: "French" };
  const lang = c.req.query("lang");
  const language = lang ? (LANGS[lang.toLowerCase()] ?? lang) : "English";
  const diagnosis = await fixEngine.diagnose(spaceId, ctx, { language });
  return c.json(diagnosis);
});

// ── self-healing fix events (audit + propose/approve flow) ────────────────────
app.get("/api/workflows/:id/heal-events", async (c) => {
  const limit = Math.max(0, Number(c.req.query("limit")) || 50);
  return c.json(await healEvents.listForWorkflow(c.get("spaceId"), c.req.param("id"), limit));
});

// Approve a proposed fix → apply it as a healing version. The proposal is carried
// on the event, so apply is deterministic (no re-diagnosis / second LLM call).
app.post("/api/workflows/:id/fix/:eventId/approve", async (c) => {
  const spaceId = c.get("spaceId");
  const id = c.req.param("id");
  const ev = await healEvents.get(spaceId, c.req.param("eventId"));
  if (!ev || ev.workflowId !== id) return c.json({ error: "fix event not found" }, 404);
  if (ev.status !== "proposed") return c.json({ error: `fix is '${ev.status}', not awaiting approval` }, 409);
  if (!ev.proposal) return c.json({ error: "fix event has no proposal to apply" }, 422);
  const { versionId } = await fixEngine.applyFix(spaceId, id, ev.proposal, { runId: ev.runId, mode: "propose" });
  const updated = await healEvents.update(spaceId, ev.id, {
    status: "applied",
    versionId,
    approvedBy: c.get("userId"),
  });
  void userLogs.append(spaceId, { level: "info", source: "healing", message: `Fix approved & applied: ${ev.diagnosis}`, workflowId: id }).catch(() => {});
  void audit.record(spaceId, { kind: "heal.applied", message: `Fix approved & applied: ${ev.diagnosis}`, workflowId: id, actor: c.get("userId") ?? "user" });
  return c.json(updated);
});

app.post("/api/workflows/:id/fix/:eventId/reject", async (c) => {
  const spaceId = c.get("spaceId");
  const ev = await healEvents.get(spaceId, c.req.param("eventId"));
  if (!ev || ev.workflowId !== c.req.param("id")) return c.json({ error: "fix event not found" }, 404);
  if (ev.status !== "proposed") return c.json({ error: `fix is '${ev.status}', not awaiting approval` }, 409);
  void audit.record(spaceId, { kind: "heal.rejected", message: `Fix rejected: ${ev.diagnosis}`, workflowId: c.req.param("id"), actor: c.get("userId") ?? "user" });
  return c.json(await healEvents.update(spaceId, ev.id, { status: "rejected" }));
});

// ── Per-flow settings, eligibility, governance (kill-switch + audit) ──
app.get("/api/workflows/:id/settings", async (c) => {
  return c.json(await flowSettings.get(c.get("spaceId"), c.req.param("id")));
});

app.put("/api/workflows/:id/settings", async (c) => {
  const spaceId = c.get("spaceId");
  const id = c.req.param("id");
  const body = await c.req.json<Partial<FlowSettings>>().catch(() => ({}) as Partial<FlowSettings>);
  const patch: Partial<FlowSettings> = {};
  if (typeof body.enabled === "boolean") patch.enabled = body.enabled;
  if (body.fixMode === "notify" || body.fixMode === "propose" || body.fixMode === "auto") patch.fixMode = body.fixMode;
  if (typeof body.autoReplay === "boolean") patch.autoReplay = body.autoReplay;
  const next = await flowSettings.set(spaceId, id, patch);
  void audit.record(spaceId, { kind: "settings.changed", message: `Healing settings changed (enabled=${next.enabled}, mode=${next.fixMode}, autoReplay=${next.autoReplay})`, workflowId: id, actor: c.get("userId") ?? "user" });
  return c.json(next);
});

// Why is auto-heal allowed/blocked for this flow? (drives the "why disabled" badge)
app.get("/api/workflows/:id/eligibility", async (c) => {
  const spaceId = c.get("spaceId");
  const allowed = await canHeal(spaceId);
  const killed = await governance.killSwitch();
  const reason = allowed ? undefined : killed ? "kill-switch" : HEAL_DISABLED ? "disabled" : "plan";
  return c.json({ canHeal: allowed, reason });
});

app.get("/api/governance/kill-switch", async (c) =>
  c.json({ on: await governance.killSwitch() }),
);

app.put("/api/governance/kill-switch", async (c) => {
  const { on } = await c.req.json<{ on?: boolean }>().catch(() => ({ on: undefined }));
  if (typeof on !== "boolean") return c.json({ error: "on (boolean) required" }, 400);
  await governance.setKillSwitch(on);
  void audit.record(c.get("spaceId"), { kind: "killswitch.toggled", message: `Global auto-fix kill-switch turned ${on ? "ON" : "OFF"}`, actor: c.get("userId") ?? "user" });
  return c.json({ ok: true, on });
});

app.get("/api/audit", async (c) => {
  const limit = Math.max(0, Number(c.req.query("limit")) || 100);
  return c.json(await audit.list(c.get("spaceId"), { workflowId: c.req.query("workflowId") || undefined, limit }));
});

app.get("/api/spaces", async (c) => {
  const spaces = await membership.listSpaces(c.get("userId"));
  return c.json(spaces.map((s) => ({ id: s.id, name: s.name })));
});

app.post("/api/spaces", async (c) => {
  // One workspace per account when enforcing (every user already gets an
  // auto-provisioned personal space, so this blocks creating a second). The cap
  // lives in src/limits.ts and is "unlimited" for self-host.
  const userId = c.get("userId");
  const existing = await membership.listSpaces(userId);
  if (existing.length >= LIMITS.maxSpacesPerUser)
    return c.json(
      {
        error: "space_limit",
        message: `Your plan allows only ${LIMITS.maxSpacesPerUser} workspace${LIMITS.maxSpacesPerUser === 1 ? "" : "s"}.`,
      },
      403,
    );
  const body = await c.req.json<{ name?: string }>();
  const space = await membership.createSpace(userId, body.name ?? "Workspace");
  await registry.ensureSpace(space.id);
  return c.json({ id: space.id, name: space.name });
});

if (MANAGED) {
  async function assertSpaceOwner(c: Context): Promise<string> {
    const spaceId = c.req.param("id");
    if (!spaceId) throw new HTTPException(400, { message: "bad space id" });
    if (!DISABLE_AUTH && !(await membership.canAccess(c.get("userId"), spaceId)))
      throw new HTTPException(403, { message: "forbidden" });
    return spaceId;
  }

  app.get("/api/spaces/:id/billing/subscription", async (c) => {
    const spaceId = await assertSpaceOwner(c);
    const sub = await billing.getSubscription(spaceId);
    const u = await usage.get(spaceId);
    return c.json({
      ...sub,
      usage: { chats: u.chats, ai_tokens: u.aiTokens },
      billing_enabled: billing.enabled(),
    });
  });

  app.post("/api/spaces/:id/billing/portal", async (c) => {
    const spaceId = await assertSpaceOwner(c);
    if (!billing.enabled())
      return c.json({ error: "billing_not_configured" }, 503);
    try {
      const returnUrl = `${process.env.APP_URL ?? ""}/s/${spaceId}/billing`;
      const url = await billing.createPortalSession(spaceId, returnUrl);
      return c.json({ portal_url: url });
    } catch (e) {
      return c.json(
        { error: e instanceof Error ? e.message : "portal failed" },
        500,
      );
    }
  });

  app.get("/api/spaces/:id/billing/invoices", async (c) => {
    const spaceId = await assertSpaceOwner(c);
    return c.json(await billing.getInvoices(spaceId));
  });

  app.post("/api/billing/webhook", async (c) => {
    const sig = c.req.header("stripe-signature") ?? "";
    const body = await c.req.text();
    try {
      await billing.handleWebhook(body, sig);
      return c.json({ received: true });
    } catch (e) {
      console.error("stripe webhook failed", e);
      return c.json({ error: "webhook failed" }, 400);
    }
  });
}

app.get("/api/connections", async (c) => {
  return c.json(await connections.listConnections(c.get("spaceId")));
});

app.post("/api/connections", async (c) => {
  const body = await c.req.json<{
    provider?: string;
    cred?: Record<string, string>;
    account?: string;
  }>();
  const cred = body.cred ?? {};
  const hasValue = Object.values(cred).some((v) => String(v ?? "").trim());
  if (!body.provider || !hasValue) {
    return c.json({ error: "provider and cred required" }, 400);
  }
  const spaceId = c.get("spaceId");
  await registry.ensureSpace(spaceId);
  const spec = registry.getProvider(spaceId, body.provider);
  const eg = resolveEgressHost(spec?.sandbox, cred);
  if (eg.error) return c.json({ error: eg.error }, 400);
  return c.json(
    await connections.createApiKeyConnection(
      spaceId,
      body.provider,
      cred,
      body.account,
    ),
  );
});

app.patch("/api/connections/:id", async (c) => {
  const body = await c.req.json<{
    account?: string;
    cred?: Record<string, string>;
  }>();
  return c.json(
    await connections.updateConnection(c.get("spaceId"), c.req.param("id"), {
      account: body.account,
      cred: body.cred,
    }),
  );
});

app.delete("/api/connections/:id", async (c) => {
  await connections.deleteConnection(c.get("spaceId"), c.req.param("id"));
  return c.json({ ok: true });
});

app.get("/api/providers/:id/auth", async (c) => {
  const spec = registry.getProvider(c.get("spaceId"), c.req.param("id"));
  if (!spec) return c.json({ error: "provider not found" }, 404);
  return c.json(publicAuth(spec));
});

// Method names each given provider's client exposes — used by the step-code
// editor to autocomplete `ctx.connections.<provider>.<method>()`.
app.post("/api/providers/methods", async (c) => {
  const spaceId = c.get("spaceId");
  const { ids } = await c.req.json<{ ids?: string[] }>();
  const out: Record<string, string[]> = {};
  for (const id of [...new Set(ids ?? [])]) {
    if (typeof id !== "string") continue;
    const spec = registry.getProvider(spaceId, id);
    out[id] = providerMethodNames(spec?.clientSource);
  }
  return c.json(out);
});

app.get("/api/providers/:id/source", async (c) => {
  const spec = registry.getProvider(c.get("spaceId"), c.req.param("id"));
  if (!spec) return c.json({ error: "provider not found" }, 404);
  return c.json({
    clientSource: spec.clientSource ?? "",
    credentialFields: (spec.credential?.fields ?? []).map((f) => ({
      name: f.name,
      label: f.label,
    })),
  });
});

// --- MCP (self-host only) -------------------------------------------------
// LLM-free provider list + registration for the MCP server. Gated: 404 unless
// MCP_ENABLED (off on managed/prod, opt-in on self-host). The client writes the
// provider client code; we just register it — no LLM.
// Remote-MCP bearer tokens (Pro+). Session-authed; the raw token is shown ONCE.
app.post("/api/mcp/tokens", async (c) => {
  const spaceId = c.get("spaceId");
  if (!(await canUseRemoteMcp(spaceId)))
    return c.json({ error: "remote MCP requires a Pro plan" }, 403);
  const body = (await c.req.json().catch(() => ({}))) as { name?: string };
  const { token, meta } = await mcpTokens.create(
    c.get("userId"),
    spaceId,
    body.name ?? "MCP token",
  );
  return c.json({ token, ...meta });
});
app.get("/api/mcp/tokens", async (c) =>
  c.json(await mcpTokens.list(c.get("spaceId"))),
);
app.delete("/api/mcp/tokens/:id", async (c) =>
  c.json({ ok: await mcpTokens.revoke(c.get("spaceId"), c.req.param("id")) }),
);

// /mcp — remote MCP over Streamable HTTP (Web Standard). Auth is a per-user
// bearer token (NOT the app session); NOT under /api so the session middleware
// doesn't touch it. One MCP server/transport per session, keyed by session id.
const mcpSessions = new Map<
  string,
  {
    transport: WebStandardStreamableHTTPServerTransport;
    server: ReturnType<typeof createRemoteMcpServer>;
  }
>();
app.all("/mcp", async (c) => {
  if (!REMOTE_MCP_ENABLED) return c.json({ error: "not found" }, 404);
  const token = (c.req.header("authorization") ?? "").replace(/^Bearer\s+/i, "");
  // Accept either a hand-pasted CLI token (mcp-tokens) or an OAuth access token
  // (mcp-oauth) minted for claude.ai / ChatGPT connectors. Both → {spaceId}.
  const t =
    (await mcpTokens.verify(token)) ?? (await mcpOauth.verifyAccessToken(token));
  if (!t) {
    // Point OAuth-capable clients at our resource metadata so they can discover
    // the authorization server and start the flow (RFC 9728).
    const meta = `${issuerFrom(c.req.url)}/.well-known/oauth-protected-resource`;
    c.header("WWW-Authenticate", `Bearer resource_metadata="${meta}"`);
    return c.json({ error: "unauthorized" }, 401);
  }
  if (!(await canUseRemoteMcp(t.spaceId)))
    return c.json({ error: "remote MCP requires a Pro plan" }, 403);

  const sid = c.req.header("mcp-session-id") ?? undefined;
  let entry = sid ? mcpSessions.get(sid) : undefined;
  // A session id we don't recognise — almost always because the app restarted
  // (deploy / --force-recreate) and wiped the in-memory session map while the
  // client still holds the old id. Per the MCP spec, replying 404 to a request
  // carrying Mcp-Session-Id makes the client re-initialise (a new request with
  // NO session id), which falls into the create branch below. Without this we'd
  // build a fresh transport that rejects the stale id, surfacing to the client
  // as a generic "tool execution" error before any tool handler runs.
  if (sid && !entry) {
    console.error(`[mcp] unknown session ${sid} — asking client to re-initialize`);
    return c.json(
      { jsonrpc: "2.0", error: { code: -32001, message: "Session not found" }, id: null },
      404,
    );
  }
  if (!entry) {
    const server = createRemoteMcpServer(t.spaceId, remoteMcpDeps);
    const transport: WebStandardStreamableHTTPServerTransport =
      new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          mcpSessions.set(id, { transport, server });
        },
      });
    transport.onclose = () => {
      const id = transport.sessionId;
      if (id) mcpSessions.delete(id);
    };
    await server.connect(transport);
    entry = { transport, server };
  }
  return entry.transport.handleRequest(c.req.raw);
});

// --- MCP OAuth 2.1 (for claude.ai / ChatGPT connectors) -------------------
// Lets hosted chat clients connect to /mcp via a standard auth-code + PKCE flow
// (no hand-pasted token). All routes 404 unless remote MCP is enabled. User
// authentication during /authorize reuses the better-auth app session.
app.get("/.well-known/oauth-protected-resource", (c) => {
  if (!REMOTE_MCP_ENABLED) return c.json({ error: "not found" }, 404);
  return c.json(mcpOauth.metadataProtectedResource(issuerFrom(c.req.url)));
});
// Some clients append the resource path segment.
app.get("/.well-known/oauth-protected-resource/mcp", (c) => {
  if (!REMOTE_MCP_ENABLED) return c.json({ error: "not found" }, 404);
  return c.json(mcpOauth.metadataProtectedResource(issuerFrom(c.req.url)));
});
app.get("/.well-known/oauth-authorization-server", (c) => {
  if (!REMOTE_MCP_ENABLED) return c.json({ error: "not found" }, 404);
  return c.json(mcpOauth.metadataAuthorizationServer(issuerFrom(c.req.url)));
});

// Dynamic client registration (RFC 7591) — claude.ai / ChatGPT self-register.
app.post("/register", async (c) => {
  if (!REMOTE_MCP_ENABLED) return c.json({ error: "not found" }, 404);
  try {
    const body = await c.req.json().catch(() => ({}));
    const client = await mcpOauth.registerClient(body);
    return c.json(
      {
        client_id: client.client_id,
        client_name: client.client_name,
        redirect_uris: client.redirect_uris,
        token_endpoint_auth_method: client.token_endpoint_auth_method,
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        client_id_issued_at: Math.floor(new Date(client.created_at).getTime() / 1000),
      },
      201,
    );
  } catch (e) {
    if (e instanceof OAuthError)
      return c.json({ error: e.code, error_description: e.description }, 400);
    return c.json({ error: "server_error" }, 500);
  }
});

// Authorization endpoint. GET renders a consent page (requires app login);
// POST (from that page) issues the code and redirects back to the client.
app.get("/authorize", async (c) => {
  if (!REMOTE_MCP_ENABLED) return c.json({ error: "not found" }, 404);
  const q = Object.fromEntries(new URL(c.req.url).searchParams) as Record<
    string,
    string
  >;
  let prepared;
  try {
    prepared = await mcpOauth.prepareAuthorize(q);
  } catch (e) {
    if (e instanceof OAuthError && e.redirectable && q.redirect_uri) {
      const u = new URL(q.redirect_uri);
      u.searchParams.set("error", e.code);
      u.searchParams.set("error_description", e.description);
      if (q.state) u.searchParams.set("state", q.state);
      return c.redirect(u.toString());
    }
    const msg = e instanceof OAuthError ? e.description : "invalid request";
    return c.html(mcpErrorPage(msg), 400);
  }
  // The user must be signed into MergN in this browser. If not, bounce through
  // the SPA login and come back to this exact URL.
  const user = DISABLE_AUTH ? LOCAL_USER : await getSessionUser(c.req.raw.headers);
  if (!user) {
    const back = new URL(c.req.url);
    const next = back.pathname + back.search;
    return c.redirect(`/?mcpAuthorize=${encodeURIComponent(next)}`);
  }
  // Plan gating is per-space and enforced at POST (the user picks a space). We
  // render the consent page for any signed-in user.
  const spaces = await membership.listSpaces(user.id);
  return c.html(mcpConsentPage(prepared.client.client_name, q, spaces, user.email));
});

app.post("/authorize", async (c) => {
  if (!REMOTE_MCP_ENABLED) return c.json({ error: "not found" }, 404);
  const user = DISABLE_AUTH ? LOCAL_USER : await getSessionUser(c.req.raw.headers);
  if (!user) return c.html(mcpErrorPage("session expired — please sign in again"), 401);
  const form = await c.req.parseBody();
  const q = Object.fromEntries(
    Object.entries(form).map(([k, v]) => [k, String(v)]),
  ) as Record<string, string>;
  let prepared;
  try {
    prepared = await mcpOauth.prepareAuthorize(q);
  } catch (e) {
    const msg = e instanceof OAuthError ? e.description : "invalid request";
    return c.html(mcpErrorPage(msg), 400);
  }
  const redirect = new URL(prepared.req.redirect_uri);
  if (prepared.req.state) redirect.searchParams.set("state", prepared.req.state);
  if (form.deny) {
    redirect.searchParams.set("error", "access_denied");
    return c.redirect(redirect.toString());
  }
  const spaceId = q.space_id || (await membership.ensurePersonalSpace(user)).id;
  if (!DISABLE_AUTH && !(await membership.canAccess(user.id, spaceId)))
    return c.html(mcpErrorPage("you don't have access to that workspace"), 403);
  if (!(await canUseRemoteMcp(spaceId))) {
    redirect.searchParams.set("error", "access_denied");
    redirect.searchParams.set("error_description", "remote MCP requires a Pro plan");
    return c.redirect(redirect.toString());
  }
  const code = await mcpOauth.issueCode(prepared.req, user.id, spaceId);
  redirect.searchParams.set("code", code);
  return c.redirect(redirect.toString());
});

// Token endpoint (public client + PKCE). No auth header; identity is the code.
app.post("/token", async (c) => {
  if (!REMOTE_MCP_ENABLED) return c.json({ error: "not found" }, 404);
  const form = await c.req.parseBody();
  const body = Object.fromEntries(
    Object.entries(form).map(([k, v]) => [k, String(v)]),
  ) as Record<string, string>;
  try {
    const tokens = await mcpOauth.exchangeToken(body);
    c.header("Cache-Control", "no-store");
    return c.json(tokens);
  } catch (e) {
    if (e instanceof OAuthError)
      return c.json({ error: e.code, error_description: e.description }, 400);
    return c.json({ error: "server_error" }, 500);
  }
});

app.get("/api/mcp/providers", async (c) => {
  if (!MCP_ENABLED) return c.json({ error: "mcp disabled" }, 404);
  const spaceId = c.get("spaceId");
  await registry.ensureSpace(spaceId);
  const all = registry.searchProviders(spaceId, "");
  return c.json(
    all.map((p) => {
      const auth = publicAuth(p);
      return {
        id: p.id,
        name: p.name,
        apiDoc: p.apiDoc,
        aiWritten: p.aiWritten ?? false,
        auth: auth.type,
        credentialFields: (auth.fields ?? []).map((f) => f.name),
      };
    }),
  );
});

app.post("/api/mcp/providers", async (c) => {
  if (!MCP_ENABLED) return c.json({ error: "mcp disabled" }, 404);
  const spaceId = c.get("spaceId");
  await registry.ensureSpace(spaceId);
  const b = (await c.req.json()) as Partial<ProviderDraft> & { egressDomain?: string };
  if (!b.id || !b.clientSource)
    return c.json({ error: "id and clientSource are required" }, 400);
  const draft: ProviderDraft = {
    id: b.id,
    name: b.name ?? b.id,
    keywords: b.keywords ?? [],
    authEnv: b.authEnv ?? "",
    sandbox: b.sandbox ?? (b.egressDomain ? { egressDomain: b.egressDomain } : {}),
    apiDoc: b.apiDoc ?? "",
    clientSource: b.clientSource,
    dependencies: b.dependencies ?? [],
    credential: b.credential,
    setupGuide: b.setupGuide,
  };
  registry.registerProviderFromDraft(spaceId, draft);
  await registry.persistProvider(spaceId, draft);
  return c.json({ id: draft.id, name: draft.name, registered: true });
});

app.get("/api/providers/:id/oauth-config", async (c) => {
  return c.json(await oauth.oauthStatus(c.get("spaceId"), c.req.param("id")));
});

app.post("/api/providers/:id/oauth-config", async (c) => {
  const body = await c.req.json<{
    clientId?: string;
    clientSecret?: string;
    authUrl?: string;
    tokenUrl?: string;
    scopes?: string[];
  }>();
  if (!body.clientId || !body.clientSecret)
    return c.json({ error: "clientId and clientSecret required" }, 400);
  await oauth.saveOAuthApp(c.get("spaceId"), c.req.param("id"), {
    clientId: body.clientId,
    clientSecret: body.clientSecret,
    authUrl: body.authUrl,
    tokenUrl: body.tokenUrl,
    scopes: body.scopes,
  });
  return c.json({ ok: true });
});

app.delete("/api/providers/:id/oauth-config", async (c) => {
  await oauth.deleteOAuthApp(c.get("spaceId"), c.req.param("id"));
  return c.json({ ok: true });
});

app.get("/api/oauth/:provider/start", async (c) => {
  try {
    const spaceId = assertSpace(c.req.query("space") || "");
    if (!(await membership.canAccess(c.get("userId"), spaceId)))
      return c.html(oauthResultPage(false, "forbidden"));
    await registry.ensureSpace(spaceId);
    const { url } = await oauth.startOAuth(spaceId, c.req.param("provider"));
    return c.redirect(url);
  } catch (e) {
    return c.html(oauthResultPage(false, e instanceof Error ? e.message : "error"));
  }
});

app.get("/api/oauth/callback", async (c) => {
  const code = c.req.query("code");
  const state = c.req.query("state");
  const error = c.req.query("error_description") ?? c.req.query("error");
  if (error) return c.html(oauthResultPage(false, error));
  if (!code || !state)
    return c.html(oauthResultPage(false, "missing code or state"));
  try {
    const { spaceId, provider, tokens } = await oauth.completeOAuth(state, code);
    await connections.createOAuthConnection(spaceId, provider, {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt,
      scopes: tokens.scopes,
    });
    return c.html(oauthResultPage(true, provider));
  } catch (e) {
    return c.html(oauthResultPage(false, e instanceof Error ? e.message : "error"));
  }
});

app.post("/api/providers/:id/repair", async (c) => {
  const rl = await llmRateLimit(c);
  if (rl) return rl;
  const spaceId = c.get("spaceId");
  const id = c.req.param("id");
  const body = await c.req.json<{ error?: string }>();
  const draft = await registry.getProviderDraft(spaceId, id);
  if (!draft) return c.json({ error: "provider not found" }, 404);
  const { draft: repaired, changeNote } = await repairProvider(
    draft,
    body.error ?? "",
    undefined,
    undefined,
    { spaceId },
  );
  registry.registerProviderFromDraft(spaceId, repaired);
  await registry.persistProvider(spaceId, repaired);
  return c.json({ id: repaired.id, changeNote });
});

const webDir = process.env.WEB_DIR ?? "./web/dist";
if (existsSync(join(process.cwd(), webDir))) {
  app.use("/*", serveStatic({ root: webDir }));
  app.get("/*", serveStatic({ path: join(webDir, "index.html") }));
  console.log(`serving web from ${webDir}`);
}

serve({ fetch: app.fetch, port: Number(process.env.PORT) || 8787 }, (info) => {
  const url = process.env.APP_URL?.trim() || `http://localhost:${info.port}`;
  console.log(`\n  ✔ MergN is running → ${url}\n`);
  void checkForUpdates();
});

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, async () => {
    schedulerConsumer?.stop();
    if (nats) await nats.nc.close();
    await flushTraces();
    process.exit(0);
  });
}
