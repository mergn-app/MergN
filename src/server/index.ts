import { trace, flushTraces } from "../observability";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { existsSync } from "node:fs";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
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
import { google } from "@ai-sdk/google";
import { z } from "zod";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { authorFunc } from "../agent/func-author";
import { createWorkflowStore } from "./store";
import { createRunStore, type RunDoc } from "./runs";
import { runWorkflow } from "./run";
import { createRegistry, publicAuth } from "../providers/registry";
import { assertSpace } from "../store/docstore";
import { createStorage } from "../store/factory";
import { authorProvider, repairProvider } from "../agent/provider-author";
import { designWorkflow, planWorkflow } from "../agent/workflow-designer";
import { authorInputForm } from "../agent/form-author";
import { createConnections } from "./connections";
import { createChatStore } from "./chat";
import { resolveEgressHost } from "./egress";
import { createOAuth } from "./oauth";
import { auth, getSessionUser } from "./auth";
import { createMembership } from "./membership";
import type { FuncDefinition, StepRecord } from "../atoms/index";

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
  "Keep replies short. After building, briefly summarize the steps and how they connect.",
].join("\n");

function funcToWire(func: FuncDefinition, title: string, summary: string) {
  return {
    id: func.id,
    title,
    summary,
    version: func.version,
    kind: func.kind,
    pure: func.pure,
    inputs: func.inputs.map((p) => ({
      name: p.name,
      role: p.role,
      type: p.schema.type,
      required: p.required,
    })),
    outputSchema: func.outputSchema,
    bodySource: func.body.source,
    dependencies: func.body.dependencies ?? [],
    requires: func.pure ? [] : func.requires,
    dangerClass: func.pure ? null : func.effect.dangerClass,
    idempotency: func.pure ? null : func.effect.idempotency,
  };
}

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

const { store, vault } = createStorage();
const registry = createRegistry(store);
const oauth = createOAuth({ store, vault, registry });
const connections = createConnections({ store, vault, oauth });
const workflows = createWorkflowStore(store);
const runs = createRunStore(store);
const membership = createMembership(store);
const chats = createChatStore(store);

async function runSavedWorkflow(
  spaceId: string,
  wf: {
    id: string;
    name: string;
    funcs: unknown[];
    wires: unknown[];
    config?: Record<string, Record<string, string>>;
    nodeConnections?: Record<string, Record<string, string>>;
  },
  input: Record<string, unknown>,
  trigger: string,
): Promise<RunDoc> {
  const startedAt = new Date().toISOString();
  const records: StepRecord[] = [];
  await runWorkflow(
    { spaceId, registry, connections },
    wf.funcs as Parameters<typeof runWorkflow>[1],
    wf.wires as Parameters<typeof runWorkflow>[2],
    input,
    wf.config ?? {},
    wf.nodeConnections ?? {},
    (record) => {
      records.push(record);
    },
  );
  const run: RunDoc = {
    id: randomUUID(),
    workflowId: wf.id,
    workflowName: wf.name,
    trigger,
    status: records.some((r) => r.status === "failed") ? "failed" : "done",
    input,
    records,
    startedAt,
    finishedAt: new Date().toISOString(),
  };
  await runs.saveRun(spaceId, run);
  return run;
}

function makeTools(
  spaceId: string,
  writer: UIMessageStreamWriter,
  sessionId: string,
) {
  const meta = { spaceId, sessionId };
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
        status: "active" | "pending" | "done";
      }[] = [{ key: "plan", label: "Planning steps", status: "active" }];
      const emit = () =>
        writer.write({ type: "data-design", id: progressId, data: { items } });
      emit();
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
      const r = await authorFunc(registry, { spaceId, intent, provider }, meta);
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
      const r = await authorFunc(registry, { spaceId, intent, provider }, meta);
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

function oauthResultPage(ok: boolean, detail: string): string {
  const payload = JSON.stringify({ type: "oauth-result", ok, detail });
  const title = ok ? "Connected" : "Connection failed";
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>body{font-family:ui-sans-serif,system-ui;background:#1a1a1e;color:#eee;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}div{text-align:center}</style></head>
<body><div><h3>${title}</h3><p style="color:#999">${ok ? detail : detail.replace(/</g, "&lt;")}</p><p style="color:#666;font-size:13px">You can close this window.</p></div>
<script>try{window.opener&&window.opener.postMessage(${payload},"*")}catch(e){}setTimeout(function(){window.close()},${ok ? 600 : 2500})</script>
</body></html>`;
}

const app = new Hono<{ Variables: { spaceId: string; userId: string } }>();

app.on(["POST", "GET"], "/api/auth/*", (c) => auth.handler(c.req.raw));

app.use("/api/*", async (c, next) => {
  const path = c.req.path;
  if (path.startsWith("/api/auth/") || path.startsWith("/api/hooks/"))
    return next();

  const user = await getSessionUser(c.req.raw.headers);
  if (!user) return c.json({ error: "unauthorized" }, 401);

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
    if (!(await membership.canAccess(user.id, candidate)))
      return c.json({ error: "forbidden" }, 403);
    spaceId = candidate;
  }
  await registry.ensureSpace(spaceId);
  c.set("spaceId", spaceId);
  c.set("userId", user.id);
  await next();
});

app.get("/api/chat/conversations", async (c) => {
  return c.json(
    await chats.listConversations(c.get("spaceId"), c.get("userId")),
  );
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
  const { message: rawMessage, conversationId, workflowState } =
    await c.req.json<{
      message: UIMessage;
      conversationId: string;
      workflowState?: string;
    }>();
  if (!/^[A-Za-z0-9_-]+$/.test(conversationId ?? ""))
    return c.json({ error: "bad conversation id" }, 400);
  const message = clampUserMessage(rawMessage);
  const previous =
    (await chats.getConversation(spaceId, userId, conversationId))?.messages ??
    [];
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
        model: google(process.env.GEMINI_MODEL ?? "gemini-2.5-flash"),
        system,
        messages: modelMessages,
        stopWhen: stepCountIs(20),
        tools: withResultLimits(makeTools(spaceId, writer, sessionId)),
        providerOptions: {
          google: { thinkingConfig: { includeThoughts: true } },
        },
        experimental_telemetry: trace("builder-chat", { spaceId, sessionId }),
        onFinish: () => {
          void flushTraces();
        },
      });
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
    },
    onError: (error) => {
      console.error("STREAM ERROR:", error);
      return error instanceof Error ? error.message : String(error);
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
    trigger?: { kind: "manual" | "webhook" | "schedule" | "poll" | "event" };
    inputForm?: unknown;
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
  });
  return c.json(wf);
});

app.delete("/api/workflows/:id", async (c) => {
  await workflows.deleteWorkflow(c.get("spaceId"), c.req.param("id"));
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
    const prior = await runs.getRun(spaceId, body.resumeRunId);
    if (prior) {
      seed = prior.records.filter((r) => r.status === "done");
      input = prior.input;
    }
  }
  const runDocId = body.runId ?? randomUUID();
  return streamSSE(c, async (stream) => {
    const startedAt = new Date().toISOString();
    const records: StepRecord[] = [];
    await runWorkflow(
      { spaceId, registry, connections },
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
      await runs.saveRun(spaceId, {
        id: runDocId,
        workflowId: body.workflowId,
        workflowName: body.workflowName ?? "untitled",
        trigger: body.resumeRunId ? "resume" : "manual",
        status: records.some((r) => r.status === "failed") ? "failed" : "done",
        input,
        records,
        startedAt,
        finishedAt: new Date().toISOString(),
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
  await registry.ensureSpace(spaceId);
  const wf = await workflows.getWorkflow(spaceId, c.req.param("workflowId"));
  if (!wf) return c.json({ error: "workflow not found" }, 404);
  if (wf.trigger?.kind !== "webhook")
    return c.json({ error: "workflow has no webhook trigger" }, 400);
  const body = await c.req
    .json<Record<string, unknown>>()
    .catch(() => ({}) as Record<string, unknown>);
  const run = await runSavedWorkflow(spaceId, wf, body ?? {}, "webhook");
  return c.json({ ok: true, runId: run.id, status: run.status });
});

app.post("/api/input-form", async (c) => {
  const body = await c.req.json<{ goal?: string; fields?: string[] }>();
  const form = await authorInputForm(body.goal ?? "", body.fields ?? [], {
    spaceId: c.get("spaceId"),
  });
  return c.json(form);
});

app.get("/api/runs", async (c) => {
  const workflowId = c.req.query("workflow") || undefined;
  return c.json(await runs.listRuns(c.get("spaceId"), workflowId));
});

app.get("/api/runs/:id", async (c) => {
  const run = await runs.getRun(c.get("spaceId"), c.req.param("id"));
  return run ? c.json(run) : c.json({ error: "not found" }, 404);
});

app.get("/api/spaces", async (c) => {
  const spaces = await membership.listSpaces(c.get("userId"));
  return c.json(spaces.map((s) => ({ id: s.id, name: s.name })));
});

app.post("/api/spaces", async (c) => {
  const body = await c.req.json<{ name?: string }>();
  const space = await membership.createSpace(
    c.get("userId"),
    body.name ?? "Workspace",
  );
  await registry.ensureSpace(space.id);
  return c.json({ id: space.id, name: space.name });
});

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
  const body = await c.req.json<{ account?: string }>();
  return c.json(
    await connections.updateConnection(c.get("spaceId"), c.req.param("id"), {
      account: body.account,
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
  console.log(`chat server on http://localhost:${info.port}`);
});

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, async () => {
    await flushTraces();
    process.exit(0);
  });
}
