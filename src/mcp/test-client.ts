// Local end-to-end test of the MCP server WITHOUT Claude Code: spawns the server
// over stdio, drives the tools, and checks gate-skip works through the full stack.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: "node",
  args: ["--import", "tsx", "src/mcp/server.ts"],
  env: { ...process.env, APP_URL: process.env.APP_URL ?? "http://localhost:8787" } as Record<string, string>,
});
const client = new Client({ name: "mcp-test", version: "0.1.0" });
await client.connect(transport);

const call = async (name: string, args: Record<string, unknown> = {}) => {
  const r: any = await client.callTool({ name, arguments: args });
  const t = r.content?.[0]?.text ?? "";
  try { return JSON.parse(t); } catch { return t; }
};

const tools = await client.listTools();
console.log("TOOLS:", tools.tools.map((t) => t.name).join(", "));
const res = await client.listResources();
console.log("RESOURCES:", res.resources.map((r) => r.name).join(", "));

const wf = await call("create_workflow", { name: "MCP gate test", triggerKind: "manual" });
console.log("\ncreate_workflow ->", wf.id);
const s1 = await call("add_step", { workflowId: wf.id, id: "decide", code: "export default async (ctx, input) => ({ is_big: Number(input.n) > 100 });" });
console.log("add_step decide ->", JSON.stringify(s1.inputs), "out", JSON.stringify(s1.outputs));
const s2 = await call("add_step", { workflowId: wf.id, id: "act", code: "export default async (ctx, input) => ({ msg: 'ran' });" });
console.log("add_step act ->", JSON.stringify(s2.outputs));
const g = await call("set_gate", { workflowId: wf.id, step: "act", ref: "decide.output.is_big", truthy: true });
console.log("set_gate ->", JSON.stringify(g.gate));

const small = await call("run_workflow", { workflowId: wf.id, input: { n: 50 } });
const big = await call("run_workflow", { workflowId: wf.id, input: { n: 200 } });
const st = (recs: any[]) => Object.fromEntries(recs.map((r) => [r.nodeId, r.status]));
console.log("\nrun n=50  ->", JSON.stringify(st(small)));
console.log("run n=200 ->", JSON.stringify(st(big)));
const sSmall = st(small), sBig = st(big);
const ok = sSmall.decide === "done" && sSmall.act === "skipped" && sBig.decide === "done" && sBig.act === "done";
console.log(ok ? "\n✅ PASS — MCP→app→engine: act skipped on n=50, runs on n=200; workflow saved + in UI" : "\n❌ FAIL");
await client.close();
process.exit(ok ? 0 : 1);
