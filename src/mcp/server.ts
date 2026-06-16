// Self-host-only MCP server: lets Claude Code (or any MCP client) build and run
// workflows in a LOCAL Flowbaker instance using the user's OWN model. It exposes
// LLM-FREE primitives — the client writes the step code and decides the graph;
// this server only derives ports deterministically, persists, and runs. It NEVER
// calls our LLM. Talks to the local app over REST (no direct Mongo).
//
// Refuses to run against a managed/prod instance. Run locally with:
//   APP_URL=http://localhost:8787 node --import tsx src/mcp/server.ts
// then: claude mcp add flowbaker -- node --import tsx src/mcp/server.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { extractInputs, extractOutputs, extractFileInputs } from "../agent/extract";

const APP_URL = process.env.APP_URL ?? "http://localhost:8787";
let SPACE_ID = process.env.SPACE_ID ?? "";

function headers(): Record<string, string> {
  return { "Content-Type": "application/json", "x-space-id": SPACE_ID };
}
async function api(path: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(APP_URL + path, { ...init, headers: { ...headers(), ...(init?.headers ?? {}) } });
  if (!res.ok) throw new Error(`${init?.method ?? "GET"} ${path} -> ${res.status} ${await res.text()}`);
  const ct = res.headers.get("content-type") ?? "";
  return ct.includes("json") ? res.json() : res.text();
}
const text = (s: string) => ({ content: [{ type: "text" as const, text: s }] });
const json = (v: unknown) => text(JSON.stringify(v, null, 2));

interface WF {
  id?: string;
  name: string;
  funcs: any[];
  wires: any[];
  positions?: Record<string, { x: number; y: number }>;
  config?: Record<string, Record<string, string>>;
  nodeConnections?: Record<string, Record<string, string>>;
  trigger: { kind: string; [k: string]: unknown };
  inputForm?: unknown;
  variables?: Record<string, unknown>;
}
async function getWF(id: string): Promise<WF> {
  return (await api(`/api/workflows/${id}`)) as WF;
}
async function putWF(id: string, wf: WF): Promise<void> {
  await api(`/api/workflows/${id}`, { method: "PUT", body: JSON.stringify({ ...wf, conversationId: undefined }) });
}

const EVENT_FIELDS: Record<string, string[]> = {
  webhook: ["payload"],
  schedule: ["timestamp"],
  poll: [],
  manual: [],
};

const CONVENTIONS = `FLOWBAKER STEP CONVENTIONS (write step code to match these)
- A step body is an ES module: \`export default async (ctx, input) => { ... return {...}; }\`.
- Read every value from \`input.<field>\` (this is how the server derives the step's input ports — declare nothing else).
- Effectful steps call services via \`ctx.connections.<providerId>.<method>(...)\` — never touch raw tokens. Pass the provider id to add_step.
- Return an object with ONLY the fields a later step or the final action consumes. Do NOT echo an input back as an output. For a list/batch step, return the list as one output, not per-item scalar fields.
- WEBHOOK trigger: the whole event arrives as \`input.payload\`. Events usually WRAP the entity in an envelope — unwrap first: \`const obj = input.payload?.data?.object ?? input.payload?.data ?? input.payload?.object ?? input.payload;\` then read fields off \`obj\`.
- SETTINGS vs DATA: a fixed per-step setting (spreadsheet id, sheet/column name, channel id, board/project/audience id, api/webhook url, threshold) should be passed in add_step's \`configInputs\` so it becomes a per-step config field (kept per step, never colliding). Flowing data (from the trigger or an upstream step) is a normal input.
- A trigger event field (webhook: "payload", schedule: "timestamp") is wired to the trigger automatically when an input has that name. Other unwired inputs become user-filled form fields unless you wire them from an upstream step with set_wire.
- CONDITIONAL actions: there is no branch node. To run a step only sometimes, have an earlier step output a flag and call set_gate on the action (the engine skips the step and its dependents when the gate is false). Use for irreversible actions (refunds, creating records).
- PROVIDERS: call list_providers to see existing integrations and their apiDoc. If the one you need is missing, register_provider with a client you write (export default (cred, fetch) => ({...})), then use its id in add_step. Tell the user to connect it (request_connection) in the app's Connections panel — secrets are entered there, never here.
- Before running, call validate_workflow to catch wiring errors, unfilled inputs, and bad gates; fix them, then run_workflow.`;

async function main() {
  // hard gate: self-host only, and only when the instance opted in (ENABLE_MCP)
  try {
    const cfg = (await api("/api/config")) as { managed?: boolean; mcpEnabled?: boolean };
    if (cfg.managed || !cfg.mcpEnabled) {
      console.error(
        "Flowbaker MCP is disabled on this instance. It is self-host only — set ENABLE_MCP=1 (and not MANAGED) on the app.",
      );
      process.exit(1);
    }
  } catch (e) {
    console.error(`Cannot reach Flowbaker app at ${APP_URL}: ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  }
  if (!SPACE_ID) {
    const spaces = (await api("/api/spaces")) as Array<{ id: string }>;
    if (!spaces.length) {
      console.error("No space found. Create one in the app first.");
      process.exit(1);
    }
    SPACE_ID = spaces[0].id;
  }

  const server = new McpServer({ name: "flowbaker", version: "0.1.0" });

  server.resource("conventions", "flowbaker://conventions", async (uri) => ({
    contents: [{ uri: uri.href, text: CONVENTIONS, mimeType: "text/markdown" }],
  }));

  server.tool("list_workflows", "List saved workflows (id + name).", {}, async () => {
    const list = (await api("/api/workflows")) as Array<{ id: string; name: string }>;
    return json(list.map((w) => ({ id: w.id, name: w.name })));
  });

  server.tool(
    "get_workflow",
    "Get a workflow's full graph: steps (id, inputs, outputs, gate), wires, trigger.",
    { id: z.string() },
    async ({ id }) => {
      const wf = await getWF(id);
      return json({
        id,
        name: wf.name,
        trigger: wf.trigger,
        steps: (wf.funcs ?? []).map((f: any) => ({
          id: f.id,
          inputs: (f.inputs ?? []).map((p: any) => `${p.name}${p.role === "config" ? ":config" : ""}`),
          outputs: Object.keys(f.outputSchema?.properties ?? {}),
          gate: f.gate,
        })),
        wires: (wf.wires ?? []).map((w: any) => `${w.from}.${w.fromOutput} -> ${w.to}.${w.toInput}`),
      });
    },
  );

  server.tool(
    "create_workflow",
    "Create an empty workflow. triggerKind: manual | webhook | schedule | poll. Returns its id.",
    {
      name: z.string(),
      triggerKind: z.enum(["manual", "webhook", "schedule", "poll"]).default("manual"),
    },
    async ({ name, triggerKind }) => {
      const id = randomUUID();
      const trigger: WF["trigger"] = { kind: triggerKind };
      const ef = EVENT_FIELDS[triggerKind] ?? [];
      if (ef.length) (trigger as any).eventFields = ef;
      await putWF(id, { id, name, funcs: [], wires: [], trigger, positions: { trigger: { x: 0, y: 180 } } });
      return json({ id, name, triggerKind, eventFields: ef });
    },
  );

  server.tool(
    "add_step",
    "Add (or replace) a step from its code. The server derives input/output ports from the code. Pass `provider` for an effectful step (it calls ctx.connections.<provider>). Pass `configInputs` for inputs that are fixed per-step settings (sheet id, channel...).",
    {
      workflowId: z.string(),
      id: z.string().describe("snake_case step id"),
      code: z.string().describe("ES module: export default async (ctx, input) => { ... return {...} }"),
      provider: z.string().optional().describe("provider id for an effectful step"),
      configInputs: z.array(z.string()).optional().describe("input names that are fixed per-step settings"),
      arrayInputs: z.array(z.string()).optional().describe("input names read as a list/array"),
    },
    async ({ workflowId, id, code, provider, configInputs, arrayInputs }) => {
      const wf = await getWF(workflowId);
      const used = extractInputs(code);
      const outs = [...new Set(extractOutputs(code))];
      const files = new Set(extractFileInputs(code));
      const cfg = new Set(configInputs ?? []);
      const arr = new Set(arrayInputs ?? []);
      const func = {
        id,
        title: id,
        summary: "",
        version: 1,
        kind: provider ? "library" : "adapter",
        pure: !provider,
        inputs: used.map((name) => ({
          name,
          role: cfg.has(name) ? "config" : "input",
          type: files.has(name) ? "file" : arr.has(name) ? "array" : "string",
          required: true,
        })),
        outputSchema: {
          type: "object",
          properties: Object.fromEntries(outs.map((o) => [o, { type: "string" }])),
          required: outs,
        },
        bodySource: code,
        dependencies: [],
        requires: provider ? [{ name: provider, provider, scopes: [] }] : [],
        dangerClass: provider ? "benign" : null,
        idempotency: provider ? { key: "runId+funcId", mechanism: "none" } : null,
      };
      wf.funcs = [...(wf.funcs ?? []).filter((f: any) => f.id !== id), func];
      const n = wf.funcs.length - 1;
      wf.positions = { ...(wf.positions ?? {}), [id]: { x: 340 + (n % 4) * 340, y: 60 + Math.floor(n / 4) * 200 } };
      await putWF(workflowId, wf);
      return json({
        id,
        inputs: func.inputs.map((p) => `${p.name}:${p.role}`),
        outputs: outs,
        note: "ports derived from code. Wire flowing inputs with set_wire; config/form inputs are filled in the app.",
      });
    },
  );

  server.tool(
    "set_wire",
    "Wire an upstream output to a downstream step input. Use from='trigger' for an event field (e.g. payload).",
    {
      workflowId: z.string(),
      from: z.string(),
      fromOutput: z.string(),
      to: z.string(),
      toInput: z.string(),
    },
    async ({ workflowId, from, fromOutput, to, toInput }) => {
      const wf = await getWF(workflowId);
      const w = { from, fromOutput, to, toInput };
      // an input takes ONE source — replace any existing wire into (to, toInput)
      wf.wires = [...(wf.wires ?? []).filter((x: any) => !(x.to === to && x.toInput === toInput)), w];
      await putWF(workflowId, wf);
      return json({ wired: `${from}.${fromOutput}->${to}.${toInput}` });
    },
  );

  server.tool(
    "set_gate",
    "Make a step CONDITIONAL: it runs only when an upstream output matches. The engine skips the step and its dependents when the condition is false. Provide equals (string) OR truthy (boolean).",
    {
      workflowId: z.string(),
      step: z.string(),
      ref: z.string().describe("upstream output as 'stepId.output.field'"),
      equals: z.string().optional(),
      truthy: z.boolean().optional(),
    },
    async ({ workflowId, step, ref, equals, truthy }) => {
      const wf = await getWF(workflowId);
      const f = (wf.funcs ?? []).find((x: any) => x.id === step);
      if (!f) throw new Error(`step not found: ${step}`);
      f.gate = { ref, ...(equals !== undefined ? { equals } : {}), ...(truthy !== undefined ? { truthy } : {}) };
      await putWF(workflowId, wf);
      return json({ step, gate: f.gate });
    },
  );

  server.tool(
    "list_providers",
    "List available providers (integrations). Use an id as add_step's `provider`, and call its methods via ctx.connections.<id>.<method>(...) per its apiDoc.",
    {},
    async () => json(await api("/api/mcp/providers")),
  );

  server.tool(
    "register_provider",
    "Register a NEW provider by writing its client yourself: `export default (cred, fetch) => ({ method: async (...) => {...} })`. Steps then call ctx.connections.<id>.method(...). Read secrets from cred.<field>; declare those fields in credentialFields (the user fills them in the app — never here).",
    {
      id: z.string(),
      name: z.string().optional(),
      apiDoc: z.string().describe("one line on how a step calls it, e.g. 'postMessage(channel, text)'"),
      clientSource: z.string().describe("export default (cred, fetch) => ({ ... })"),
      keywords: z.array(z.string()).optional(),
      egressDomain: z.string().optional().describe("the API host it may call, e.g. api.slack.com"),
      credentialFields: z
        .array(
          z.object({
            name: z.string(),
            label: z.string(),
            type: z.enum(["text", "password", "number"]).default("password"),
            required: z.boolean().default(true),
          }),
        )
        .optional(),
    },
    async ({ id, name, apiDoc, clientSource, keywords, egressDomain, credentialFields }) =>
      json(
        await api("/api/mcp/providers", {
          method: "POST",
          body: JSON.stringify({
            id,
            name,
            apiDoc,
            clientSource,
            keywords,
            egressDomain,
            authEnv: `${id.toUpperCase()}_TOKEN`,
            credential: credentialFields?.length ? { fields: credentialFields } : undefined,
          }),
        }),
      ),
  );

  server.tool(
    "request_connection",
    "Show what the user must connect for a provider (auth type + fields + setup guide). The user authorizes it in the app's Connections panel — secrets never pass through here.",
    { provider: z.string() },
    async ({ provider }) => {
      const auth = (await api(`/api/providers/${provider}/auth`)) as Record<string, unknown>;
      return json({ provider, ...auth, note: "Tell the user to add this connection in the app's Connections panel." });
    },
  );

  server.tool(
    "list_connections",
    "List the connections the user has already configured.",
    {},
    async () => json(await api("/api/connections")),
  );

  server.tool(
    "validate_workflow",
    "Deterministically check a workflow: wiringErrors and gateErrors (real, break the run), echoedInputs (an output that just repeats an input — likely a mistake), inputs with no source (formFields/configToFill), and unusedOutputs (gate-consumed outputs are NOT counted; the rest are usually harmless terminal confirmations). ok=true means no wiring/gate errors.",
    { id: z.string() },
    async ({ id }) => {
      const wf = await getWF(id);
      const funcs = wf.funcs ?? [];
      const wires = wf.wires ?? [];
      const ef: string[] =
        (wf.trigger as any)?.eventFields ??
        (wf.trigger?.kind === "webhook" ? ["payload"] : wf.trigger?.kind === "schedule" ? ["timestamp"] : []);
      const byId = new Map(funcs.map((f: any) => [f.id, f]));
      const outsOf = (f: any) => Object.keys(f.outputSchema?.properties ?? {});
      const hasInput = (f: any, n: string) => (f.inputs ?? []).some((p: any) => p.name === n);
      // structural wiring errors (break the run)
      const wiringErrors: string[] = [];
      for (const w of wires as any[]) {
        if (!byId.has(w.to)) {
          wiringErrors.push(`wire to unknown step '${w.to}'`);
          continue;
        }
        if (!hasInput(byId.get(w.to), w.toInput)) wiringErrors.push(`'${w.to}' has no input '${w.toInput}'`);
        if (w.from === "trigger") {
          if (w.fromOutput && !ef.includes(w.fromOutput)) wiringErrors.push(`trigger has no event field '${w.fromOutput}'`);
        } else {
          const sf = byId.get(w.from);
          if (!sf) wiringErrors.push(`wire from unknown step '${w.from}'`);
          else if (w.fromOutput && !outsOf(sf).includes(w.fromOutput)) wiringErrors.push(`'${w.from}' has no output '${w.fromOutput}'`);
        }
      }
      // gate errors (a conditional that can't evaluate)
      const gateErrors: string[] = [];
      for (const f of funcs as any[]) {
        if (!f.gate?.ref) continue;
        const [sid, , fld] = String(f.gate.ref).split(".");
        const sf = byId.get(sid);
        if (!sf || !outsOf(sf).includes(fld)) gateErrors.push(`'${f.id}' gate ref '${f.gate.ref}' points to a missing output`);
        if (f.gate.equals === undefined && f.gate.truthy === undefined) gateErrors.push(`'${f.id}' gate has no condition (equals/truthy)`);
      }
      const sat = new Set((wires as any[]).map((w) => `${w.to} ${w.toInput}`));
      const formFields: string[] = [];
      const configToFill: string[] = [];
      for (const f of funcs as any[])
        for (const p of f.inputs ?? []) {
          if (sat.has(`${f.id} ${p.name}`) || ef.includes(p.name)) continue;
          (p.role === "config" ? configToFill : formFields).push(`${f.id}.${p.name}`);
        }
      // an output is USED if a wire OR a gate consumes it
      const used = new Set((wires as any[]).map((w) => `${w.from} ${w.fromOutput}`));
      for (const f of funcs as any[]) {
        if (!f.gate?.ref) continue;
        const [sid, , fld] = String(f.gate.ref).split(".");
        used.add(`${sid} ${fld}`);
      }
      // split unused outputs: an output that re-declares one of the step's own
      // inputs is almost always a mistake (echoing an input); everything else is
      // typically a terminal confirmation (a record id, message ts, ack) that no
      // step consumes — which is normal, not an error.
      const echoedInputs: string[] = [];
      const unusedOutputs: string[] = [];
      for (const f of funcs as any[]) {
        const ins = new Set((f.inputs ?? []).map((p: any) => p.name));
        for (const o of outsOf(f)) {
          if (used.has(`${f.id} ${o}`)) continue;
          (ins.has(o) ? echoedInputs : unusedOutputs).push(`${f.id}.${o}`);
        }
      }
      return json({
        ok: wiringErrors.length === 0 && gateErrors.length === 0,
        wiringErrors,
        gateErrors,
        // a real quality issue: an output that just repeats one of the step's inputs
        echoedInputs,
        formFields,
        configToFill,
        unusedOutputs: {
          count: unusedOutputs.length,
          note: "outputs no step/gate consumes — usually terminal confirmations (ids, timestamps, acks); normal, not errors",
          fields: unusedOutputs,
        },
      });
    },
  );

  server.tool(
    "run_workflow",
    "Run the workflow once with an optional trigger input, and return each step's status/output.",
    { workflowId: z.string(), input: z.record(z.string(), z.unknown()).optional() },
    async ({ workflowId, input }) => {
      const wf = await getWF(workflowId);
      const res = await fetch(APP_URL + "/api/run", {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({
          funcs: wf.funcs,
          wires: wf.wires,
          config: wf.config ?? {},
          nodeConnections: wf.nodeConnections ?? {},
          input: input ?? {},
          workflowId,
          workflowName: wf.name,
          runId: randomUUID(),
        }),
      });
      const raw = await res.text();
      const records: Array<{ nodeId: string; status: string; output?: unknown; error?: string }> = [];
      for (const line of raw.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const d = line.slice(5).trim();
        if (!d || d === "[DONE]") continue;
        try {
          const r = JSON.parse(d);
          if (r.nodeId) records.push({ nodeId: r.nodeId, status: r.status, output: r.output, error: r.error });
        } catch {
          void 0;
        }
      }
      return json(records);
    },
  );

  await server.connect(new StdioServerTransport());
  console.error(`Flowbaker MCP ready (app=${APP_URL}, space=${SPACE_ID}).`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
