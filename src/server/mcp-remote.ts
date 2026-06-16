import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { extractInputs, extractOutputs, extractFileInputs } from "../agent/extract";
import { publicAuth, type Registry } from "../providers/registry";
import type { WorkflowStore, SavedWorkflow } from "./store";

// Deps the remote MCP tools operate on directly (no HTTP round-trip).
export interface RemoteMcpDeps {
  workflows: WorkflowStore;
  registry: Registry;
  registerProvider: (spaceId: string, draft: Record<string, unknown>) => Promise<{ id: string; name: string }>;
  runSaved: (
    spaceId: string,
    wf: { id: string; name: string; funcs: unknown[]; wires: unknown[]; config?: Record<string, Record<string, string>>; variables?: Record<string, unknown> },
    input: Record<string, unknown>,
  ) => Promise<{ records: Array<{ nodeId: string; status: string; output?: unknown; error?: string }> }>;
}

const EVENT_FIELDS: Record<string, string[]> = {
  webhook: ["payload"],
  schedule: ["timestamp"],
  poll: [],
  manual: [],
};
const text = (s: string) => ({ content: [{ type: "text" as const, text: s }] });
const json = (v: unknown) => text(JSON.stringify(v, null, 2));
const outsOf = (f: any) => Object.keys(f?.outputSchema?.properties ?? {});

// Canonical gate ref is `<stepId>.output.<field>` (the engine + validator parse
// index 0 and the LAST segment). Accept fromStep+output, or normalise a
// free-form ref: a 2-part `step.field` is the common mistake and is expanded.
function normalizeGateRef(o: { fromStep?: string; output?: string; ref?: string }): string | null {
  if (o.fromStep && o.output) return `${o.fromStep}.output.${o.output}`;
  const p = (o.ref ?? "").split(".").filter(Boolean);
  if (p.length >= 2) return `${p[0]}.output.${p[p.length - 1]}`;
  return null;
}
// Parse a stored gate ref tolerantly: first segment = step, last = field. Works
// for both `a.output.b` and a loose `a.b`.
const gateParts = (ref: string): { src: string; fld: string } => {
  const p = String(ref).split(".").filter(Boolean);
  return { src: p[0] ?? "", fld: p[p.length - 1] ?? "" };
};

// The runtime ALWAYS calls a step as (ctx, input): ctx first (ctx.connections),
// input second (the wired values + config). Port derivation scans `input.X`
// regardless of position, so reversed args still derive ports but read nothing
// at runtime — the single most expensive mistake. Catch the obvious reversal.
function signatureWarning(code: string): string | undefined {
  const m =
    /export\s+default\s+(?:async\s+)?(?:function\b[^(]*)?\(\s*([^,)]*?)\s*(?:,\s*([^,)]*?)\s*)?\)/.exec(code);
  if (!m) return undefined;
  const a1 = (m[1] ?? "").trim();
  const a2 = (m[2] ?? "").trim();
  if (/^(input|data|args|payload)$/.test(a1) || a2 === "ctx")
    return "Signature looks REVERSED. The runtime calls (ctx, input): ctx is the 1st arg (ctx.connections), input is the 2nd (your values + config). Write (ctx, input) and read every value as input.<field>. Reversed args derive ports but receive nothing at runtime.";
  if (/ctx\.config\b/.test(code))
    return "There is no ctx.config. Config values arrive in input — read them as input.<field> (e.g. input.channelId), same as data.";
  return undefined;
}

const CONVENTIONS = `MergN workflow conventions — follow EXACTLY.

STEP SHAPE & RUNTIME CONTRACT (read this first — it is the #1 source of mistakes):
- A step is: export default async (ctx, input) => { ...; return { ...outputs }; }
- TWO args, in THIS order. ctx is ALWAYS the 1st arg, input is ALWAYS the 2nd. NEVER reverse them, never name them otherwise.
- ctx (1st arg) = { connections, idempotencyKey } and NOTHING else. Call a provider with ctx.connections.<providerId>.<method>(...). There is NO ctx.config, NO ctx.input.
- input (2nd arg) = EVERY value the step receives, keyed by field name — BOTH wired data AND the step's own config (sheet id, channel id, database id, threshold). Read ALL of them as input.<field>: const id = input.databaseId; const rows = input.rows. Config values live in input too — NOT on ctx.
- PORTS are derived statically from your code: one input port per input.<field> you read (or per key of a destructured 2nd param: (ctx, { a, b }) =>). Output ports = the keys of the object you return. If add_step's response shows the wrong inputs/outputs, pass explicit inputs:[...] / outputs:[...] to override.

WIRING / DATA:
- Pass the provider id to add_step for an effectful step.
- Mark fixed per-step settings as add_step configInputs — the user fills them in the app; at runtime you STILL read them as input.<field>.
- Return only outputs a later step or the final action consumes; never echo an input as an output; for a list return the list, not per-item scalars.
- Webhook trigger: input.payload (reserved name) = the ENTIRE trigger body. Read fields off it: const obj = input.payload?.data?.object ?? input.payload?.object ?? input.payload; const name = obj.name.
- TEST INPUT for run_workflow IS the trigger body itself. For a webhook flow pass the raw body directly, e.g. { name, email, budget } — do NOT wrap it as { payload: {...} }. Wrapping double-nests it (input.payload becomes { payload: {...} }). A real webhook delivers the bare body, so test with the bare body too.

PROVIDERS:
- Need a service not in list_providers (email, a SaaS API)? register_provider one with credentialFields — this is the normal way to add an integration. NEVER use the generic 'http' provider for an AUTHENTICATED service: 'http' has no credential storage, so the key has nowhere to go and the step can't auth. 'http' is for public, auth-less URLs only. For email, register e.g. a 'resend' provider with an apiKey field.

GATES (conditional steps):
- No branch node. set_gate with step + fromStep + output (+ equals OR truthy). Ref is <fromStep>.output.<field>; the gated step (and its dependents) is skipped when false. Cleanest pattern: a decision step returns { allowed: true/false }, then set_gate truthy:true.

WORKFLOW:
- Re-adding a step with add_step KEEPS its gate and wires (no need to re-wire after editing code, unless you renamed ports).
- Before running: validate_workflow; fix wiringErrors/gateErrors and echoedInputs. configToFill/formFields are user-filled, not blockers. Then run_workflow — effectful steps fail until the user connects each provider's credential in the app (this is expected in a test run).`;

export function createRemoteMcpServer(spaceId: string, deps: RemoteMcpDeps): McpServer {
  const server = new McpServer({ name: "mergn", version: "0.1.0" });
  const get = (id: string) => deps.workflows.getWorkflow(spaceId, id);
  const save = (wf: Omit<SavedWorkflow, "createdAt" | "updatedAt">) => deps.workflows.saveWorkflow(spaceId, wf);
  const base = (wf: SavedWorkflow): Omit<SavedWorkflow, "createdAt" | "updatedAt"> => ({
    id: wf.id, name: wf.name, funcs: wf.funcs, wires: wf.wires, positions: wf.positions,
    config: wf.config, nodeConnections: wf.nodeConnections, trigger: wf.trigger,
    inputForm: wf.inputForm, variables: wf.variables,
  });

  // Wrap every tool so a thrown error (otherwise swallowed by the SDK and shown
  // to the client as a generic "tool execution" error) is logged here with the
  // tool name, args and stack — then re-thrown so client behaviour is unchanged.
  const tool = (
    name: string,
    description: string,
    schema: Record<string, unknown>,
    handler: (a: any) => Promise<any>,
  ) =>
    (server.tool as any)(name, description, schema, async (a: any) => {
      console.error(
        `[mcp:${name}] call space=${spaceId} args=${JSON.stringify(a ?? {}).slice(0, 400)}`,
      );
      try {
        return await handler(a);
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        console.error(`[mcp:${name}] FAILED space=${spaceId}:`, err.stack ?? err.message);
        throw err;
      }
    });

  server.resource("conventions", "mergn://conventions", async (uri) => ({
    contents: [{ uri: uri.href, text: CONVENTIONS, mimeType: "text/markdown" }],
  }));

  tool("list_workflows", "List this space's workflows (id + name).", {}, async () =>
    json((await deps.workflows.listWorkflows(spaceId)).map((w) => ({ id: w.id, name: w.name }))),
  );

  tool("get_workflow", "Get a workflow's steps, wires, trigger, gates.", { id: z.string() }, async ({ id }) => {
    const wf = await get(id);
    if (!wf) throw new Error("workflow not found");
    return json({
      id: wf.id, name: wf.name, trigger: wf.trigger,
      steps: (wf.funcs as any[]).map((f) => ({ id: f.id, inputs: (f.inputs ?? []).map((p: any) => `${p.name}${p.role === "config" ? ":config" : ""}`), outputs: outsOf(f), gate: f.gate })),
      wires: (wf.wires as any[]).map((w) => `${w.from}.${w.fromOutput} -> ${w.to}.${w.toInput}`),
    });
  });

  tool("create_workflow", "Create an empty workflow. triggerKind: manual|webhook|schedule|poll.",
    { name: z.string(), triggerKind: z.enum(["manual", "webhook", "schedule", "poll"]).default("manual") },
    async ({ name, triggerKind }) => {
      const id = randomUUID();
      const ef = EVENT_FIELDS[triggerKind] ?? [];
      const trigger: any = { kind: triggerKind };
      if (ef.length) trigger.eventFields = ef;
      await save({ id, name, funcs: [], wires: [], positions: { trigger: { x: 0, y: 180 } }, config: {}, trigger });
      return json({ id, name, triggerKind, eventFields: ef });
    },
  );

  tool("add_step", "Add/replace a step. Ports are derived from the code (reads of input.<field>, or a destructured 2nd param). Override with explicit inputs/outputs if derivation is wrong. provider=id for an effectful step; configInputs=fixed settings. Re-adding a step KEEPS its existing gate and wires.",
    { workflowId: z.string(), id: z.string(), code: z.string(), provider: z.string().optional(), configInputs: z.array(z.string()).optional(), arrayInputs: z.array(z.string()).optional(), inputs: z.array(z.string()).optional(), outputs: z.array(z.string()).optional() },
    async ({ workflowId, id, code, provider, configInputs, arrayInputs, inputs, outputs }) => {
      const wf = await get(workflowId);
      if (!wf) throw new Error("workflow not found");
      // Explicit inputs/outputs win over static derivation — the escape hatch
      // when a signature the parser can't read (e.g. nested destructuring) would
      // otherwise yield zero ports.
      const used: string[] = inputs && inputs.length ? inputs : extractInputs(code);
      const outs: string[] = [...new Set<string>(outputs && outputs.length ? outputs : extractOutputs(code))];
      const files = new Set(extractFileInputs(code));
      const cfg = new Set(configInputs ?? []);
      const arr = new Set(arrayInputs ?? []);
      // Preserve the existing step's gate when replacing it, so iterating on a
      // step's code doesn't silently drop a conditional set earlier. Wires live
      // in wf.wires (untouched here) and survive as long as the port names match.
      const prev = (wf.funcs as any[]).find((f) => f.id === id);
      const func = {
        id, title: id, summary: "", version: 1, kind: provider ? "library" : "adapter", pure: !provider,
        inputs: used.map((name) => ({ name, role: cfg.has(name) ? "config" : "input", type: files.has(name) ? "file" : arr.has(name) ? "array" : "string", required: true })),
        outputSchema: { type: "object", properties: Object.fromEntries(outs.map((o) => [o, { type: "string" }])), required: outs },
        bodySource: code, dependencies: [], requires: provider ? [{ name: provider, provider, scopes: [] }] : [],
        dangerClass: provider ? "benign" : null, idempotency: provider ? { key: "runId+funcId", mechanism: "none" } : null,
        ...(prev?.gate ? { gate: prev.gate } : {}),
      };
      const funcs = [...(wf.funcs as any[]).filter((f) => f.id !== id), func];
      const n = funcs.length - 1;
      const positions = { ...wf.positions, [id]: prev ? wf.positions?.[id] ?? { x: 340 + (n % 4) * 340, y: 60 + Math.floor(n / 4) * 200 } : { x: 340 + (n % 4) * 340, y: 60 + Math.floor(n / 4) * 200 } };
      await save({ ...base(wf), funcs, positions });
      const warn = signatureWarning(code);
      return json({ id, inputs: func.inputs.map((p: { name: string; role: string }) => `${p.name}:${p.role}`), outputs: outs, gateKept: !!prev?.gate, ...(warn ? { warning: warn } : {}), ...(func.inputs.length === 0 ? { note: "0 input ports derived — read values as input.<field> (or destructure the 2nd param), or pass explicit inputs:[...]" } : {}) });
    },
  );

  tool("set_wire", "Wire an upstream output to a downstream input (one source per input). from='trigger' for an event field.",
    { workflowId: z.string(), from: z.string(), fromOutput: z.string(), to: z.string(), toInput: z.string() },
    async ({ workflowId, from, fromOutput, to, toInput }) => {
      const wf = await get(workflowId);
      if (!wf) throw new Error("workflow not found");
      const wires = [...(wf.wires as any[]).filter((x) => !(x.to === to && x.toInput === toInput)), { from, fromOutput, to, toInput }];
      await save({ ...base(wf), wires });
      return json({ wired: `${from}.${fromOutput}->${to}.${toInput}` });
    },
  );

  tool("set_gate", "Make 'step' conditional: it (and its dependents) run only when an upstream step's output matches. Give fromStep + output (preferred) — the ref is built as <fromStep>.output.<field>. equals (string) OR truthy (boolean) is the condition.",
    { workflowId: z.string(), step: z.string(), fromStep: z.string().optional(), output: z.string().optional(), ref: z.string().optional(), equals: z.string().optional(), truthy: z.boolean().optional() },
    async ({ workflowId, step, fromStep, output, ref, equals, truthy }) => {
      const wf = await get(workflowId);
      if (!wf) throw new Error("workflow not found");
      // Canonical gate ref is `<stepId>.output.<field>` (engine + validator parse
      // it that way). Build it from fromStep+output, or normalise a free-form ref
      // — a 2-part `step.field` is auto-expanded so the common mistake just works.
      const fullRef = normalizeGateRef({ fromStep, output, ref });
      if (!fullRef) throw new Error("provide fromStep + output (or a ref like '<fromStep>.output.<field>')");
      if (equals === undefined && truthy === undefined)
        throw new Error("provide a condition: equals (string) or truthy (boolean)");
      const byId = new Map((wf.funcs as any[]).map((f) => [f.id, f]));
      if (!byId.has(step)) throw new Error(`step '${step}' not found`);
      const [src, , fld] = fullRef.split(".");
      const sf = byId.get(src);
      if (!sf) throw new Error(`gate source step '${src}' not found`);
      if (!outsOf(sf).includes(fld)) throw new Error(`step '${src}' has no output '${fld}' (it outputs: ${outsOf(sf).join(", ") || "none"})`);
      const funcs = (wf.funcs as any[]).map((f) => (f.id === step ? { ...f, gate: { ref: fullRef, ...(equals !== undefined ? { equals } : {}), ...(truthy !== undefined ? { truthy } : {}) } } : f));
      await save({ ...base(wf), funcs });
      return json({ step, gate: { ref: fullRef, equals, truthy } });
    },
  );

  tool("validate_workflow", "Check wiringErrors/gateErrors (break the run), echoedInputs (real issue), formFields/configToFill, unusedOutputs (gate-consumed not counted).",
    { id: z.string() },
    async ({ id }) => {
      const wf = await get(id);
      if (!wf) throw new Error("workflow not found");
      const funcs = wf.funcs as any[]; const wires = wf.wires as any[];
      const ef = (wf.trigger as any)?.eventFields ?? (wf.trigger?.kind === "webhook" ? ["payload"] : wf.trigger?.kind === "schedule" ? ["timestamp"] : []);
      const byId = new Map(funcs.map((f) => [f.id, f]));
      const hasIn = (f: any, n: string) => (f.inputs ?? []).some((p: any) => p.name === n);
      const wiringErrors: string[] = [], gateErrors: string[] = [];
      for (const w of wires) {
        if (!byId.has(w.to)) { wiringErrors.push(`wire to unknown step '${w.to}'`); continue; }
        if (!hasIn(byId.get(w.to), w.toInput)) wiringErrors.push(`'${w.to}' has no input '${w.toInput}'`);
        if (w.from === "trigger") { if (w.fromOutput && !ef.includes(w.fromOutput)) wiringErrors.push(`trigger has no event field '${w.fromOutput}'`); }
        else { const sf = byId.get(w.from); if (!sf) wiringErrors.push(`wire from unknown step '${w.from}'`); else if (w.fromOutput && !outsOf(sf).includes(w.fromOutput)) wiringErrors.push(`'${w.from}' has no output '${w.fromOutput}'`); }
      }
      for (const f of funcs) { if (!f.gate?.ref) continue; const { src, fld } = gateParts(f.gate.ref); const sf = byId.get(src); if (!sf) gateErrors.push(`'${f.id}' gate references unknown step '${src}' (ref '${f.gate.ref}'; expected <stepId>.output.<field>)`); else if (!outsOf(sf).includes(fld)) gateErrors.push(`'${f.id}' gate output '${fld}' not produced by '${src}' (it outputs: ${outsOf(sf).join(", ") || "none"})`); if (f.gate.equals === undefined && f.gate.truthy === undefined) gateErrors.push(`'${f.id}' gate has no condition (equals or truthy)`); }
      const sat = new Set(wires.map((w) => `${w.to} ${w.toInput}`));
      const used = new Set(wires.map((w) => `${w.from} ${w.fromOutput}`));
      for (const f of funcs) { if (f.gate?.ref) { const { src, fld } = gateParts(f.gate.ref); used.add(`${src} ${fld}`); } }
      const formFields: string[] = [], configToFill: string[] = [];
      for (const f of funcs) for (const p of f.inputs ?? []) { if (sat.has(`${f.id} ${p.name}`) || ef.includes(p.name)) continue; (p.role === "config" ? configToFill : formFields).push(`${f.id}.${p.name}`); }
      const echoedInputs: string[] = [], unusedOutputs: string[] = [];
      for (const f of funcs) { const ins = new Set((f.inputs ?? []).map((p: any) => p.name)); for (const o of outsOf(f)) { if (used.has(`${f.id} ${o}`)) continue; (ins.has(o) ? echoedInputs : unusedOutputs).push(`${f.id}.${o}`); } }
      return json({ ok: wiringErrors.length === 0 && gateErrors.length === 0, wiringErrors, gateErrors, echoedInputs, formFields, configToFill, unusedOutputs });
    },
  );

  tool("run_workflow", "Run the workflow once. 'input' IS the trigger body itself — for a webhook flow pass the raw body directly (e.g. { name, email, budget }), NOT wrapped as { payload: {...} } (a step's input.payload already = this whole object; wrapping double-nests it). Returns each step's status/output. A step calling an unconnected provider fails until its credential is added in the app.",
    { workflowId: z.string(), input: z.record(z.string(), z.unknown()).optional() },
    async ({ workflowId, input }) => {
      const wf = await get(workflowId);
      if (!wf) throw new Error("workflow not found");
      const r = await deps.runSaved(spaceId, { id: wf.id, name: wf.name, funcs: wf.funcs, wires: wf.wires, config: wf.config, variables: wf.variables }, input ?? {});
      const steps = r.records.map((x) => {
        // A common test-run failure is calling a provider the user hasn't
        // connected yet (ctx.connections.<id> is undefined). Flag it so it isn't
        // mistaken for a code bug.
        const hint =
          x.status === "failed" && /connections?\.[a-z0-9_]+|is not a function|undefined/i.test(String(x.error ?? ""))
            ? "this step may call a provider that isn't connected yet — add its credential in the app, then retry"
            : undefined;
        return { nodeId: x.nodeId, status: x.status, output: x.output, error: x.error, ...(hint ? { hint } : {}) };
      });
      // Detect the common double-wrap: input passed as { payload: {...} } when it
      // should be the bare body (a step's input.payload already = the whole body).
      const inObj = (input ?? {}) as Record<string, unknown>;
      const doubleWrapped =
        Object.keys(inObj).length === 1 &&
        "payload" in inObj &&
        typeof inObj.payload === "object";
      return json(doubleWrapped ? { warning: "input looks double-wrapped — you passed { payload: {...} }; pass the bare body instead (input.payload already = the whole body you pass).", steps } : steps);
    },
  );

  tool("list_providers", "List integrations the space has (id, name, apiDoc, auth). 'http' is a generic AUTH-LESS client for public URLs only — for any authenticated service not listed here, register_provider a new one instead of using http.", {}, async () => {
    await deps.registry.ensureSpace(spaceId);
    return json(deps.registry.searchProviders(spaceId, "").map((p) => { const a = publicAuth(p); return { id: p.id, name: p.name, apiDoc: p.apiDoc, auth: a.type }; }));
  });

  tool("register_provider", "Author a new integration whenever a step needs a service not in list_providers (email/Resend, a SaaS API, etc.) — this is the normal way to add integrations, not a fallback. Write its client (export default (cred, fetch) => ({...}); read keys from cred.<field>) and declare credentialFields so the user enters their key/token in the app. Set egressDomain to the API host.",
    { id: z.string(), name: z.string().optional(), apiDoc: z.string(), clientSource: z.string(), egressDomain: z.string().optional(),
      credentialFields: z.array(z.object({ name: z.string(), label: z.string(), type: z.enum(["text", "password", "number"]).default("password"), required: z.boolean().default(true) })).optional() },
    async ({ id, name, apiDoc, clientSource, egressDomain, credentialFields }) => {
      const r = await deps.registerProvider(spaceId, {
        id, name: name ?? id, keywords: [], authEnv: `${id.toUpperCase()}_TOKEN`,
        sandbox: egressDomain ? { egressDomain } : {}, apiDoc, clientSource, dependencies: [],
        credential: credentialFields?.length ? { fields: credentialFields } : undefined,
      });
      return json({ ...r, registered: true });
    },
  );

  return server;
}
