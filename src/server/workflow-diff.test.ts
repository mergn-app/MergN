import { test } from "node:test";
import assert from "node:assert/strict";
import {
  canonicalize,
  contentHash,
  diffWorkflows,
  type WorkflowSnapshot,
} from "./workflow-diff";

const fn = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  bodySource: `export default async (ctx, input) => ({ x: input.a });`,
  inputs: [{ name: "a", role: "input", type: "string" }],
  outputSchema: { properties: { x: {} } },
  ...over,
});

const base: WorkflowSnapshot = {
  name: "wf",
  funcs: [fn("parse"), fn("act", { requires: [{ provider: "slack" }] })],
  wires: [{ from: "parse", fromOutput: "x", to: "act", toInput: "a" }],
  positions: { parse: { x: 0, y: 0 }, act: { x: 100, y: 0 } },
  config: { act: { channel: "C1" } },
  trigger: { kind: "webhook" },
};

// ── contentHash ──────────────────────────────────────────────────────────
test("hash: positions excluded (moving a node = same hash)", () => {
  const moved = { ...base, positions: { parse: { x: 999, y: 999 } } };
  assert.equal(contentHash(base), contentHash(moved));
});

test("hash: func order independent", () => {
  const reordered = { ...base, funcs: [base.funcs![1], base.funcs![0]] };
  assert.equal(contentHash(base), contentHash(reordered));
});

test("hash: wire order independent", () => {
  const w2 = { ...base, wires: [{ from: "x", fromOutput: "y", to: "z", toInput: "q" }, ...base.wires!] };
  const w2rev = { ...base, wires: [...base.wires!, { from: "x", fromOutput: "y", to: "z", toInput: "q" }] };
  assert.equal(contentHash(w2), contentHash(w2rev));
});

test("hash: code change → different", () => {
  const changed = { ...base, funcs: [fn("parse", { bodySource: "different" }), base.funcs![1]] };
  assert.notEqual(contentHash(base), contentHash(changed));
});

test("hash: trigger change → different", () => {
  assert.notEqual(contentHash(base), contentHash({ ...base, trigger: { kind: "schedule" } }));
});

test("hash: deterministic across calls", () => {
  assert.equal(canonicalize(base), canonicalize({ ...base }));
});

// ── diffWorkflows ────────────────────────────────────────────────────────
test("diff: identical → empty", () => {
  const d = diffWorkflows(base, { ...base });
  assert.deepEqual(d.nodes, { added: [], removed: [], modified: [] });
  assert.deepEqual(d.wires, { added: [], removed: [] });
  assert.equal(d.trigger.changed, false);
  assert.deepEqual(d.config.changedSteps, []);
});

test("diff: node added / removed", () => {
  const b = { ...base, funcs: [...base.funcs!, fn("log")] };
  const d = diffWorkflows(base, b);
  assert.deepEqual(d.nodes.added, ["log"]);
  assert.deepEqual(d.nodes.removed, []);
  const d2 = diffWorkflows(b, base);
  assert.deepEqual(d2.nodes.removed, ["log"]);
});

test("diff: code change flagged", () => {
  const b = { ...base, funcs: [fn("parse", { bodySource: "new code" }), base.funcs![1]] };
  const m = diffWorkflows(base, b).nodes.modified;
  assert.equal(m.length, 1);
  assert.equal(m[0].id, "parse");
  assert.equal(m[0].changed.code, true);
});

test("diff: input add/remove/retype", () => {
  const b = { ...base, funcs: [
    fn("parse", { inputs: [{ name: "b", role: "input", type: "string" }, { name: "a", role: "config", type: "string" }] }),
    base.funcs![1],
  ] };
  const m = diffWorkflows(base, b).nodes.modified.find((x) => x.id === "parse")!;
  assert.deepEqual(m.changed.inputs!.added, ["b"]);
  assert.deepEqual(m.changed.inputs!.removed, []);
  assert.deepEqual(m.changed.inputs!.retyped, ["a"]); // role input→config
});

test("diff: output add/remove", () => {
  const b = { ...base, funcs: [fn("parse", { outputSchema: { properties: { x: {}, y: {} } } }), base.funcs![1]] };
  const m = diffWorkflows(base, b).nodes.modified.find((x) => x.id === "parse")!;
  assert.deepEqual(m.changed.outputs!.added, ["y"]);
});

test("diff: gate added / removed / changed", () => {
  const withGate = { ...base, funcs: [base.funcs![0], fn("act", { requires: [{ provider: "slack" }], gate: { ref: "parse.output.x", truthy: true } })] };
  assert.equal(diffWorkflows(base, withGate).nodes.modified.find((x) => x.id === "act")!.changed.gate, "added");
  assert.equal(diffWorkflows(withGate, base).nodes.modified.find((x) => x.id === "act")!.changed.gate, "removed");
  const gate2 = { ...base, funcs: [base.funcs![0], fn("act", { requires: [{ provider: "slack" }], gate: { ref: "parse.output.x", equals: "yes" } })] };
  assert.equal(diffWorkflows(withGate, gate2).nodes.modified.find((x) => x.id === "act")!.changed.gate, "changed");
});

test("diff: provider change", () => {
  const b = { ...base, funcs: [base.funcs![0], fn("act", { requires: [{ provider: "discord" }] })] };
  assert.equal(diffWorkflows(base, b).nodes.modified.find((x) => x.id === "act")!.changed.provider, true);
});

test("diff: wire add/remove", () => {
  const b = { ...base, wires: [...base.wires!, { from: "act", fromOutput: "x", to: "log", toInput: "a" }] };
  const d = diffWorkflows(base, b);
  assert.deepEqual(d.wires.added, ["act.x->log.a"]);
  assert.deepEqual(d.wires.removed, []);
});

test("diff: trigger + config change", () => {
  const b = { ...base, trigger: { kind: "schedule" }, config: { act: { channel: "C2" } } };
  const d = diffWorkflows(base, b);
  assert.equal(d.trigger.changed, true);
  assert.deepEqual(d.config.changedSteps, ["act"]);
});
