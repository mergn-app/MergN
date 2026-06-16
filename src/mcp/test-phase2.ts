import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: "node",
  args: ["--import", "tsx", "src/mcp/server.ts"],
  env: { ...process.env, APP_URL: process.env.APP_URL ?? "http://localhost:8787" } as Record<string, string>,
});
const client = new Client({ name: "mcp-test2", version: "0.1.0" });
await client.connect(transport);
const call = async (name: string, args: Record<string, unknown> = {}) => {
  const r: any = await client.callTool({ name, arguments: args });
  const t = r.content?.[0]?.text ?? "";
  try { return JSON.parse(t); } catch { return t; }
};

const tools = (await client.listTools()).tools.map((t) => t.name);
console.log("TOOLS:", tools.join(", "));

const p0 = await call("list_providers");
console.log("\nlist_providers ->", p0.map((p: any) => p.id).join(", "));

const reg = await call("register_provider", {
  id: "echo_api",
  name: "Echo API",
  apiDoc: "send(text) -> posts text to the echo endpoint",
  clientSource: "export default (cred, fetch) => ({ send: async (text) => { const r = await fetch('https://api.echo.test/post', { method:'POST', headers:{authorization:'Bearer '+cred.token}, body: JSON.stringify({text}) }); return r.json(); } });",
  egressDomain: "api.echo.test",
  credentialFields: [{ name: "token", label: "API token" }],
});
console.log("register_provider ->", JSON.stringify(reg));

const p1 = await call("list_providers");
console.log("list_providers (after) ->", p1.map((p: any) => p.id).join(", "));

const conn = await call("request_connection", { provider: "echo_api" });
console.log("request_connection ->", JSON.stringify({ type: conn.type, fields: (conn.fields ?? []).map((f: any) => f.name) }));

// validate: build a workflow with a deliberate bad wire + a clean gate
const wf = await call("create_workflow", { name: "MCP validate test", triggerKind: "manual" });
await call("add_step", { workflowId: wf.id, id: "a", code: "export default async (ctx, input) => ({ x: input.n + 1 });" });
await call("add_step", { workflowId: wf.id, id: "b", code: "export default async (ctx, input) => ({ y: input.x * 2 });" });
await call("set_wire", { workflowId: wf.id, from: "a", fromOutput: "WRONGOUT", to: "b", toInput: "x" }); // bad output name
const v1 = await call("validate_workflow", { id: wf.id });
console.log("\nvalidate (bad wire) -> ok:", v1.ok, "| errors:", JSON.stringify(v1.wiringErrors));
await call("set_wire", { workflowId: wf.id, from: "a", fromOutput: "x", to: "b", toInput: "x" }); // fix
const v2 = await call("validate_workflow", { id: wf.id });
console.log("validate (fixed)   -> ok:", v2.ok, "| formFields:", JSON.stringify(v2.formFields));

const okProviders = p0.some((p: any) => p.id === "http") && reg.registered && p1.some((p: any) => p.id === "echo_api");
const okConn = (conn.fields ?? []).some((f: any) => f.name === "token");
const okValidate = v1.ok === false && v1.wiringErrors.some((e: string) => /no output 'WRONGOUT'/.test(e)) && v2.ok === true;
console.log(okProviders && okConn && okValidate
  ? "\n✅ PASS — providers list/register, request_connection, validate_workflow all work"
  : `\n❌ FAIL (providers=${okProviders} conn=${okConn} validate=${okValidate})`);
await client.close();
process.exit(okProviders && okConn && okValidate ? 0 : 1);
