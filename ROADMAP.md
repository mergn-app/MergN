# Workflow Builder — Roadmap

AI-native workflow automation. The AI authors func bodies + schemas on demand
(via tool calls); the engine runs them deterministically. No pre-built
integration nodes like n8n — the code is generated.

## Current state (built)

- **`src/atoms/`** — core model: Func (pure/effectful discriminated union),
  Connection, State (append-only run log), Event, Trigger. Ports with
  literal|ref bindings (no expression language).
- **`src/engine/`** — step-granular engine: Scheduler (reconciling, frontier
  derived from log), Worker (resolve → inject → idempotent execute → append),
  Queue, RunLog, in-memory impls.
- **`src/agent/`** — func-author agent (Vercel AI SDK + Gemini). Produces a
  validated FuncDefinition + human title/summary from an intent.
- **`src/server/`** — Hono server: chat agent (author_func + wire tools),
  workflow CRUD (file store under `data/`), `/api/run` (runs an authored
  workflow through the engine; real Slack via env, others stubbed).
- **`web/`** — Vite + React 19 + shadcn (dark) + React Flow. Chat builder,
  workflows side panel, run panel, custom node cards, FuncDetail modal
  (CodeMirror + Prettier), token usage, TanStack Query.

- **`src/observability.ts`** — Langfuse tracing for the AI layer via OpenTelemetry
  (`@langfuse/otel` + `@opentelemetry/sdk-node`). `trace(functionId, meta)` builds
  `experimental_telemetry` for every AI call (builder-chat, plan-workflow,
  author-step-body, author-func, author-provider, author-input-form,
  repair-provider). `spaceId`→userId, a per-chat `sessionId` groups a whole turn
  (chat + all sub-author calls) into one Langfuse session. No-op unless
  `LANGFUSE_PUBLIC_KEY`/`LANGFUSE_SECRET_KEY` are set; flushed on chat finish +
  SIGTERM/SIGINT. Runtime (RunLog/StepRecord) was already observable.

End to end: describe in chat → nodes appear → save → run → real Slack message.

## Next steps (open)

1. ~~**Provider registry**~~ — DONE. `src/providers/registry.ts` holds typed
   provider specs (id, scopes, apiDoc, env, createClient). `providerDocs()`
   feeds the func-author system prompt so the AI authors against known provider
   APIs and picks the right `provider`. `buildClient(providerId)` builds the
   real client per connection in the run (env creds, stub fallback). Providers:
   Slack (real, SLACK_TOKEN) + HTTP (real, get/post). Engine boundary stays
   provider-agnostic (`ProviderClient` opaque) by design; the registry is the
   typed layer. Add new providers by adding one entry. NEXT: SMTP, Stripe;
   credentials from a vault instead of env (ties to item 5).
   Discovery scales via a `search_providers` tool + AI SDK **dynamic tool
   loading** (`prepareStep` + `activeTools`): each provider is a `provider_<id>`
   tool that is inactive until a search surfaces it, so only the searched
   provider's schema reaches the model — not all of them. (Also migrated
   func-author off deprecated `generateObject` → `generateText` + `Output.object`.)
2. ~~**Streaming run**~~ — DONE. `/api/run` streams per-step records via SSE
   (Hono `streamSSE`); RunPanel reads the stream incrementally and nodes light
   up live (pending = amber pulse → done = green / failed = red). 180ms per-step
   delay so the run is watchable.
3. **Sandbox** — `EvalRuntime` uses `new Function` (runs AI code in-process,
   unsafe for prod). Swap behind the `Runtime` interface for isolated-vm /
   microVM, with a capability broker so the body has no raw tokens / no network
   (all effects via broker). Pure funcs: deny-all network + deterministic.
   Egress guard DONE as a cheap pre-sandbox layer: AI-written provider clients
   get a `fetch` shadowed by `guardedFetch(egressDomain)` (new Function "token",
   "fetch", source), so they can only reach their declared domain (+subdomains);
   any other host throws "egress blocked". Not a hard boundary (globalThis.fetch
   could bypass) — defense-in-depth until the real sandbox.
   PLAN: move to a **kernel-level sandbox per workspace** (microVM/gVisor) — each
   workspace's AI code runs isolated; egress + credentials enforced at the kernel
   boundary, not in-process.
4. **Richer wiring** — wires currently become ref bindings only. Add `dependsOn`
   (ordering-only edges) and type-checking on connect (output schema vs input
   port); offer an AI-authored adapter when types do not match.
8. **Trigger as a first-class node** — Phase 1 DONE. The trigger is no longer a
   virtual source with implicit `trigger.output.<name>` matching (that silently
   failed when AI input names didn't match the user's keys, e.g. amount vs
   amount_cents). Now: a 'trigger' node carries the user's input; func inputs
   bind ONLY via explicit wires (from an upstream func OR from the trigger).
   run.ts dropped the implicit fallback; the agent wires `trigger.<field> →
   step.input` explicitly (system prompt); the canvas renders a Trigger node
   (TriggerNode.tsx) whose fields are derived from the wires drawn from it, with
   edges to the steps. Phase 2: MULTIPLE triggers (a flow can have several entry
   points, n8n-style) — fire one per run, run the reachable subgraph, per-trigger
   input. Unbound-input warning DONE: a func node shows "⚠ unwired: <names>" for
   any required input with no wire and no config value (the orphan/disconnected
   step the AI sometimes leaves); the agent system prompt also now insists every
   required input be wired and no step left disconnected.
5. **Real connections / auth** — API-key path DONE: `Vault` interface
   (`src/store/vault.ts`, DocVault over the store "secrets" collection — swap for
   encrypted/KMS later) + `connections` (DocStore "connections"); a connection
   stores only a `vaultRef`, never the raw key. Run resolves provider secret:
   connection→vault, else env fallback, else stub. UI: NodePanel Connections
   section has a paste-key Connect/disconnect per provider (TanStack Query).
   NEXT: OAuth connect flow (curated apps, redirect + refresh) for big providers;
   encrypt the vault at rest; multi-account selection on the node.
6. **Idempotency + retry in run** — wire the write-ahead + provider-key protocol
   and per-`dangerClass` retry policy into the actual run path.
7. **AI-written providers (workspace-scoped)** — when `search_providers` finds
   nothing, a `create_provider` tool has the AI generate the provider on demand:
   `createClient` code + apiDoc + auth-shape + egress domain (optionally grounded
   by fetching the API's OpenAPI/docs via the http provider). Smoke-test live
   against the real API, then PROMOTE into the registry. Scope: **per user
   workspace** (`data/workspaces/<id>/providers/*.json`), not global — so a bad
   provider's blast radius is one workspace, no cross-tenant review gate needed.
   Why it's worth it (not just convenience): keeps the credential at the
   connection level (capability injection) instead of leaking it into func data
   — generic HTTP can't do that for authed APIs. Requires the sandbox/broker
   (item 3): egress allow-listed to the declared domain, credential injected, so
   an AI-written provider can't exfiltrate the user's own token. Start with
   API-key/bearer services (user pastes a key); OAuth needs a pre-registered app
   (human boundary). Registry becomes layered: hand-written seeds + per-workspace
   AI-written. Product angle: the workspace accumulates integrations on demand.
   REPAIR DONE (reactive): when a run step fails with a provider error, RunPanel
   shows a "repair provider" button → POST /api/providers/:id/repair feeds the
   error + current clientSource to the AI, which fixes it (keeping id + method
   names), re-registers + persists; user re-runs. Verified on the real Stripe
   "Invalid array" bug — the AI added a recursive form-encoder. NEXT (proactive
   smoke test): generate a safe read call per provider, run it on Connect (we
   have the credential then) to verify auth/encoding early, auto-repair on fail;
   eventually auto-repair-and-retry inside a run as an opt-in.

9. **Plan-first workflow construction (design_workflow)** — DONE. Root cause of
   bad/incoherent graphs was the agent building greedily: authoring funcs in
   isolation then wiring as an afterthought → inconsistent field names (amount vs
   amount_cents), missing wires, orphan steps. Fix: a single `design_workflow`
   tool whose input is the COMPLETE plan (`src/agent/workflow-designer.ts`,
   `planZ`): trigger fields + every step with id/title/effectful/provider/intent,
   its inputs (each input's source = fromTrigger field OR fromStep+fromOutput),
   and outputs. The server then builds DETERMINISTICALLY: ensures providers exist
   (creates AI-written ones if missing), authors each step BODY against the
   planned inputs/outputs (authorStepBody), and derives ALL wires from the plan —
   no LLM wiring. Result: coherent DAG, consistent names, no orphans, every input
   sourced. The agent designs (the hard part); wiring is mechanical. author_func/
   wire remain for small edits. Verified: a Stripe→Stripe→Slack build produced a
   fully-wired coherent graph in one call.
   REFINED: the agent kept OMITTING required inputs from the plan (slack missing
   channel; payment missing amount). Fix: inputs are now DERIVED FROM THE BODY,
   not declared in the plan. The plan carries only each step's intent, outputs,
   and deps (inputs from an upstream step). authorStepBody writes the body (it
   knows from the apiDoc the provider needs amount/channel, so it writes
   input.amount/input.channel); the server extracts input.X refs and wires each
   from its dep or from trigger.X by name. The agent can no longer omit an input
   because the BODY decides the input set. Verified: name, amount, channel all
   present and wired.

## Key decisions (so we do not relitigate)

- binding = pure pointer; transformation = an adapter func, not an expression.
- idempotency key = `runId + funcId` (action identity), not input hash.
- step-granular queue; log is truth, queue is the fast path.
- capability injection: body calls `ctx.connections.<name>`, never sees tokens.
- AI is authoring-time only; runtime is frozen + deterministic (enables
  resume/rewind/replay).
- canvas = projection of the model; conform to n8n interaction, diverge on
  architecture.
