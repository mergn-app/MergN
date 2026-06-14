import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
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
  type Connection,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { Sun, Moon, Zap, Wand2, Loader2 } from "lucide-react";
import { detectIssues, repairWiring } from "./health";
import { LogsPanel } from "./LogsPanel";
import { FilesPanel } from "./FilesPanel";
import { Chat } from "./Chat";
import { TriggerDialog } from "./TriggerDialog";
import { Pipeline } from "./Pipeline";
import { Story } from "./Story";
import { FuncNode } from "./FuncNode";
import { TriggerNode } from "./TriggerNode";
import { DeletableEdge } from "./DeletableEdge";
import { NodePanel } from "./NodePanel";
import { RightPanel, type RightTab } from "./RightPanel";
import { WorkflowsPanel } from "./WorkflowsPanel";
import { SpaceSwitcher } from "./SpaceSwitcher";
import { PlanChip } from "./PlanChip";
import { LanguageSwitcher } from "./LanguageSwitcher";
import { LegalLinks } from "./LegalLinks";
import { EnterpriseDialog } from "./EnterpriseDialog";
import { ConnectionsPanel } from "./ConnectionsPanel";
import { triggerIntervalMs } from "./schedule-display";
import { ChatPanel } from "./ChatPanel";
import { RunPanel } from "./RunPanel";
import {
  useSaveWorkflow,
  useRunStream,
  fetchWorkflow,
  generateInputForm,
  useConnections,
  useConversations,
  useDeleteConversation,
  getWorkflowStatus,
  pauseWorkflow,
  resumeWorkflow,
  reportLog,
  type ConnectionMeta,
  type ActivationState,
} from "./queries";
import type {
  AuthoredFunc,
  InputForm,
  RunStepData,
  TriggerConfig,
  Wire,
  WorkflowOp,
} from "./types";
import { useNavigate } from "@tanstack/react-router";
import { summarizeWorkflow, outputsOf } from "./lineage";
import { useAuth } from "./authContext";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { LogOut } from "lucide-react";

const wireKey = (w: Wire) => `${w.from}.${w.fromOutput}->${w.to}.${w.toInput}`;
const normalizeFunc = (f: AuthoredFunc): AuthoredFunc => ({
  ...f,
  inputs: (f.inputs ?? []).map((p) => ({ ...p, role: "input" })),
});

const NO_CONNECTIONS: ConnectionMeta[] = [];

const nodeTypes = { func: FuncNode, trigger: TriggerNode };
const edgeTypes = { deletable: DeletableEdge };

function buildNode(
  f: AuthoredFunc,
  position: { x: number; y: number },
  status: string | undefined,
  needsConnection: boolean,
  inputs: { name: string; bound: boolean; variable?: boolean }[],
  onDelete: () => void,
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
      needsConnection,
      inputs,
      outputs: outputsOf(f),
      onDelete,
    },
  };
}

function Canvas({
  nodes,
  edges,
  onNodesChange,
  onSelect,
  onConnect,
  onDeleteNodes,
  onDeleteEdges,
  colorMode,
}: {
  nodes: Node[];
  edges: Edge[];
  onNodesChange: OnNodesChange<Node>;
  onSelect: (id: string) => void;
  onConnect: (connection: Connection) => void;
  onDeleteNodes: (nodes: Node[]) => void;
  onDeleteEdges: (edges: Edge[]) => void;
  colorMode: "dark" | "light";
}) {
  const { fitView } = useReactFlow();
  useEffect(() => {
    if (nodes.length > 0) fitView({ duration: 300, padding: 0.28 });
  }, [nodes.length, fitView]);

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      onNodesChange={onNodesChange}
      onConnect={onConnect}
      onNodesDelete={onDeleteNodes}
      onEdgesDelete={onDeleteEdges}
      deleteKeyCode={["Backspace", "Delete"]}
      fitView
      fitViewOptions={{ padding: 0.28 }}
      colorMode={colorMode}
      onNodeClick={(_, node) => onSelect(node.id)}
    >
      <Background />
      <Controls />
    </ReactFlow>
  );
}

// Header "Contact us" — opens the shared contact dialog framed for feedback
// (bug reports & product ideas) rather than the Enterprise sales context.
function ContactUsLink() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        size="sm"
        variant="ghost"
        className="h-8 px-2 text-xs text-muted-foreground"
        onClick={() => setOpen(true)}
      >
        Contact us
      </Button>
      {open && (
        <EnterpriseDialog
          title="Talk to us"
          description="Found a bug or have an idea to make the product better? Send it our way — we read every message."
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

export function App({
  spaceId,
  routeWorkflowId,
}: {
  spaceId: string;
  routeWorkflowId: string | null;
}) {
  const navigate = useNavigate();
  const [funcs, setFuncs] = useState<AuthoredFunc[]>([]);
  const [wires, setWires] = useState<Wire[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const positionsRef = useRef<Record<string, { x: number; y: number }>>({});
  const sendChatRef = useRef<((text: string) => void) | null>(null);

  const [workflowId, setWorkflowId] = useState<string | null>(null);
  const [name, setName] = useState("untitled");
  const [trigger, setTrigger] = useState<TriggerConfig>({ kind: "manual" });
  const [savedTrigger, setSavedTrigger] = useState<TriggerConfig>({
    kind: "manual",
  });
  const [triggerOpen, setTriggerOpen] = useState(false);
  const [activation, setActivation] = useState<ActivationState | "loading">("none");
  const [actBusy, setActBusy] = useState(false);
  const [statusVersion, setStatusVersion] = useState(0);
  const [inputForm, setInputForm] = useState<InputForm | null>(null);
  const [formSyncing, setFormSyncing] = useState(false);
  const [autoSave, setAutoSave] = useState(false);
  const [theme, setTheme] = useState<"dark" | "light">(() =>
    typeof document !== "undefined" &&
    document.documentElement.classList.contains("dark")
      ? "dark"
      : "light",
  );

  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
    try {
      localStorage.setItem("theme", theme);
    } catch {
      void 0;
    }
  }, [theme]);
  const [runStatus, setRunStatus] = useState<Record<string, string>>({});
  const [runData, setRunData] = useState<Record<string, RunStepData>>({});
  const [configValues, setConfigValues] = useState<
    Record<string, Record<string, string>>
  >({});
  const [nodeConnections, setNodeConnections] = useState<
    Record<string, Record<string, string>>
  >({});
  const [variables, setVariables] = useState<Record<string, unknown>>({});
  const [persistedVars, setPersistedVars] = useState<Record<string, unknown>>(
    {},
  );
  const [activeTab, setActiveTab] = useState<RightTab>("chat");
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [chatView, setChatView] = useState<"list" | "chat">("list");
  const [chatPrompt, setChatPrompt] = useState<string | null>(null);
  const [loadedConvId, setLoadedConvId] = useState<string | null>(null);
  const [view, setView] = useState<"story" | "pipeline" | "graph">("story");
  const [bottomHeight, setBottomHeight] = useState(256);
  const [building, setBuilding] = useState(false);
  const [repairing, setRepairing] = useState(false);
  const [repairMsg, setRepairMsg] = useState<string | null>(null);

  const startResize = useCallback(
    (e: React.MouseEvent) => {
      const startY = e.clientY;
      const startH = bottomHeight;
      const onMove = (ev: MouseEvent) => {
        const next = Math.min(Math.max(startH + (startY - ev.clientY), 120), 640);
        setBottomHeight(next);
      };
      const onUp = () => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
        document.body.style.userSelect = "";
        document.body.style.cursor = "";
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
      document.body.style.userSelect = "none";
      document.body.style.cursor = "row-resize";
    },
    [bottomHeight],
  );

  const { t } = useTranslation();
  const saveMutation = useSaveWorkflow();
  const { user, requireAuth, signOut, managed } = useAuth();
  const { data: connections = NO_CONNECTIONS } = useConnections();
  const conversationsQuery = useConversations();
  const deleteConversation = useDeleteConversation();
  const selected = funcs.find((f) => f.id === selectedId) ?? null;

  useEffect(() => {
    if (conversationId !== null) return;
    if (!user) {
      setConversationId(crypto.randomUUID());
      return;
    }
    if (!conversationsQuery.isFetched) return;
    setConversationId(conversationsQuery.data?.[0]?.id ?? crypto.randomUUID());
  }, [conversationId, user, conversationsQuery.isFetched, conversationsQuery.data]);

  const selectChat = useCallback((id: string) => {
    setConversationId(id);
    setChatPrompt(null);
    setChatView("chat");
    setActiveTab("chat");
  }, []);

  // Start a brand-new chat seeded with the prompt typed in the list view.
  const startChatPrompt = useCallback((text: string) => {
    setConversationId(crypto.randomUUID());
    setChatPrompt(text);
    setChatView("chat");
    setActiveTab("chat");
  }, []);

  const removeChat = useCallback(
    (id: string) => {
      deleteConversation.mutate(id);
      setConversationId((cur) => {
        if (cur !== id) return cur;
        const rest = (conversationsQuery.data ?? []).filter((c) => c.id !== id);
        return rest[0]?.id ?? crypto.randomUUID();
      });
    },
    [deleteConversation, conversationsQuery.data],
  );

  const connectedProviders = useMemo(
    () => new Set(connections.map((c) => c.provider)),
    [connections],
  );

  const missingProviders = useMemo(() => {
    const required = new Set<string>();
    for (const f of funcs) {
      if (!f.pure) for (const r of f.requires) required.add(r.provider);
    }
    return [...required].filter((p) => !connectedProviders.has(p));
  }, [funcs, connectedProviders]);

  const wiringIssues = useMemo(
    () =>
      detectIssues({
        funcs,
        wires,
        trigger,
        inputForm,
        variables,
        configValues,
      }),
    [funcs, wires, trigger, inputForm, variables, configValues],
  );

  const runRepair = useCallback(async () => {
    if (repairing || funcs.length === 0) return;
    setRepairing(true);
    setRepairMsg(null);
    try {
      const r = await repairWiring({ funcs, wires, trigger });
      if (r.added.length) {
        setWires(r.wires);
        const variableSet = new Set(r.variableFields);
        setInputForm((prev) =>
          prev
            ? { ...prev, fields: prev.fields.filter((f) => variableSet.has(f.name)) }
            : prev,
        );
        const list = r.added
          .map((w) => `${w.from}.${w.fromOutput} → ${w.to}.${w.toInput}`)
          .join(", ");
        setRepairMsg(`✓ ${r.added.length} bağlantı eklendi: ${list}`);
      } else {
        const skipped = r.diagnostics.find((d) =>
          d.startsWith("wiring repair skipped"),
        );
        setRepairMsg(
          skipped
            ? `AI onarımı çalışmadı: ${skipped.replace("wiring repair skipped: ", "")}`
            : "Bağlantılar düzgün görünüyor.",
        );
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setRepairMsg(`Onarım başarısız: ${msg}`);
      reportLog({ message: "Fix with AI failed", detail: msg });
    } finally {
      setRepairing(false);
      setTimeout(() => setRepairMsg(null), 6000);
    }
  }, [repairing, funcs, wires, trigger]);

  // Capture browser-side errors the user hits (failed fetches, unhandled
  // rejections like "Load failed") into the Logs feed. Throttled to avoid spam.
  useEffect(() => {
    let last = 0;
    const report = (message: string, detail?: string) => {
      const now = Date.now();
      if (now - last < 2000) return;
      last = now;
      reportLog({ message, detail });
    };
    const onErr = (ev: ErrorEvent) =>
      report("Browser error", ev.message || String(ev.error));
    const onRej = (ev: PromiseRejectionEvent) => {
      const r = ev.reason;
      report("Unhandled rejection", r instanceof Error ? r.message : String(r));
    };
    window.addEventListener("error", onErr);
    window.addEventListener("unhandledrejection", onRej);
    return () => {
      window.removeEventListener("error", onErr);
      window.removeEventListener("unhandledrejection", onRej);
    };
  }, []);

  const workflowState = useMemo(
    () => summarizeWorkflow(funcs, wires, configValues),
    [funcs, wires, configValues],
  );

  const triggerFields = useMemo(() => {
    const fields = new Set<string>();
    for (const w of wires) {
      if (w.from === "trigger" && w.fromOutput) fields.add(w.fromOutput);
    }
    return [...fields];
  }, [wires]);

  const variableFields = useMemo(() => {
    const names = new Set<string>();
    for (const f of funcs) {
      for (const p of f.inputs) {
        if (wires.some((w) => w.to === f.id && w.toInput === p.name)) continue;
        names.add(p.name);
      }
    }
    return [...names];
  }, [funcs, wires]);

  useEffect(() => {
    const have = (inputForm?.fields ?? [])
      .map((f) => f.name)
      .sort()
      .join("|");
    const want = [...variableFields].sort().join("|");
    if (have === want) return;
    if (variableFields.length === 0) {
      if (inputForm) setInputForm(null);
      return;
    }
    const hints: Record<string, string> = {};
    for (const f of funcs) {
      for (const p of f.inputs) {
        if (variableFields.includes(p.name) && f.title) hints[p.name] = f.title;
      }
    }
    const t = setTimeout(async () => {
      setFormSyncing(true);
      try {
        const form = await generateInputForm(name, variableFields, hints);
        setInputForm(form);
      } catch {
        void 0;
      } finally {
        setFormSyncing(false);
      }
    }, 500);
    return () => clearTimeout(t);
  }, [variableFields, inputForm, name, funcs]);

  useEffect(() => {
    if (!inputForm) return;
    const arrayNames = new Set<string>();
    for (const f of funcs)
      for (const p of f.inputs)
        if (p.type === "array") arrayNames.add(p.name);
    const needsPatch = inputForm.fields.some(
      (fld) => arrayNames.has(fld.name) && fld.control !== "array",
    );
    if (!needsPatch) return;
    setInputForm({
      ...inputForm,
      fields: inputForm.fields.map((fld) =>
        arrayNames.has(fld.name) ? { ...fld, control: "array" as const } : fld,
      ),
    });
  }, [inputForm, funcs]);

  const onSelectNode = useCallback((id: string) => {
    if (id === "trigger") {
      setTriggerOpen(true);
      return;
    }
    setSelectedId(id);
    setActiveTab("node");
  }, []);

  const scheduling = trigger.kind === "schedule" || trigger.kind === "poll";

  const [fireAnchor, setFireAnchor] = useState<number | null>(null);
  const [firePulse, setFirePulse] = useState(0);
  const [fireStatus, setFireStatus] = useState<"done" | "failed">("done");
  useRunStream(workflowId, trigger.kind !== "manual", (status) => {
    setFireAnchor(Date.now());
    setFireStatus(status);
    setFirePulse((p) => p + 1);
  });
  useEffect(() => {
    setFireAnchor(scheduling && activation === "active" ? Date.now() : null);
  }, [scheduling, activation, workflowId]);
  const [justFired, setJustFired] = useState(false);
  useEffect(() => {
    if (firePulse === 0) return;
    setJustFired(true);
    const tm = setTimeout(() => setJustFired(false), 1500);
    return () => clearTimeout(tm);
  }, [firePulse]);

  useEffect(() => {
    if (!workflowId || !scheduling) {
      setActivation("none");
      return;
    }
    let cancelled = false;
    getWorkflowStatus(workflowId)
      .then((s) => !cancelled && setActivation(s.state))
      .catch(() => !cancelled && setActivation("none"));
    return () => {
      cancelled = true;
    };
  }, [workflowId, scheduling, statusVersion]);

  const toggleActivation = async () => {
    if (!workflowId || actBusy) return;
    setActBusy(true);
    try {
      if (activation === "active") {
        await pauseWorkflow(workflowId);
        setActivation("paused");
      } else {
        await save();
        await resumeWorkflow(workflowId);
        setActivation("active");
      }
    } catch {
      setActivation(activation);
    } finally {
      setStatusVersion((v) => v + 1);
      setActBusy(false);
    }
  };

  const onRepair = useCallback(
    (
      provider: string,
      ctx: {
        error: string;
        callSite: string;
        sampleInput: string;
        declaredInputs: string[];
      },
    ) => {
      setActiveTab("chat");
      const msg = [
        `A workflow step failed.`,
        `Error: "${ctx.error}"`,
        `Provider: "${provider}".`,
        `The step declares these inputs: ${ctx.declaredInputs.length ? ctx.declaredInputs.join(", ") : "(none)"}.`,
        `The step's resolved input was: ${ctx.sampleInput}`,
        ctx.callSite ? `It calls the provider like this:\n${ctx.callSite}` : "",
        `Diagnose whether this is a provider bug or a flow problem (the step not receiving its input), then act per your rules.`,
      ]
        .filter(Boolean)
        .join("\n\n");
      sendChatRef.current?.(msg);
    },
    [],
  );

  const onConnectionChange = useCallback(
    (funcId: string, requirementName: string, connectionId: string) => {
      setNodeConnections((prev) => {
        const forNode = { ...(prev[funcId] ?? {}) };
        if (connectionId) forNode[requirementName] = connectionId;
        else delete forNode[requirementName];
        return { ...prev, [funcId]: forNode };
      });
    },
    [],
  );

  const removeNode = useCallback((id: string) => {
    setFuncs((prev) => prev.filter((f) => f.id !== id));
    setWires((prev) => prev.filter((w) => w.from !== id && w.to !== id));
    setConfigValues((prev) => {
      const out = { ...prev };
      delete out[id];
      return out;
    });
    setNodeConnections((prev) => {
      const out = { ...prev };
      delete out[id];
      return out;
    });
    setRunStatus((prev) => {
      const out = { ...prev };
      delete out[id];
      return out;
    });
    setRunData((prev) => {
      const out = { ...prev };
      delete out[id];
      return out;
    });
    delete positionsRef.current[id];
    setSelectedId((cur) => (cur === id ? null : cur));
    setAutoSave(true);
  }, []);

  const removeWireByKey = useCallback((key: string) => {
    setWires((prev) => prev.filter((w) => wireKey(w) !== key));
    setAutoSave(true);
  }, []);

  const connectNodes = useCallback(
    (c: Connection) => {
      const source = c.source;
      const target = c.target;
      if (!source || !target || source === target) return;

      const sourceFunc = funcs.find((f) => f.id === source);
      const targetFunc = funcs.find((f) => f.id === target);
      const toInput = c.targetHandle || targetFunc?.inputs[0]?.name || "";
      const fromOutput =
        c.sourceHandle ||
        (source === "trigger"
          ? toInput
          : sourceFunc
            ? outputsOf(sourceFunc)[0] || ""
            : "");
      if (!toInput) return;

      const nextWire: Wire = { from: source, fromOutput, to: target, toInput };
      setWires((prev) => {
        const kept = prev.filter(
          (w) => !(w.to === nextWire.to && w.toInput === nextWire.toInput),
        );
        const key = wireKey(nextWire);
        if (kept.some((w) => wireKey(w) === key)) return kept;
        return [...kept, nextWire];
      });
      setAutoSave(true);
    },
    [funcs],
  );

  const addCodeNode = useCallback(() => {
    const used = new Set(funcs.map((f) => f.id));
    let n = 1;
    let id = `code_step_${n}`;
    while (used.has(id)) {
      n += 1;
      id = `code_step_${n}`;
    }
    const next: AuthoredFunc = {
      id,
      title: `Code step ${n}`,
      summary: "Manual code node",
      version: 1,
      kind: "adapter",
      pure: true,
      inputs: [],
      outputSchema: {
        type: "object",
        properties: {},
        required: [],
      },
      bodySource: "export default async (ctx, input) => ({})",
      requires: [],
      dangerClass: null,
      idempotency: null,
    };
    setFuncs((prev) => [...prev, next]);
    setSelectedId(id);
    setActiveTab("node");
    setAutoSave(true);
  }, [funcs]);

  const updateCodeNode = useCallback(
    (prevId: string, next: AuthoredFunc) => {
      if (prevId !== next.id && funcs.some((f) => f.id === next.id)) {
        reportLog({
          level: "warn",
          message: `node update rejected: duplicate id '${next.id}'`,
        });
        return;
      }
      const normalized = normalizeFunc(next);
      setFuncs((prev) => prev.map((f) => (f.id === prevId ? normalized : f)));
      if (prevId !== next.id) {
        setWires((prev) =>
          prev.map((w) => ({
            ...w,
            from: w.from === prevId ? next.id : w.from,
            to: w.to === prevId ? next.id : w.to,
          })),
        );
        setConfigValues((prev) => {
          const out: Record<string, Record<string, string>> = {};
          for (const [k, v] of Object.entries(prev)) {
            out[k === prevId ? next.id : k] = v;
          }
          return out;
        });
        setNodeConnections((prev) => {
          const out: Record<string, Record<string, string>> = {};
          for (const [k, v] of Object.entries(prev)) {
            out[k === prevId ? next.id : k] = v;
          }
          return out;
        });
        setRunStatus((prev) => {
          const out: Record<string, string> = {};
          for (const [k, v] of Object.entries(prev)) {
            out[k === prevId ? next.id : k] = v;
          }
          return out;
        });
        setRunData((prev) => {
          const out: Record<string, RunStepData> = {};
          for (const [k, v] of Object.entries(prev)) {
            out[k === prevId ? next.id : k] = v;
          }
          return out;
        });
        const moved = positionsRef.current[prevId];
        if (moved) {
          positionsRef.current[next.id] = moved;
          delete positionsRef.current[prevId];
        }
        setSelectedId((cur) => (cur === prevId ? normalized.id : cur));
      }
      setAutoSave(true);
    },
    [funcs],
  );

  const insertCodeNodeBetween = useCallback(
    (wire: Wire) => {
      const used = new Set(funcs.map((f) => f.id));
      let n = 1;
      let id = `code_step_${n}`;
      while (used.has(id)) {
        n += 1;
        id = `code_step_${n}`;
      }

      const upstream = funcs.find((f) => f.id === wire.from);
      const downstream = funcs.find((f) => f.id === wire.to);
      const outProps = upstream?.outputSchema?.properties as
        | Record<string, { type?: string }>
        | undefined;
      const upstreamType =
        (wire.fromOutput && outProps?.[wire.fromOutput]?.type) || undefined;
      const downstreamType = downstream?.inputs.find(
        (p) => p.name === wire.toInput,
      )?.type;

      const inputName = wire.fromOutput || wire.toInput || "value";
      const outputName = wire.toInput || wire.fromOutput || "value";
      const inputType = upstreamType || downstreamType || "string";
      const outputType = downstreamType || upstreamType || "string";

      const next: AuthoredFunc = {
        id,
        title: `Code step ${n}`,
        summary: "Inserted manual node",
        version: 1,
        kind: "adapter",
        pure: true,
        inputs: [
          {
            name: inputName,
            role: "input",
            type: inputType,
            required: true,
          },
        ],
        outputSchema: {
          type: "object",
          properties: { [outputName]: { type: outputType } },
          required: [outputName],
        },
        bodySource: `export default async (ctx, input) => ({\n  ${JSON.stringify(outputName)}: input[${JSON.stringify(inputName)}]\n})`,
        requires: [],
        dangerClass: null,
        idempotency: null,
      };

      setFuncs((prev) => [...prev, next]);
      setWires((prev) => {
        const kept = prev.filter(
          (w) =>
            !(
              w.from === wire.from &&
              w.fromOutput === wire.fromOutput &&
              w.to === wire.to &&
              w.toInput === wire.toInput
            ),
        );
        return [
          ...kept,
          {
            from: wire.from,
            fromOutput: wire.fromOutput,
            to: id,
            toInput: inputName,
          },
          {
            from: id,
            fromOutput: outputName,
            to: wire.to,
            toInput: wire.toInput || outputName,
          },
        ];
      });
      setSelectedId(id);
      setActiveTab("node");
      setAutoSave(true);
    },
    [funcs],
  );

  const [ops, setOps] = useState<WorkflowOp[]>([]);
  const processedOps = useRef<Set<string>>(new Set());

  useEffect(() => {
    const fresh = ops.filter((o) => !processedOps.current.has(o.key));
    if (fresh.length === 0) return;
    for (const o of fresh) processedOps.current.add(o.key);
    for (const o of fresh) {
      if (o.kind === "funcs") {
        setFuncs((prev) => {
          const map = new Map(prev.map((f) => [f.id, f]));
          for (const f of o.funcs) map.set(f.id, normalizeFunc(f));
          return [...map.values()];
        });
      } else if (o.kind === "wires") {
        setWires((prev) => {
          const map = new Map(prev.map((w) => [wireKey(w), w]));
          for (const w of o.wires) map.set(wireKey(w), w);
          return [...map.values()];
        });
      } else if (o.kind === "deleteFunc") {
        setFuncs((prev) => prev.filter((f) => f.id !== o.id));
        setWires((prev) =>
          prev.filter((w) => w.from !== o.id && w.to !== o.id),
        );
        setSelectedId((cur) => (cur === o.id ? null : cur));
      } else if (o.kind === "unwire") {
        setWires((prev) =>
          prev.filter(
            (w) =>
              !(
                w.to === o.to &&
                (o.toInput == null || w.toInput === o.toInput)
              ),
          ),
        );
      } else if (o.kind === "trigger") {
        setTrigger(o.trigger);
      } else if (o.kind === "inputForm") {
        setInputForm(o.inputForm);
      } else if (o.kind === "name") {
        setName(o.name);
      }
    }
    setAutoSave(true);
  }, [ops]);

  useEffect(() => {
    const eventFields = trigger.eventFields ?? [];
    setWires((prev) => {
      const kept = prev.filter(
        (w) => !(w.from === "trigger" && !eventFields.includes(w.fromOutput)),
      );
      const additions: Wire[] = [];
      for (const f of funcs) {
        for (const p of f.inputs) {
          if (!eventFields.includes(p.name)) continue;
          const wired = kept.some(
            (w) => w.to === f.id && w.toInput === p.name,
          );
          if (!wired) {
            additions.push({
              from: "trigger",
              fromOutput: p.name,
              to: f.id,
              toInput: p.name,
            });
          }
        }
      }
      if (kept.length === prev.length && additions.length === 0) return prev;
      return additions.length ? [...kept, ...additions] : kept;
    });
  }, [funcs, trigger]);

  useEffect(() => {
    setNodes((prev) => {
      const prevPos = new Map(prev.map((n) => [n.id, n.position]));
      const funcNodes = funcs.map((f, i) => {
        const needsConnection =
          !f.pure && f.requires.some((r) => !connectedProviders.has(r.provider));
        const cfg = configValues[f.id] ?? {};
        const inputs = f.inputs.map((p) => {
          const wired = wires.some(
            (w) => w.to === f.id && w.toInput === p.name,
          );
          return {
            name: p.name,
            bound: wired || (cfg[p.name] !== undefined && cfg[p.name] !== ""),
            variable: !wired,
          };
        });
        inputs.sort(
          (a, b) => Number(a.variable ?? false) - Number(b.variable ?? false),
        );
        return buildNode(
          f,
          prevPos.get(f.id) ??
            positionsRef.current[f.id] ?? { x: 360 + i * 340, y: 160 },
          runStatus[f.id],
          needsConnection,
          inputs,
          () => removeNode(f.id),
        );
      });
      const triggerOut = [...new Set([...triggerFields, ...variableFields])];
      if (
        trigger.kind === "manual" ||
        (funcs.length === 0 && triggerOut.length === 0)
      )
        return funcNodes;
      const triggerNode: Node = {
        id: "trigger",
        type: "trigger",
        position:
          prevPos.get("trigger") ??
          positionsRef.current["trigger"] ?? { x: 40, y: 160 },
        data: {
          fields: triggerOut,
          kind: trigger.kind,
          activation,
          busy: actBusy,
          onToggle: toggleActivation,
          nextFireAt:
            scheduling && activation === "active" && fireAnchor != null
              ? (() => {
                  const ms = triggerIntervalMs(trigger);
                  return ms ? fireAnchor + ms : undefined;
                })()
              : undefined,
          cron:
            scheduling &&
            activation === "active" &&
            trigger.kind === "schedule" &&
            trigger.schedule?.mode === "cron"
              ? trigger.schedule.cron
              : undefined,
          fired:
            scheduling && activation === "active" && justFired
              ? fireStatus
              : undefined,
        },
      };
      return [triggerNode, ...funcNodes];
    });
  }, [
    funcs,
    wires,
    configValues,
    runStatus,
    connectedProviders,
    triggerFields,
    variableFields,
    trigger,
    activation,
    actBusy,
    scheduling,
    fireAnchor,
    justFired,
    fireStatus,
    removeNode,
    setNodes,
  ]);

  const rfEdges: Edge[] = useMemo(() => {
    const ids = new Set(funcs.map((f) => f.id));
    const showTrigger = trigger.kind !== "manual";
    if (showTrigger) ids.add("trigger");
    const wireEdges: Edge[] = wires
      .filter((w) => ids.has(w.from) && ids.has(w.to))
      .map((w) => ({
        id: wireKey(w),
        type: "deletable",
        source: w.from,
        target: w.to,
        sourceHandle: w.fromOutput || undefined,
        targetHandle: w.toInput || undefined,
        animated: true,
        style: { stroke: "#6ea8ff" },
        data: {
          canDelete: true,
          onDelete: () => removeWireByKey(wireKey(w)),
          canInsert: true,
          onInsert: () => insertCodeNodeBetween(w),
        },
      }));
    // Trigger-fed inputs are implicit bindings (not wires) — draw them as edges
    // from the trigger node so a webhook/schedule visibly connects to its steps.
    const triggerEdges: Edge[] = [];
    if (showTrigger) {
      for (const f of funcs) {
        for (const p of f.inputs) {
          if (wires.some((w) => w.to === f.id && w.toInput === p.name)) continue;
          triggerEdges.push({
            id: `trigger.${p.name}->${f.id}.${p.name}`,
            type: "deletable",
            source: "trigger",
            target: f.id,
            sourceHandle: p.name,
            targetHandle: p.name,
            animated: true,
            style: { stroke: "#6ea8ff" },
            selectable: false,
            data: { canDelete: false, canInsert: false },
          });
        }
      }
    }
    return [...wireEdges, ...triggerEdges];
  }, [wires, funcs, trigger.kind, removeWireByKey, insertCodeNodeBetween]);

  const reset = () => {
    setFuncs([]);
    setWires([]);
    setSelectedId(null);
    setRunStatus({});
    setRunData({});
    setConfigValues({});
    setNodeConnections({});
    positionsRef.current = {};
    setWorkflowId(null);
    setName("untitled");
    setTrigger({ kind: "manual" });
    setSavedTrigger({ kind: "manual" });
    setInputForm(null);
    setVariables({});
    setPersistedVars({});
    setLoadedConvId(null);
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
      nodeConnections,
      trigger,
      inputForm,
      variables,
      conversationId: conversationId ?? undefined,
    });
    setPersistedVars(variables);
    setWorkflowId(id);
    setSavedTrigger(trigger);
    setStatusVersion((v) => v + 1);
    if (spaceId) {
      void navigate({
        to: "/s/$spaceId/w/$workflowId",
        params: { spaceId, workflowId: id },
      });
    }
  };

  const requestSave = () => {
    if (!requireAuth(() => void save())) return;
    void save();
  };

  const applyVariables = useCallback((vars: Record<string, unknown>) => {
    setVariables(vars);
    setAutoSave(true);
  }, []);

  const setTriggerParam = useCallback((key: string, value: string) => {
    setTrigger((t) => {
      if (t.kind !== "poll" || !t.poll) return t;
      return {
        ...t,
        poll: { ...t.poll, params: { ...(t.poll.params ?? {}), [key]: value } },
      };
    });
    setAutoSave(true);
  }, []);

  const openWorkflow = (id: string) => {
    setActiveTab("chat");
    if (spaceId) {
      void navigate({
        to: "/s/$spaceId/w/$workflowId",
        params: { spaceId, workflowId: id },
      });
    } else {
      void load(id);
    }
  };

  const newWorkflow = () => {
    reset();
    setConversationId(crypto.randomUUID());
    setChatPrompt(null); // never carry a previous flow's prompt into the new one
    setActiveTab("chat");
    if (spaceId) void navigate({ to: "/s/$spaceId", params: { spaceId } });
  };

  useEffect(() => {
    if (!autoSave || funcs.length === 0 || !user) return;
    const t = setTimeout(() => {
      setAutoSave(false);
      void save();
    }, 350);
    return () => clearTimeout(t);
  }, [autoSave, funcs, user, variables, trigger]);

  const load = async (id: string) => {
    const wf = await fetchWorkflow(id);
    positionsRef.current = wf.positions ?? {};
    setSelectedId(null);
    setWires(wf.wires ?? []);
    setFuncs((wf.funcs ?? []).map(normalizeFunc));
    setConfigValues(wf.config ?? {});
    setNodeConnections(wf.nodeConnections ?? {});
    setWorkflowId(wf.id);
    setName(wf.name ?? "untitled");
    setTrigger(wf.trigger ?? { kind: "manual" });
    setSavedTrigger(wf.trigger ?? { kind: "manual" });
    setInputForm(wf.inputForm ?? null);
    setVariables(wf.variables ?? {});
    setPersistedVars(wf.variables ?? {});
    setConversationId(wf.conversationId ?? wf.id);
    setLoadedConvId(wf.conversationId ?? wf.id);
  };

  useEffect(() => {
    if (routeWorkflowId) {
      if (routeWorkflowId !== workflowId) void load(routeWorkflowId);
    } else if (workflowId) {
      reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeWorkflowId]);

  return (
    <div className="flex h-screen w-screen flex-col bg-background text-foreground">
      <div className="p-2 pb-0">
        <header className="flex items-center gap-3 rounded-2xl border border-border/40 bg-muted/40 px-4 py-2">
          {user && <SpaceSwitcher />}
          {user && managed && <PlanChip />}
      
          <div className="ml-auto flex items-center gap-3">
            <LegalLinks />
            <ContactUsLink />
            <Badge variant="secondary" className="font-normal">
              {t("header.funcCount", { n: funcs.length })}
            </Badge>
            <LanguageSwitcher />
            <Button
              size="icon"
              variant="ghost"
              className="h-8 w-8"
              title={
                theme === "dark"
                  ? t("header.switchToLight")
                  : t("header.switchToDark")
              }
              onClick={() => setTheme((prev) => (prev === "dark" ? "light" : "dark"))}
            >
              {theme === "dark" ? (
                <Sun className="h-4 w-4" />
              ) : (
                <Moon className="h-4 w-4" />
              )}
            </Button>
            {user ? (
              <div className="flex items-center gap-1.5">
                <span className="max-w-32 truncate text-xs text-muted-foreground">
                  {user.email}
                </span>
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-8 w-8"
                  title={t("auth.signOut")}
                  onClick={signOut}
                >
                  <LogOut className="h-4 w-4" />
                </Button>
              </div>
            ) : (
              <Button
                size="sm"
                variant="outline"
                className="h-8"
                onClick={() => requireAuth()}
              >
                {t("auth.signIn")}
              </Button>
            )}
          </div>
        </header>
      </div>

      <div className="flex min-h-0 flex-1 gap-2 p-2">
        {user && (
          <div className="flex w-60 shrink-0 flex-col gap-2">
            <div className="min-h-0 flex-1">
              <WorkflowsPanel
                currentId={workflowId}
                onLoad={openWorkflow}
                name={name}
                onName={setName}
                onSave={requestSave}
                saving={saveMutation.isPending}
                canSave={funcs.length > 0}
                onNew={newWorkflow}
              />
            </div>
            <ConnectionsPanel missing={missingProviders} />
          </div>
        )}
        <div className="relative flex min-w-0 flex-1 flex-col overflow-hidden rounded-2xl border border-border/40 bg-card">
          <div className="absolute left-3 top-3 z-10 flex items-center gap-2">
            <div className="flex rounded-lg border border-border/50 bg-muted p-0.5 text-xs">
              {(["story", "pipeline", "graph"] as const).map((v) => (
                <button
                  key={v}
                  onClick={() => setView(v)}
                  className={
                    "rounded-md px-2.5 py-1 capitalize transition-colors " +
                    (view === v
                      ? "bg-background text-foreground"
                      : "text-muted-foreground hover:text-foreground")
                  }
                >
                  {t(`view.${v}`)}
                </button>
              ))}
            </div>
            <button
              onClick={() => setTriggerOpen(true)}
              title={t("header.configureTrigger")}
              className="flex items-center gap-1.5 rounded-lg border border-border/50 bg-muted px-2.5 py-1 text-xs text-foreground/90 transition-colors hover:border-border"
            >
              <Zap className="h-3.5 w-3.5 text-tone-amber-fg" />
              <span>{t(`trigger.kind.${trigger.kind}`)}</span>
            </button>
            {funcs.length > 0 && (
              <button
                onClick={runRepair}
                disabled={repairing}
                title="Eksik bağlantıları AI ile bul ve düzelt"
                className={
                  "flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs transition-colors disabled:opacity-60 " +
                  (wiringIssues.length > 0
                    ? "border-tone-amber/40 bg-tone-amber-surface text-tone-amber-fg hover:border-tone-amber"
                    : "border-border/50 bg-muted text-foreground/90 hover:border-border")
                }
              >
                {repairing ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Wand2 className="h-3.5 w-3.5" />
                )}
                <span>Fix with AI</span>
                {wiringIssues.length > 0 && (
                  <span className="rounded-full bg-tone-amber-fg/20 px-1.5 text-[10px] font-semibold">
                    {wiringIssues.length}
                  </span>
                )}
              </button>
            )}
            <button
              onClick={addCodeNode}
              className="flex items-center gap-1.5 rounded-lg border border-border/50 bg-muted px-2.5 py-1 text-xs text-foreground/90 transition-colors hover:border-border"
            >
              <span>+ Add Node</span>
            </button>
          </div>
          {repairMsg && (
            <div className="pointer-events-none absolute left-1/2 top-12 z-10 -translate-x-1/2">
              <div className="max-w-md truncate rounded-full border border-border/50 bg-card px-3 py-1 text-xs text-foreground shadow">
                {repairMsg}
              </div>
            </div>
          )}
          {missingProviders.length > 0 && (
            <div className="pointer-events-none absolute left-1/2 top-3 z-10 -translate-x-1/2">
              <div className="rounded-full border border-tone-amber/40 bg-tone-amber-surface px-3 py-1 text-xs font-medium text-tone-amber-fg">
                ⚠{" "}
                {t("header.connectionsNeeded", {
                  count: missingProviders.length,
                })}
              </div>
            </div>
          )}
          <div className="min-h-0 flex-1">
            {view === "graph" ? (
              <ReactFlowProvider>
                <Canvas
                  nodes={nodes}
                  edges={rfEdges}
                  onNodesChange={onNodesChange}
                  onSelect={onSelectNode}
                  onConnect={connectNodes}
                  onDeleteNodes={(ds) => {
                    for (const n of ds) {
                      if (n.id !== "trigger") removeNode(n.id);
                    }
                  }}
                  onDeleteEdges={(ds) => {
                    for (const e of ds) removeWireByKey(e.id);
                  }}
                  colorMode={theme}
                />
              </ReactFlowProvider>
            ) : view === "story" ? (
              <Story
                funcs={funcs}
                wires={wires}
                triggerFields={triggerFields}
                runStatus={runStatus}
                connectedProviders={connectedProviders}
                configValues={configValues}
                building={building}
                selectedId={selectedId}
                onSelect={onSelectNode}
                onDeleteNode={removeNode}
              />
            ) : (
              <Pipeline
                funcs={funcs}
                wires={wires}
                triggerFields={triggerFields}
                runStatus={runStatus}
                connectedProviders={connectedProviders}
                configValues={configValues}
                selectedId={selectedId}
                onSelect={onSelectNode}
                onInsertBetween={insertCodeNodeBetween}
                onDeleteNode={removeNode}
                onDeleteEdge={removeWireByKey}
              />
            )}
          </div>
          {funcs.length > 0 && (
            <>
              <div
                onMouseDown={startResize}
                className="group flex h-2 shrink-0 cursor-row-resize items-center justify-center border-t border-border/40"
              >
                <div className="h-0.5 w-8 rounded-full bg-border transition-colors group-hover:bg-foreground/40" />
              </div>
              <div style={{ height: bottomHeight }} className="shrink-0">
                <RunPanel
                  key={workflowId ?? "new"}
                  funcs={funcs}
                  wires={wires}
                  config={configValues}
                  nodeConnections={nodeConnections}
                  workflowId={workflowId}
                  workflowName={name}
                  inputForm={inputForm}
                  onInputForm={setInputForm}
                  variableFields={variableFields}
                  trigger={trigger}
                  savedTrigger={savedTrigger}
                  onTriggerParam={setTriggerParam}
                  variables={variables}
                  onVariables={applyVariables}
                  persistedVars={persistedVars}
                  syncing={formSyncing}
                  selected={selected}
                  theme={theme}
                  onStatus={setRunStatus}
                  onData={setRunData}
                  onRepair={onRepair}
                />
              </div>
            </>
          )}
        </div>
        <RightPanel
          active={activeTab}
          onTab={setActiveTab}
          chat={
            <ChatPanel
              view={chatView}
              conversations={(conversationsQuery.data ?? []).filter((cv) =>
                workflowId
                  ? cv.workflowId === workflowId ||
                    cv.id === conversationId ||
                    cv.id === loadedConvId
                  : true,
              )}
              isLoading={conversationsQuery.isLoading}
              currentId={conversationId}
              onSelect={selectChat}
              onDelete={removeChat}
              onStartPrompt={startChatPrompt}
              chat={
                conversationId ? (
                  <Chat
                    conversationId={conversationId}
                    onBack={() => setChatView("list")}
                    initialPrompt={chatPrompt ?? undefined}
                    onPromptConsumed={() => setChatPrompt(null)}
                    onOps={setOps}
                    onBuilding={setBuilding}
                    workflowState={workflowState}
                    onReady={(send) => {
                      sendChatRef.current = send;
                    }}
                  />
                ) : (
                  <div className="flex h-full w-full items-center justify-center" />
                )
              }
            />
          }
          files={<FilesPanel />}
          logs={<LogsPanel active={activeTab === "logs"} />}
          node={
            <NodePanel
              func={selected}
              connections={selected ? (nodeConnections[selected.id] ?? {}) : {}}
              run={selected ? runData[selected.id] : undefined}
              onConnectionChange={(name, id) =>
                selected && onConnectionChange(selected.id, name, id)
              }
              onFuncChange={updateCodeNode}
              onAddFunc={addCodeNode}
            />
          }
        />
      </div>
      {triggerOpen && (
        <TriggerDialog
          trigger={trigger}
          onChange={setTrigger}
          workflowId={workflowId}
          dirty={trigger.kind !== savedTrigger.kind}
          activation={activation}
          busy={actBusy}
          onToggleActivation={toggleActivation}
          onClose={() => setTriggerOpen(false)}
        />
      )}
    </div>
  );
}
