import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  useNodesState,
  useReactFlow,
  type Node,
  type Edge,
  type OnNodesChange,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { Chat } from "./Chat";
import { FuncNode } from "./FuncNode";
import { NodePanel } from "./NodePanel";
import { RightPanel, type RightTab } from "./RightPanel";
import { WorkflowsPanel } from "./WorkflowsPanel";
import { RunPanel } from "./RunPanel";
import { useSaveWorkflow, fetchWorkflow } from "./queries";
import type { AuthoredFunc, Wire } from "./types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";

const wireKey = (w: Wire) => `${w.from}.${w.fromOutput}->${w.to}.${w.toInput}`;

const nodeTypes = { func: FuncNode };

function buildNode(
  f: AuthoredFunc,
  position: { x: number; y: number },
  status?: string,
): Node {
  return {
    id: f.id,
    type: "func",
    position,
    data: {
      title: f.title || f.id,
      summary: f.summary || "",
      pure: f.pure,
      status,
    },
  };
}

function Canvas({
  nodes,
  edges,
  onNodesChange,
  onSelect,
}: {
  nodes: Node[];
  edges: Edge[];
  onNodesChange: OnNodesChange<Node>;
  onSelect: (id: string) => void;
}) {
  const { fitView } = useReactFlow();
  useEffect(() => {
    if (nodes.length > 0) fitView({ duration: 300, padding: 0.2 });
  }, [nodes.length, fitView]);

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      onNodesChange={onNodesChange}
      fitView
      colorMode="dark"
      onNodeClick={(_, node) => onSelect(node.id)}
    >
      <Background />
      <Controls />
    </ReactFlow>
  );
}

export function App() {
  const [funcs, setFuncs] = useState<AuthoredFunc[]>([]);
  const [wires, setWires] = useState<Wire[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const positionsRef = useRef<Record<string, { x: number; y: number }>>({});

  const [workflowId, setWorkflowId] = useState<string | null>(null);
  const [name, setName] = useState("untitled");
  const [runStatus, setRunStatus] = useState<Record<string, string>>({});
  const [configValues, setConfigValues] = useState<
    Record<string, Record<string, string>>
  >({});
  const [activeTab, setActiveTab] = useState<RightTab>("chat");

  const saveMutation = useSaveWorkflow();
  const selected = funcs.find((f) => f.id === selectedId) ?? null;

  const onSelectNode = useCallback((id: string) => {
    setSelectedId(id);
    setActiveTab("node");
  }, []);

  const onConfigChange = useCallback(
    (funcId: string, port: string, value: string) => {
      setConfigValues((prev) => ({
        ...prev,
        [funcId]: { ...(prev[funcId] ?? {}), [port]: value },
      }));
    },
    [],
  );

  const onFuncs = useCallback((list: AuthoredFunc[]) => {
    if (list.length === 0) return;
    setFuncs((prev) => {
      const map = new Map(prev.map((f) => [f.id, f]));
      for (const f of list) map.set(f.id, f);
      return [...map.values()];
    });
  }, []);

  const onWires = useCallback((list: Wire[]) => {
    if (list.length === 0) return;
    setWires((prev) => {
      const map = new Map(prev.map((w) => [wireKey(w), w]));
      for (const w of list) map.set(wireKey(w), w);
      return [...map.values()];
    });
  }, []);

  useEffect(() => {
    setNodes((prev) => {
      const prevPos = new Map(prev.map((n) => [n.id, n.position]));
      return funcs.map((f, i) =>
        buildNode(
          f,
          prevPos.get(f.id) ??
            positionsRef.current[f.id] ?? { x: 60 + i * 340, y: 160 },
          runStatus[f.id],
        ),
      );
    });
  }, [funcs, runStatus, setNodes]);

  const rfEdges: Edge[] = useMemo(() => {
    const ids = new Set(funcs.map((f) => f.id));
    return wires
      .filter((w) => ids.has(w.from) && ids.has(w.to))
      .map((w) => ({
        id: wireKey(w),
        source: w.from,
        target: w.to,
        label:
          w.fromOutput && w.toInput ? `${w.fromOutput} → ${w.toInput}` : undefined,
        animated: true,
        style: { stroke: "#6ea8ff" },
        labelStyle: { fill: "#cdd9ec", fontSize: 11 },
        labelBgStyle: { fill: "#1b2433" },
      }));
  }, [wires, funcs]);

  const reset = () => {
    setFuncs([]);
    setWires([]);
    setSelectedId(null);
    setRunStatus({});
    setConfigValues({});
    positionsRef.current = {};
    setWorkflowId(null);
    setName("untitled");
  };

  const save = async () => {
    const id = workflowId ?? crypto.randomUUID();
    const positions = Object.fromEntries(nodes.map((n) => [n.id, n.position]));
    await saveMutation.mutateAsync({
      id,
      name,
      funcs,
      wires,
      positions,
      config: configValues,
    });
    setWorkflowId(id);
  };

  const load = async (id: string) => {
    const wf = await fetchWorkflow(id);
    positionsRef.current = wf.positions ?? {};
    setSelectedId(null);
    setWires(wf.wires ?? []);
    setFuncs(wf.funcs ?? []);
    setConfigValues(wf.config ?? {});
    setWorkflowId(wf.id);
    setName(wf.name ?? "untitled");
  };

  return (
    <div className="flex h-screen w-screen flex-col bg-background text-foreground">
      <div className="p-2 pb-0">
        <header className="flex items-center gap-3 rounded-2xl border border-border/40 bg-muted/40 px-4 py-2 backdrop-blur-xl">
          <strong className="text-sm font-semibold">Workflow Builder</strong>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="h-8 w-48 bg-background-subtle text-sm"
          />
          <Button
            size="sm"
            onClick={save}
            disabled={saveMutation.isPending || funcs.length === 0}
          >
            {saveMutation.isPending ? "saving…" : "Save"}
          </Button>
          <Button size="sm" variant="ghost" onClick={reset}>
            New
          </Button>
          <Separator orientation="vertical" className="ml-auto h-5" />
          <Badge variant="secondary" className="font-normal">
            {funcs.length} func
          </Badge>
        </header>
      </div>

      <div className="flex min-h-0 flex-1 gap-2 p-2">
        <WorkflowsPanel currentId={workflowId} onLoad={load} />
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-2xl border border-border/40 bg-card">
          <div className="min-h-0 flex-1">
            <ReactFlowProvider>
              <Canvas
                nodes={nodes}
                edges={rfEdges}
                onNodesChange={onNodesChange}
                onSelect={onSelectNode}
              />
            </ReactFlowProvider>
          </div>
          <RunPanel
            funcs={funcs}
            wires={wires}
            config={configValues}
            onStatus={setRunStatus}
          />
        </div>
        <RightPanel
          active={activeTab}
          onTab={setActiveTab}
          chat={<Chat onFuncs={onFuncs} onWires={onWires} />}
          node={
            <NodePanel
              func={selected}
              config={selected ? (configValues[selected.id] ?? {}) : {}}
              onConfigChange={(port, value) =>
                selected && onConfigChange(selected.id, port, value)
              }
            />
          }
        />
      </div>
    </div>
  );
}
