import { test } from "node:test";
import assert from "node:assert/strict";
import type { DocStore } from "../store/docstore";
import { createRunStore, type RunHeader, type RunStepDoc } from "./runs";

function memStore(): DocStore {
  const m = new Map<string, Record<string, unknown>>();
  const k = (s: string, c: string, i: string) => `${s}/${c}/${i}`;
  return {
    async spaces() {
      return [];
    },
    async list(s, c) {
      return [...m.entries()]
        .filter(([key]) => key.startsWith(`${s}/${c}/`))
        .map(([, v]) => v);
    },
    async get(s, c, i) {
      return m.get(k(s, c, i)) ?? null;
    },
    async put(s, c, i, d) {
      m.set(k(s, c, i), d);
    },
    async remove(s, c, i) {
      m.delete(k(s, c, i));
    },
  };
}

const SP = "sp1";
const header = (over: Partial<RunHeader> = {}): RunHeader => ({
  id: "run1",
  workflowId: "wf1",
  workflowName: "wf",
  trigger: "manual",
  status: "running",
  input: {},
  startedAt: new Date().toISOString(),
  ...over,
});
const step = (seq: number, over: Partial<RunStepDoc> = {}): RunStepDoc => ({
  runId: "run1",
  nodeId: `n${seq}`,
  funcId: `n${seq}`,
  funcVersion: 1,
  attempt: 1,
  status: "done",
  resolvedInput: {},
  spaceId: SP,
  workflowId: "wf1",
  seq,
  at: new Date().toISOString(),
  ...over,
});

test("start → running visible, no records yet", async () => {
  const runs = createRunStore(memStore());
  await runs.startRun(SP, header());
  const r = await runs.getRun(SP, "run1");
  assert.equal(r?.status, "running");
  assert.deepEqual(r?.records, []);
});

test("append steps → getRun assembles records in seq order", async () => {
  const runs = createRunStore(memStore());
  await runs.startRun(SP, header());
  await runs.appendStep(SP, step(2));
  await runs.appendStep(SP, step(1, { nodeId: "trigger", funcId: "trigger" }));
  const r = await runs.getRun(SP, "run1");
  assert.equal(r?.records.length, 2);
  assert.equal(r?.records[0].nodeId, "trigger"); // seq 1 first
  assert.equal(r?.records[1].nodeId, "n2");
});

test("finalize → status + stepCount (trigger excluded)", async () => {
  const runs = createRunStore(memStore());
  await runs.startRun(SP, header());
  await runs.appendStep(SP, step(1, { nodeId: "trigger", funcId: "trigger" }));
  await runs.appendStep(SP, step(2));
  await runs.appendStep(SP, step(3, { status: "failed", error: "boom" }));
  await runs.finalizeRun(SP, "run1", "failed", new Date().toISOString());
  const r = await runs.getRun(SP, "run1");
  assert.equal(r?.status, "failed");
  assert.equal(r?.stepCount, 2); // n2 + n3, trigger excluded
  assert.equal(r?.records.length, 3); // assembled incl trigger
});

test("listRuns → meta with stepCount, newest first", async () => {
  const runs = createRunStore(memStore());
  await runs.startRun(SP, header({ id: "a", startedAt: "2026-01-01T00:00:01Z" }));
  await runs.startRun(SP, header({ id: "b", startedAt: "2026-01-01T00:00:02Z" }));
  const list = await runs.listRuns(SP, "wf1");
  assert.equal(list.length, 2);
  assert.equal(list[0].id, "b"); // newest first
});

test("markOrphaned → stale running becomes failed(orphaned)", async () => {
  const runs = createRunStore(memStore());
  const old = new Date(Date.now() - 60_000).toISOString();
  await runs.startRun(SP, header({ id: "stuck", startedAt: old }));
  await runs.startRun(SP, header({ id: "fresh", startedAt: new Date().toISOString() }));
  const n = await runs.markOrphaned(SP, 30_000); // older than 30s
  assert.equal(n, 1);
  assert.equal((await runs.getRun(SP, "stuck"))?.status, "failed");
  assert.equal((await runs.getRun(SP, "stuck"))?.failReason, "orphaned");
  assert.equal((await runs.getRun(SP, "fresh"))?.status, "running");
});

test("pruneRuns uncapped (self-host default) → 0", async () => {
  const runs = createRunStore(memStore());
  await runs.startRun(SP, header({ id: "x" }));
  await runs.finalizeRun(SP, "x", "done", new Date(0).toISOString());
  assert.equal(await runs.pruneRuns(SP), 0); // RUN_RETENTION_DAYS unset → keep
});

test("legacy saveRun still readable via getRun", async () => {
  const runs = createRunStore(memStore());
  await runs.saveRun(SP, {
    id: "legacy",
    workflowId: "wf1",
    workflowName: "wf",
    trigger: "manual",
    status: "done",
    input: {},
    records: [step(1) as never],
    startedAt: "t",
    finishedAt: "t2",
  });
  const r = await runs.getRun(SP, "legacy");
  assert.equal(r?.records.length, 1); // falls back to inline records (no run_steps)
});
