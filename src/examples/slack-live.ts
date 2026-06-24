import type {
  FuncNode,
  StepRecord,
  FuncDefinition,
  FuncContext,
  ProviderClient,
  PureFunc,
} from "../atoms/index";
import type { Workflow, Runtime, ConnectionResolver } from "../engine/index";
import {
  Scheduler,
  Worker,
  InMemoryQueue,
  InMemoryRunLog,
  InMemoryFuncRegistry,
} from "../engine/index";
import { slackPostFunc } from "./send-email";

const token = process.env.SLACK_TOKEN;
const channel = process.env.SLACK_CHANNEL;

if (!token || !channel) {
  console.error("SLACK_TOKEN ve SLACK_CHANNEL gerekli (.env içine koy).");
  process.exit(1);
}

const formatSignupFunc: PureFunc = {
  id: "fn_format_signup",
  version: 1,
  kind: "adapter",
  pure: true,
  inputs: [
    { name: "firstName", role: "input", schema: { type: "string" }, required: true },
    { name: "lastName", role: "input", schema: { type: "string" }, required: true },
    { name: "email", role: "input", schema: { type: "string" }, required: true },
    { name: "plan", role: "input", schema: { type: "string" }, required: true },
  ],
  outputSchema: {
    type: "object",
    properties: { message: { type: "string" } },
    required: ["message"],
  },
  body: {
    language: "python",
    source:
      "def run(ctx, input):\n  full = f\"{input.firstName} {input.lastName}\".strip()\n  return {'message': f'Yeni kayit: {full} ({input.email}) - {str(input.plan).upper()} plan'}",
    generatedBy: {
      agent: "func-writer",
      prompt: "kayıt verisinden okunabilir bir slack mesajı oluştur",
    },
  },
};

class EvalRuntime implements Runtime {
  async run(
    def: FuncDefinition,
    ctx: FuncContext,
    input: Record<string, unknown>,
  ): Promise<unknown> {
    const fn = new Function(
      "ctx",
      "input",
      `return (async () => { ${def.body.source} })()`,
    );
    return await fn(ctx, input);
  }
}

const slackClient = {
  postMessage: async (ch: string, text: string) => {
    const res = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({ channel: ch, text }),
    });
    const data = (await res.json()) as {
      ok: boolean;
      ts?: string;
      error?: string;
    };
    if (!data.ok) throw new Error(`slack error: ${data.error}`);
    return data.ts;
  },
};

class LiveConnections implements ConnectionResolver {
  async inject(node: FuncNode): Promise<Record<string, ProviderClient>> {
    const clients: Record<string, ProviderClient> = {};
    for (const name of Object.keys(node.connections)) {
      if (name === "slack") clients[name] = slackClient;
    }
    return clients;
  }
}

const nodeFormat: FuncNode = {
  nodeId: "node_format",
  funcId: "fn_format_signup",
  funcVersion: 1,
  bindings: {
    firstName: { mode: "ref", path: "trigger.output.firstName" },
    lastName: { mode: "ref", path: "trigger.output.lastName" },
    email: { mode: "ref", path: "trigger.output.email" },
    plan: { mode: "ref", path: "trigger.output.plan" },
  },
  connections: {},
  dependsOn: [],
};

const nodeSlack: FuncNode = {
  nodeId: "node_notify_slack",
  funcId: "fn_slack_post",
  funcVersion: 1,
  bindings: {
    channel: { mode: "literal", value: channel },
    text: { mode: "ref", path: "node_format.output.message" },
  },
  connections: { slack: "conn_slack_live" },
  dependsOn: [],
};

const workflow: Workflow = {
  id: "wf_slack_live",
  nodes: [nodeFormat, nodeSlack],
};

const registry = new InMemoryFuncRegistry();
registry.register(formatSignupFunc);
registry.register(slackPostFunc);

const queue = new InMemoryQueue();
const log = new InMemoryRunLog();
const scheduler = new Scheduler(workflow, log, queue);
const worker = new Worker(
  workflow,
  registry,
  new LiveConnections(),
  new EvalRuntime(),
  log,
  queue,
  scheduler,
);

async function main(): Promise<void> {
  const runId = "run_slack_live";

  const signup = {
    firstName: process.env.SIGNUP_FIRST ?? "Ada",
    lastName: process.env.SIGNUP_LAST ?? "Lovelace",
    email: process.env.SIGNUP_EMAIL ?? "ada@example.com",
    plan: process.env.SIGNUP_PLAN ?? "pro",
  };

  const triggerRecord: StepRecord = {
    runId,
    nodeId: "trigger",
    funcId: "trigger",
    funcVersion: 1,
    attempt: 1,
    status: "done",
    resolvedInput: {},
    output: signup,
  };
  await log.append(triggerRecord);
  await scheduler.tick(runId);

  let item = await queue.pop();
  while (item) {
    console.log(`> step: ${item.nodeId}`);
    await worker.process(item);
    item = await queue.pop();
  }

  const final = await log.get(runId);
  console.log("\n=== RUN LOG ===");
  for (const r of final.records) {
    console.log(
      `${r.status.padEnd(8)} ${r.nodeId.padEnd(20)} -> ${JSON.stringify(r.output ?? {})}`,
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
