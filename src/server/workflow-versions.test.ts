import { test } from "node:test";
import assert from "node:assert/strict";
import type { DocStore } from "../store/docstore";
import type { SavedWorkflow } from "./store";
import {
  createVersionStore,
  selectPrunable,
  type WorkflowVersion,
} from "./workflow-versions";

// ── in-memory DocStore (no fs) ──
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

const head = (over: Partial<SavedWorkflow> = {}): SavedWorkflow => ({
  id: "wf1",
  name: "wf",
  funcs: [],
  wires: [],
  positions: {},
  config: {},
  trigger: { kind: "manual" },
  createdAt: "x",
  updatedAt: "x",
  ...over,
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const SPACE = "space1";

// ── selectPrunable (pure policy) ──
const ver = (id: string, source: WorkflowVersion["source"], createdAt: string, label?: string): WorkflowVersion => ({
  id, workflowId: "wf1", contentHash: id, snapshot: {}, source, createdAt, ...(label ? { label } : {}),
});

test("selectPrunable: keeps healing/restore/labeled + last N, prunes oldest excess", () => {
  const all = [
    ver("v1", "editor", "2026-01-01T00:00:01Z"),
    ver("v2", "editor", "2026-01-01T00:00:02Z"),
    ver("v3", "healing", "2026-01-01T00:00:03Z"),
    ver("v4", "editor", "2026-01-01T00:00:04Z"),
    ver("v5", "editor", "2026-01-01T00:00:05Z", "stable"), // labeled
  ];
  // prunable (editor, unlabeled) = v1,v2,v4 ; cap 2 → prune oldest 1 → v1
  const pruned = selectPrunable(all, 2).map((v) => v.id);
  assert.deepEqual(pruned, ["v1"]);
});

test("selectPrunable: uncapped (NO_CAP) → nothing", () => {
  const all = [ver("v1", "editor", "t1"), ver("v2", "editor", "t2")];
  assert.deepEqual(selectPrunable(all, Number.MAX_SAFE_INTEGER), []);
  assert.deepEqual(selectPrunable(all, 0), []);
});

// ── version store (integration) ──
test("seal → version created; list + latest + get", async () => {
  const vs = createVersionStore(memStore());
  const { version, deduped } = await vs.seal(SPACE, head(), { source: "editor" });
  assert.equal(deduped, false);
  assert.ok(version.id);
  assert.equal(version.source, "editor");

  const list = await vs.list(SPACE, "wf1");
  assert.equal(list.length, 1);
  assert.equal(list[0].seq, 1);

  const got = await vs.get(SPACE, version.id);
  assert.equal(got?.id, version.id);
  assert.ok(got?.snapshot);

  const latest = await vs.latest(SPACE, "wf1");
  assert.equal(latest?.id, version.id);
});

test("seal identical content → deduped (no new version)", async () => {
  const vs = createVersionStore(memStore());
  const first = await vs.seal(SPACE, head(), { source: "editor" });
  const again = await vs.seal(SPACE, head(), { source: "editor" });
  assert.equal(again.deduped, true);
  assert.equal(again.version.id, first.version.id);
  assert.equal((await vs.list(SPACE, "wf1")).length, 1);
});

test("seal changed content → new version + parent link; newest-first list", async () => {
  const vs = createVersionStore(memStore());
  const a = await vs.seal(SPACE, head(), { source: "editor" });
  await sleep(2);
  const b = await vs.seal(SPACE, head({ funcs: [{ id: "x" }] }), { source: "chat" });
  assert.equal(b.deduped, false);
  assert.notEqual(b.version.id, a.version.id);
  assert.equal(b.version.parentVersionId, a.version.id);

  const list = await vs.list(SPACE, "wf1");
  assert.equal(list.length, 2);
  assert.equal(list[0].id, b.version.id); // newest first
  assert.equal(list[0].seq, 2);
  assert.equal(list[1].seq, 1);
});

test("position-only change → deduped (cosmetic, no version)", async () => {
  const vs = createVersionStore(memStore());
  const a = await vs.seal(SPACE, head(), { source: "editor" });
  const b = await vs.seal(SPACE, head({ positions: { x: { x: 99, y: 99 } } }), { source: "editor" });
  assert.equal(b.deduped, true);
  assert.equal(b.version.id, a.version.id);
});

test("seal restore source carries restoredFrom", async () => {
  const vs = createVersionStore(memStore());
  const a = await vs.seal(SPACE, head(), { source: "editor" });
  await sleep(2);
  const r = await vs.seal(SPACE, head({ funcs: [{ id: "y" }] }), { source: "restore", restoredFrom: a.version.id });
  assert.equal(r.version.source, "restore");
  assert.equal(r.version.restoredFrom, a.version.id);
});

test("prune uncapped by default → 0 removed", async () => {
  const vs = createVersionStore(memStore());
  await vs.seal(SPACE, head(), { source: "editor" });
  await sleep(2);
  await vs.seal(SPACE, head({ funcs: [{ id: "z" }] }), { source: "editor" });
  assert.equal(await vs.prune(SPACE, "wf1"), 0);
  assert.equal((await vs.list(SPACE, "wf1")).length, 2);
});
