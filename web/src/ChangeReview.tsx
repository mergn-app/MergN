import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  type Node,
  type Edge,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { X, Check, Ban, RotateCcw, Wrench } from "lucide-react";
import { cn } from "@/lib/utils";
import { FuncNode } from "./FuncNode";
import { TriggerNode } from "./TriggerNode";
import { layoutPositions } from "./layout";
import { outputsOf } from "./lineage";
import type { AuthoredFunc, Wire, TriggerConfig } from "./types";
import {
  fetchWorkflow,
  useApproveFix,
  useRejectFix,
  useRestoreVersion,
  useVersionReview,
  type FixEvent,
  type WorkflowVersionMeta,
  type WorkflowSnapshot,
  type WorkflowDiff,
} from "./queries";
import { parseWireKey } from "./fix-badges";
import { CodeMirrorDiff } from "./CodeMirrorDiff";

// The unified change-review surface — a DIALOG (not full-screen) the size of the
// editor canvas. It renders the EXACT editor canvas (same FuncNode/TriggerNode,
// edges, ports), read-only, with the changed nodes ringed by change type, plus a
// permanently-open bottom panel that inspects the selected node's change(s).

export type ChangeSource =
  | { kind: "fix"; event: FixEvent }
  | { kind: "version"; version: WorkflowVersionMeta };

const nodeTypes = { func: FuncNode, trigger: TriggerNode };
type ChangeType = "added" | "removed" | "modified" | "unchanged";
const RING: Record<ChangeType, string> = {
  added: "rounded-3xl ring-2 ring-emerald-500",
  removed: "rounded-3xl ring-2 ring-rose-500 opacity-50",
  modified: "rounded-3xl ring-2 ring-amber-500",
  unchanged: "opacity-50",
};
const wk = (w: Wire) => `${w.from}.${w.fromOutput ?? ""}->${w.to}.${w.toInput ?? ""}`;

// Builds the editor-identical nodes/edges for the AFTER snapshot (plus removed
// nodes from BEFORE), each ringed by change type. Same FuncNode data shape, same
// edge logic (wires + trigger-fed + gate) as the editor.
function buildFlow(before: WorkflowSnapshot, after: WorkflowSnapshot, diff: WorkflowDiff): { nodes: Node[]; edges: Edge[] } {
  const afterFuncs = (after.funcs ?? []) as AuthoredFunc[];
  const beforeFuncs = (before.funcs ?? []) as AuthoredFunc[];
  const wires = (after.wires ?? []) as Wire[];
  const trigger = (after.trigger ?? { kind: "manual" }) as TriggerConfig;
  const positions = { ...(before.positions ?? {}), ...(after.positions ?? {}) };
  const config = ((after as { config?: Record<string, Record<string, string>> }).config) ?? {};

  const addedIds = new Set(diff.nodes.added);
  const removedIds = new Set(diff.nodes.removed);
  const modifiedIds = new Set(diff.nodes.modified.map((m) => m.id));
  const changeOf = (id: string): ChangeType =>
    addedIds.has(id) ? "added" : removedIds.has(id) ? "removed" : modifiedIds.has(id) ? "modified" : "unchanged";

  const layout = layoutPositions(afterFuncs, wires, trigger);
  let auto = 0;
  const place = (id: string) => positions[id] ?? layout[id] ?? { x: 360 + auto++ * 340, y: 160 };

  const mkFuncNode = (f: AuthoredFunc, cfg: Record<string, Record<string, string>>): Node => {
    const inputs = f.inputs.map((p) => {
      const wired = wires.some((w) => w.to === f.id && w.toInput === p.name);
      const v = cfg[f.id]?.[p.name];
      return { name: p.name, bound: wired || (v !== undefined && v !== ""), variable: !wired && p.role !== "config" };
    });
    inputs.sort((a, b) => Number(a.variable ?? false) - Number(b.variable ?? false));
    return {
      id: f.id,
      type: "func",
      position: place(f.id),
      draggable: false,
      connectable: false,
      className: RING[changeOf(f.id)],
      data: { title: f.title || f.id, summary: f.summary || "", pure: f.pure, gated: !!f.gate, needsConnection: false, needsValue: false, inputs, outputs: outputsOf(f) },
    };
  };

  const nodes: Node[] = afterFuncs.map((f) => mkFuncNode(f, config));
  // removed nodes from BEFORE (shown faded red, with their old config)
  const beforeConfig = ((before as { config?: Record<string, Record<string, string>> }).config) ?? {};
  for (const f of beforeFuncs) if (removedIds.has(f.id)) nodes.push(mkFuncNode(f, beforeConfig));

  // trigger node (same as editor): only when not manual
  const ids = new Set(afterFuncs.map((f) => f.id));
  beforeFuncs.forEach((f) => removedIds.has(f.id) && ids.add(f.id));
  const showTrigger = trigger.kind !== "manual";
  if (showTrigger) {
    ids.add("trigger");
    nodes.unshift({ id: "trigger", type: "trigger", position: place("trigger"), draggable: false, data: { fields: [...new Set(trigger.eventFields ?? [])], kind: trigger.kind } });
  }

  // edges — identical to the editor (wires + trigger-fed + gate), coloured by diff
  const addedW = new Set(diff.wires.added);
  const edges: Edge[] = wires
    .filter((w) => ids.has(w.from) && ids.has(w.to))
    .map((w) => ({
      id: wk(w),
      source: w.from,
      target: w.to,
      sourceHandle: w.fromOutput || undefined,
      targetHandle: w.toInput || undefined,
      animated: true,
      style: { stroke: addedW.has(wk(w)) ? "#10b981" : "#6ea8ff", strokeWidth: addedW.has(wk(w)) ? 2 : 1 },
    }));
  if (showTrigger) {
    const ev = trigger.eventFields ?? [];
    for (const f of afterFuncs)
      for (const p of f.inputs)
        if (p.role !== "config" && ev.includes(p.name) && !wires.some((w) => w.to === f.id && w.toInput === p.name))
          edges.push({ id: `trigger.${p.name}->${f.id}.${p.name}`, source: "trigger", target: f.id, sourceHandle: p.name, targetHandle: p.name, animated: true, style: { stroke: "#6ea8ff" } });
  }
  for (const f of afterFuncs) {
    if (!f.gate?.ref) continue;
    const src = String(f.gate.ref).split(".")[0];
    if (ids.has(src)) edges.push({ id: `gate:${src}->${f.id}`, source: src, target: f.id, animated: false, style: { stroke: "#f59e0b", strokeDasharray: "5 4" } });
  }
  // removed wires (red dashed)
  for (const k of diff.wires.removed) {
    const p = parseWireKey(k);
    if (p && ids.has(p.from) && ids.has(p.to)) edges.push({ id: "rm:" + k, source: p.from, target: p.to, style: { stroke: "#f43f5e", strokeDasharray: "5 4" } });
  }
  return { nodes, edges };
}

export function ChangeReview({ source, workflowId, onClose, onApplied }: { source: ChangeSource; workflowId: string; onClose: () => void; onApplied?: () => void }) {
  const { t } = useTranslation();
  // approve/restore mutate HEAD → the editor passes onApplied to reload its canvas.
  const done = () => {
    onApplied?.();
    onClose();
  };
  const isFix = source.kind === "fix";
  const event = source.kind === "fix" ? source.event : undefined;
  const version = source.kind === "version" ? source.version : undefined;

  const wf = useQuery({ queryKey: ["workflow-full", workflowId], queryFn: () => fetchWorkflow(workflowId), enabled: isFix });
  const review = useVersionReview(workflowId, version?.id);

  const data = useMemo((): { before: WorkflowSnapshot; after: WorkflowSnapshot; diff: WorkflowDiff } | null => {
    if (isFix) {
      if (!wf.data || !event?.proposal) return null;
      const before: WorkflowSnapshot = { funcs: wf.data.funcs, wires: wf.data.wires, trigger: wf.data.trigger, positions: wf.data.positions };
      const after: WorkflowSnapshot = { ...before, funcs: event.proposal.apply?.funcs ?? before.funcs, wires: event.proposal.apply?.wires ?? before.wires };
      return { before, after, diff: event.proposal.diff };
    }
    return review.data ?? null;
  }, [isFix, wf.data, event, review.data]);

  const flow = useMemo(() => (data ? buildFlow(data.before, data.after, data.diff) : { nodes: [], edges: [] }), [data]);

  // first changed node — the bottom panel is ALWAYS open, defaulting to this
  const firstChanged = useMemo(() => {
    if (!data) return null;
    const d = data.diff.nodes;
    return d.modified[0]?.id ?? d.added[0] ?? d.removed[0] ?? null;
  }, [data]);
  const [picked, setPicked] = useState<string | null>(null);
  const selected = picked ?? firstChanged;

  const approve = useApproveFix(workflowId);
  const reject = useRejectFix(workflowId);
  const restore = useRestoreVersion(workflowId);
  const busy = approve.isPending || reject.isPending || restore.isPending;

  const title = isFix ? event!.diagnosis : version!.healing?.diagnosis || t(`versions.source.${version!.source}`);
  const subtitle = isFix
    ? `${t(`heal.status.${event!.status}`)} · ${t(`heal.mode.${event!.mode}`)} · ${t(`heal.confidence.${event!.confidence}`)}`
    : `v${version!.seq} · ${t(`versions.source.${version!.source}`)} · ${new Date(version!.createdAt).toLocaleString()}`;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div className="flex h-[84vh] w-[82vw] max-w-[1120px] flex-col overflow-hidden rounded-2xl border border-border/50 bg-card" onClick={(e) => e.stopPropagation()}>
        {/* header — info + actions */}
        <header className="flex items-start gap-3 border-b border-border/40 px-4 py-3">
          <Wrench className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium">{title || t("review.title")}</div>
            <div className="mt-0.5 text-[11px] text-muted-foreground">{subtitle}</div>
          </div>
          {isFix && event!.status === "proposed" && (
            <>
              <button onClick={() => reject.mutate(event!.id, { onSuccess: onClose })} disabled={busy} className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50">
                <Ban className="size-3.5" /> {t("heal.reject")}
              </button>
              <button onClick={() => approve.mutate(event!.id, { onSuccess: done })} disabled={busy} className="flex items-center gap-1.5 rounded-lg bg-emerald-500/90 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-500 disabled:opacity-50">
                <Check className="size-3.5" /> {t("heal.approve")}
              </button>
            </>
          )}
          {!isFix && (
            <button onClick={() => restore.mutate(version!.id, { onSuccess: done })} disabled={busy} className="flex items-center gap-1.5 rounded-lg border border-border/50 px-3 py-1.5 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50">
              <RotateCcw className="size-3.5" /> {t("review.switchTo")}
            </button>
          )}
          <button onClick={onClose} className="flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground">
            <X className="size-4" />
          </button>
        </header>

        {/* editor-identical canvas (read-only) */}
        <div className="relative min-h-0 flex-1 bg-background-subtle/30">
          {!data ? (
            <div className="flex h-full items-center justify-center text-xs text-muted-foreground">{t("common.loading")}</div>
          ) : (
            <ReactFlowProvider>
              <ReactFlow
                nodes={flow.nodes}
                edges={flow.edges}
                nodeTypes={nodeTypes}
                nodesDraggable={false}
                nodesConnectable={false}
                edgesFocusable={false}
                onNodeClick={(_e, n) => setPicked(n.id)}
                fitView
                minZoom={0.2}
                proOptions={{ hideAttribution: true }}
              >
                <Background gap={20} className="opacity-50" />
              </ReactFlow>
            </ReactFlowProvider>
          )}
          <div className="pointer-events-none absolute left-3 top-3 flex gap-2 text-[10px]">
            <Legend cls="bg-emerald-500" label={t("review.added")} />
            <Legend cls="bg-amber-500" label={t("review.modified")} />
            <Legend cls="bg-rose-500" label={t("review.removed")} />
          </div>
        </div>

        {/* bottom panel — ALWAYS open; defaults to the first changed node */}
        {data && (
          <NodeDetail key={selected ?? "none"} nodeId={selected} before={data.before} after={data.after} diff={data.diff} />
        )}
      </div>
    </div>
  );
}

function Legend({ cls, label }: { cls: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1 rounded bg-card/80 px-1.5 py-0.5 text-muted-foreground">
      <span className={cn("size-2 rounded-full", cls)} /> {label}
    </span>
  );
}

interface FnEntry { id: string; bodySource?: string; requires?: { provider: string }[] }

function NodeDetail({ nodeId, before, after, diff }: { nodeId: string | null; before: WorkflowSnapshot; after: WorkflowSnapshot; diff: WorkflowDiff }) {
  const { t } = useTranslation();
  const beforeFn = (before.funcs as FnEntry[] | undefined)?.find((f) => f.id === nodeId);
  const afterFn = (after.funcs as FnEntry[] | undefined)?.find((f) => f.id === nodeId);
  const isAdded = !!nodeId && diff.nodes.added.includes(nodeId);
  const isRemoved = !!nodeId && diff.nodes.removed.includes(nodeId);
  const changed = diff.nodes.modified.find((m) => m.id === nodeId)?.changed;
  const touchedByWire = !!nodeId && [...diff.wires.added, ...diff.wires.removed].some((k) => {
    const p = parseWireKey(k);
    return p && (p.from === nodeId || p.to === nodeId);
  });

  const cats = useMemo(() => {
    const list: { key: string; label: string }[] = [];
    if (changed?.code || isAdded || isRemoved) list.push({ key: "code", label: t("review.cat.code") });
    if (changed?.inputs || changed?.outputs) list.push({ key: "input", label: t("review.cat.input") });
    if (changed?.provider) list.push({ key: "provider", label: t("review.cat.provider") });
    if (changed?.gate) list.push({ key: "gate", label: t("review.cat.gate") });
    if (touchedByWire) list.push({ key: "wire", label: t("review.cat.wire") });
    return list;
  }, [changed, isAdded, isRemoved, touchedByWire, t]);

  const [cat, setCat] = useState(cats[0]?.key ?? "code");
  const active = cats.find((c) => c.key === cat) ? cat : cats[0]?.key;

  return (
    <div className="flex h-[34vh] flex-col border-t border-border/40 bg-card">
      <div className="flex items-center gap-2 border-b border-border/40 px-4 py-2">
        <span className="font-mono text-xs font-medium">{nodeId ?? t("review.pickNode")}</span>
        {cats.length > 1 ? (
          <select value={active} onChange={(e) => setCat(e.target.value)} className="rounded-lg border border-border/50 bg-background px-2 py-1 text-xs outline-none">
            {cats.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
          </select>
        ) : cats.length === 1 ? (
          <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">{cats[0].label}</span>
        ) : null}
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        {!nodeId || cats.length === 0 ? (
          <div className="flex h-full items-center justify-center text-xs text-muted-foreground">{t("review.pickNodeHint")}</div>
        ) : active === "code" ? (
          <CodeMirrorDiff oldCode={beforeFn?.bodySource ?? ""} newCode={afterFn?.bodySource ?? ""} />
        ) : (
          <div className="h-full overflow-auto">
            {active === "input" && <InputDiff changed={changed} />}
            {active === "provider" && <BeforeAfter label={t("review.cat.provider")} before={beforeFn?.requires?.[0]?.provider ?? "—"} after={afterFn?.requires?.[0]?.provider ?? "—"} />}
            {active === "gate" && <BeforeAfter label={t("review.cat.gate")} before={changed?.gate === "added" ? "—" : t("review.present")} after={changed?.gate === "removed" ? "—" : t("review.present")} note={changed?.gate} />}
            {active === "wire" && <WireDiff nodeId={nodeId} diff={diff} />}
          </div>
        )}
      </div>
    </div>
  );
}

function InputDiff({ changed }: { changed?: { inputs?: { added: string[]; removed: string[]; retyped: string[] }; outputs?: { added: string[]; removed: string[] } } }) {
  const { t } = useTranslation();
  const i = changed?.inputs;
  const o = changed?.outputs;
  const Row = ({ sign, cls, items }: { sign: string; cls: string; items: string[] }) =>
    items.length ? (
      <div className="flex flex-wrap items-center gap-1.5 px-4 py-1 text-xs">
        <span className={cn("w-4 font-mono", cls)}>{sign}</span>
        {items.map((x) => <span key={x} className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]">{x}</span>)}
      </div>
    ) : null;
  return (
    <div className="py-2">
      <div className="px-4 pb-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/70">{t("review.cat.input")}</div>
      <Row sign="+" cls="text-emerald-500" items={i?.added ?? []} />
      <Row sign="−" cls="text-rose-500" items={i?.removed ?? []} />
      <Row sign="~" cls="text-amber-500" items={i?.retyped ?? []} />
      {o && (o.added.length > 0 || o.removed.length > 0) && (
        <>
          <div className="px-4 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/70">{t("review.outputs")}</div>
          <Row sign="+" cls="text-emerald-500" items={o.added} />
          <Row sign="−" cls="text-rose-500" items={o.removed} />
        </>
      )}
    </div>
  );
}

function BeforeAfter({ label, before, after, note }: { label: string; before: string; after: string; note?: string }) {
  return (
    <div className="p-4">
      <div className="pb-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/70">{label}{note ? ` · ${note}` : ""}</div>
      <div className="grid grid-cols-2 gap-2">
        <div className="rounded-lg border border-rose-500/30 bg-rose-500/5 px-3 py-2 font-mono text-xs">{before}</div>
        <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 font-mono text-xs">{after}</div>
      </div>
    </div>
  );
}

function WireDiff({ nodeId, diff }: { nodeId: string; diff: WorkflowDiff }) {
  const { t } = useTranslation();
  const mine = (keys: string[]) => keys.filter((k) => { const p = parseWireKey(k); return p && (p.from === nodeId || p.to === nodeId); });
  return (
    <div className="space-y-1 p-4 font-mono text-[11px]">
      <div className="pb-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/70">{t("review.cat.wire")}</div>
      {mine(diff.wires.added).map((k) => <div key={k} className="rounded bg-emerald-500/10 px-2 py-0.5 text-emerald-600 dark:text-emerald-400">+ {k}</div>)}
      {mine(diff.wires.removed).map((k) => <div key={k} className="rounded bg-rose-500/10 px-2 py-0.5 text-rose-600 dark:text-rose-400">− {k}</div>)}
    </div>
  );
}
