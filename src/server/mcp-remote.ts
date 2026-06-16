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

const CONVENTIONS = `MergN workflow conventions (build steps to match these):
- A step is an ES module: export default async (ctx, input) => { ... return {...}; }. Read values from input.<field> (this is how ports are derived).
- Effectful steps call ctx.connections.<providerId>.<method>(...). Pass the provider id to add_step.
- Return only outputs a later step or the final action consumes; never echo an input as an output; for a list step return the list, not per-item scalars.
- Webhook events wrap the entity: unwrap with const obj = input.payload?.data?.object ?? input.payload?.object ?? input.payload, then read fields off obj.
- Fixed per-step settings (sheet id, channel, column, threshold) go in add_step's configInputs (kept per step). Flowing data is a normal input.
- Conditional actions: there is no branch node. set_gate an action on an earlier step's decision flag; the engine skips it (and its dependents) when the condition is false. Use for irreversible actions.
- Before running, call validate_workflow; fix wiringErrors/echoedInputs; then run_workflow.`;

export function createRemoteMcpServer(spaceId: string, deps: RemoteMcpDeps): McpServer {
  const server = new McpServer({ name: "mergn", version: "0.1.0" });
  const get = (id: string) => deps.workflows.getWorkflow(spaceId, id);
  const save = (wf: Omit<SavedWorkflow, "createdAt" | "updatedAt">) => deps.workflows.saveWorkflow(spaceId, wf);
  const base = (wf: SavedWorkflow): Omit<SavedWorkflow, "createdAt" | "updatedAt"> => ({
    id: wf.id, name: wf.name, funcs: wf.funcs, wires: wf.wires, positions: wf.positions,
    config: wf.config, nodeConnections: wf.nodeConnections, trigger: wf.trigger,
    inputForm: wf.inputForm, variables: wf.variables,
  });

  server.resource("conventions", "mergn://conventions", async (uri) => ({
    contents: [{ uri: uri.href, text: CONVENTIONS, mimeType: "text/markdown" }],
  }));

  server.tool("list_workflows", "List this space's workflows (id + name).", {}, async () =>
    json((await deps.workflows.listWorkflows(spaceId)).map((w) => ({ id: w.id, name: w.name }))),
  );

  server.tool("get_workflow", "Get a workflow's steps, wires, trigger, gates.", { id: z.string() }, async ({ id }) => {
    const wf = await get(id);
    if (!wf) throw new Error("workflow not found");
    return json({
      id: wf.id, name: wf.name, trigger: wf.trigger,
      steps: (wf.funcs as any[]).map((f) => ({ id: f.id, inputs: (f.inputs ?? []).map((p: any) => `${p.name}${p.role === "config" ? ":config" : ""}`), outputs: outsOf(f), gate: f.gate })),
      wires: (wf.wires as any[]).map((w) => `${w.from}.${w.fromOutput} -> ${w.to}.${w.toInput}`),
    });
  });

  server.tool("create_workflow", "Create an empty workflow. triggerKind: manual|webhook|schedule|poll.",
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

  server.tool("add_step", "Add/replace a step from its code; ports are derived from the code. provider=id for an effectful step; configInputs=fixed settings.",
    { workflowId: z.string(), id: z.string(), code: z.string(), provider: z.string().optional(), configInputs: z.array(z.string()).optional(), arrayInputs: z.array(z.string()).optional() },
    async ({ workflowId, id, code, provider, configInputs, arrayInputs }) => {
      const wf = await get(workflowId);
      if (!wf) throw new Error("workflow not found");
      const used = extractInputs(code);
      const outs = [...new Set(extractOutputs(code))];
      const files = new Set(extractFileInputs(code));
      const cfg = new Set(configInputs ?? []);
      const arr = new Set(arrayInputs ?? []);
      const func = {
        id, title: id, summary: "", version: 1, kind: provider ? "library" : "adapter", pure: !provider,
        inputs: used.map((name) => ({ name, role: cfg.has(name) ? "config" : "input", type: files.has(name) ? "file" : arr.has(name) ? "array" : "string", required: true })),
        outputSchema: { type: "object", properties: Object.fromEntries(outs.map((o) => [o, { type: "string" }])), required: outs },
        bodySource: code, dependencies: [], requires: provider ? [{ name: provider, provider, scopes: [] }] : [],
        dangerClass: provider ? "benign" : null, idempotency: provider ? { key: "runId+funcId", mechanism: "none" } : null,
      };
      const funcs = [...(wf.funcs as any[]).filter((f) => f.id !== id), func];
      const n = funcs.length - 1;
      const positions = { ...wf.positions, [id]: { x: 340 + (n % 4) * 340, y: 60 + Math.floor(n / 4) * 200 } };
      await save({ ...base(wf), funcs, positions });
      return json({ id, inputs: func.inputs.map((p) => `${p.name}:${p.role}`), outputs: outs });
    },
  );

  server.tool("set_wire", "Wire an upstream output to a downstream input (one source per input). from='trigger' for an event field.",
    { workflowId: z.string(), from: z.string(), fromOutput: z.string(), to: z.string(), toInput: z.string() },
    async ({ workflowId, from, fromOutput, to, toInput }) => {
      const wf = await get(workflowId);
      if (!wf) throw new Error("workflow not found");
      const wires = [...(wf.wires as any[]).filter((x) => !(x.to === to && x.toInput === toInput)), { from, fromOutput, to, toInput }];
      await save({ ...base(wf), wires });
      return json({ wired: `${from}.${fromOutput}->${to}.${toInput}` });
    },
  );

  server.tool("set_gate", "Make a step conditional: runs only when an upstream output matches. equals (string) OR truthy (boolean).",
    { workflowId: z.string(), step: z.string(), ref: z.string(), equals: z.string().optional(), truthy: z.boolean().optional() },
    async ({ workflowId, step, ref, equals, truthy }) => {
      const wf = await get(workflowId);
      if (!wf) throw new Error("workflow not found");
      const funcs = (wf.funcs as any[]).map((f) => (f.id === step ? { ...f, gate: { ref, ...(equals !== undefined ? { equals } : {}), ...(truthy !== undefined ? { truthy } : {}) } } : f));
      if (!funcs.some((f) => f.id === step)) throw new Error("step not found");
      await save({ ...base(wf), funcs });
      return json({ step, gate: { ref, equals, truthy } });
    },
  );

  server.tool("validate_workflow", "Check wiringErrors/gateErrors (break the run), echoedInputs (real issue), formFields/configToFill, unusedOutputs (gate-consumed not counted).",
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
      for (const f of funcs) { if (!f.gate?.ref) continue; const [sid, , fld] = String(f.gate.ref).split("."); const sf = byId.get(sid); if (!sf || !outsOf(sf).includes(fld)) gateErrors.push(`'${f.id}' gate ref '${f.gate.ref}' missing output`); if (f.gate.equals === undefined && f.gate.truthy === undefined) gateErrors.push(`'${f.id}' gate has no condition`); }
      const sat = new Set(wires.map((w) => `${w.to} ${w.toInput}`));
      const used = new Set(wires.map((w) => `${w.from} ${w.fromOutput}`));
      for (const f of funcs) { if (f.gate?.ref) { const [sid, , fld] = String(f.gate.ref).split("."); used.add(`${sid} ${fld}`); } }
      const formFields: string[] = [], configToFill: string[] = [];
      for (const f of funcs) for (const p of f.inputs ?? []) { if (sat.has(`${f.id} ${p.name}`) || ef.includes(p.name)) continue; (p.role === "config" ? configToFill : formFields).push(`${f.id}.${p.name}`); }
      const echoedInputs: string[] = [], unusedOutputs: string[] = [];
      for (const f of funcs) { const ins = new Set((f.inputs ?? []).map((p: any) => p.name)); for (const o of outsOf(f)) { if (used.has(`${f.id} ${o}`)) continue; (ins.has(o) ? echoedInputs : unusedOutputs).push(`${f.id}.${o}`); } }
      return json({ ok: wiringErrors.length === 0 && gateErrors.length === 0, wiringErrors, gateErrors, echoedInputs, formFields, configToFill, unusedOutputs });
    },
  );

  server.tool("run_workflow", "Run the workflow once with an optional trigger input; returns each step's status/output.",
    { workflowId: z.string(), input: z.record(z.string(), z.unknown()).optional() },
    async ({ workflowId, input }) => {
      const wf = await get(workflowId);
      if (!wf) throw new Error("workflow not found");
      const r = await deps.runSaved(spaceId, { id: wf.id, name: wf.name, funcs: wf.funcs, wires: wf.wires, config: wf.config, variables: wf.variables }, input ?? {});
      return json(r.records.map((x) => ({ nodeId: x.nodeId, status: x.status, output: x.output, error: x.error })));
    },
  );

  server.tool("list_providers", "List integrations (id, name, apiDoc, auth).", {}, async () => {
    await deps.registry.ensureSpace(spaceId);
    return json(deps.registry.searchProviders(spaceId, "").map((p) => { const a = publicAuth(p); return { id: p.id, name: p.name, apiDoc: p.apiDoc, auth: a.type }; }));
  });

  server.tool("register_provider", "Register a new integration by writing its client (export default (cred, fetch) => ({...})). Declare credential fields the user fills in the app.",
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
