import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  Panel,
  useNodesState,
  useReactFlow,
  type Node,
  type Edge,
  type Connection,
  type OnNodesChange,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  Sun,
  Moon,
  Zap,
  Wand2,
  Loader2,
  Check,
  Network,
  Plug,
  Plus,
} from "lucide-react";
import { detectIssues, repairWiring } from "./health";
import { spaceHeaders } from "./space";
import { VersionsPanel } from "./VersionsPanel";
import { ChangeReview, type ChangeSource } from "./ChangeReview";
import { FilesPanel } from "./FilesPanel";
import { Chat } from "./Chat";
import { TriggerDialog } from "./TriggerDialog";
import { Pipeline } from "./Pipeline";
import { Story } from "./Story";
import { FuncNode } from "./FuncNode";
import { GateEdge } from "./GateEdge";
import { WireEdge } from "./WireEdge";
import { layoutPositions } from "./layout";
import { TriggerNode } from "./TriggerNode";
import { NodePanel } from "./NodePanel";
import { RightPanel, type RightTab } from "./RightPanel";
import { SpaceSwitcher } from "./SpaceSwitcher";
import { PlanChip } from "./PlanChip";
import { LanguageSwitcher } from "./LanguageSwitcher";
import { EnterpriseDialog } from "./EnterpriseDialog";
import { McpConnectDialog } from "./McpConnectDialog";
import { LeftSidebar } from "./LeftSidebar";
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
  useHealth,
  type ConnectionMeta,
  type ActivationState,
} from "./queries";
import { WorkflowStatusIcon } from "./WorkflowStatusIcon";
import type {
  AuthoredFunc,
  InputForm,
  RunStepData,
  TriggerConfig,
  Wire,
  WorkflowOp,
} from "./types";
import { buildWorkflowDoc, stableStringify } from "./workflow-doc";
import { useNavigate } from "@tanstack/react-router";
import { summarizeWorkflow, outputsOf } from "./lineage";
import { useAuth } from "./authContext";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { LogOut } from "lucide-react";

const wireKey = (w: Wire) => `${w.from}.${w.fromOutput}->${w.to}.${w.toInput}`;

const NO_CONNECTIONS: ConnectionMeta[] = [];

const nodeTypes = { func: FuncNode, trigger: TriggerNode };
const edgeTypes = { gate: GateEdge, wire: WireEdge };

function buildNode(
  f: AuthoredFunc,
  position: { x: number; y: number },
  status: string | undefined,
  needsConnection: boolean,
  inputs: { name: string; bound: boolean; variable?: boolean }[],
  needsValue: boolean,
  onDelete?: () => void,
  onAddInput?: (name: string) => void,
  onAddOutput?: (name: string) => void,
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
      needsValue,
      gated: !!f.gate,
      inputs,
      outputs: outputsOf(f),
      onDelete,
      onAddInput,
      onAddOutput,
    },
  };
}

const FIELD_BAD = /[^A-Za-z0-9_$]/g;
function sanitizeField(raw: string): string {
  const s = raw.trim().replace(FIELD_BAD, "_");
  return /^[0-9]/.test(s) ? `_${s}` : s;
}

// Add a usable `const <name> = input.<name>;` to the top of the step body so the
// input port is derived by the normalize pass (code stays the source of truth).
function insertInputRef(body: string, name: string): string {
  const m = body.match(/=>\s*\{|\)\s*\{/);
  if (m && m.index !== undefined) {
    const at = m.index + m[0].length;
    return `${body.slice(0, at)}\n  const ${name} = input.${name};${body.slice(at)}`;
  }
  return `${body}\n// input.${name}`;
}

// Add a field to the step's returned object so the output port appears.
function insertOutputField(body: string, name: string): string | null {
  const m = body.match(/return\s*\{/);
  if (!m || m.index === undefined) return null;
  const at = m.index + m[0].length;
  return `${body.slice(0, at)} ${name}: null,${body.slice(at)}`;
}

function Canvas({
  nodes,
  edges,
  onNodesChange,
  onConnect,
  isValidConnection,
  onSelect,
  onArrange,
  onAddStep,
  colorMode,
}: {
  nodes: Node[];
  edges: Edge[];
  onNodesChange: OnNodesChange<Node>;
  onConnect: (c: Connection) => void;
  isValidConnection: (c: Connection | Edge) => boolean;
  onSelect: (id: string) => void;
  onArrange: () => void;
  onAddStep: () => void;
  colorMode: "dark" | "light";
}) {
  const { fitView } = useReactFlow();
  const { t } = useTranslation();
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
      isValidConnection={isValidConnection}
      fitView
      fitViewOptions={{ padding: 0.28 }}
      colorMode={colorMode}
      onNodeClick={(_, node) => onSelect(node.id)}
    >
      <Background />
      <Controls />
      <Panel
        position="top-left"
        style={{ marginLeft: "0.75rem", marginTop: "0.75rem" }}
      >
        <button
          onClick={onAddStep}
          title={t("canvas.addStep")}
          className="flex items-center gap-1.5 rounded-lg border border-border/50 bg-muted px-2.5 py-1 text-xs font-medium text-foreground/90 shadow-sm transition-colors hover:border-border"
        >
          <Plus className="h-3.5 w-3.5" />
          {t("canvas.addStep")}
        </button>
      </Panel>
      {nodes.length > 1 && (
        // sit just left of the monitoring entry pill (absolute right-3 top-3),
        // top-aligned to it (marginTop matches the pill's top-3), tight gap
        <Panel position="top-right" style={{ marginRight: "7rem", marginTop: "0.75rem" }}>
          <button
            onClick={() => {
              onArrange();
              setTimeout(() => fitView({ duration: 400, padding: 0.28 }), 60);
            }}
            title={t("canvas.autoArrange")}
            className="flex items-center gap-1.5 rounded-lg border border-border/50 bg-muted px-2.5 py-1 text-xs text-foreground/90 transition-colors hover:border-border"
          >
            <Network className="h-3.5 w-3.5" />
            {t("canvas.autoArrange")}
          </button>
        </Panel>
      )}
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
  // Last-persisted snapshot of the workflow doc (stable-stringified). `dirty` is
  // derived by comparing the live doc to this — see the autosave funnel below.
  const persistedDoc = useRef<string>("");
  const [leftPanelMinimized, setLeftPanelMinimized] = useState(() => {
    try {
      return localStorage.getItem("leftPanelMinimized") === "true";
    } catch {
      return false;
    }
  });
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

  useEffect(() => {
    try {
      localStorage.setItem("leftPanelMinimized", String(leftPanelMinimized));
    } catch {
      void 0;
    }
  }, [leftPanelMinimized]);
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
  const { user, requireAuth, signOut, managed, remoteMcp } = useAuth();
  const [mcpOpen, setMcpOpen] = useState(false);
  const [openSource, setOpenSource] = useState<ChangeSource | null>(null);
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
        if (p.role === "config") continue;
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
  const flowHealth = useHealth(workflowId);
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
        nodeId: string;
        error: string;
        callSite: string;
        sampleInput: string;
        declaredInputs: string[];
      },
    ) => {
      setActiveTab("chat");
      // Find declared inputs that are MISSING from the resolved input, and for
      // each, surface its upstream PRODUCER (its last output + code). A missing
      // wired input usually means the producer returned undefined (e.g. a wrong
      // payload path) — giving the AI the producer's actual output + body lets it
      // fix the real culprit instead of looping asking the user for data the
      // workflow already received.
      let resolved: Record<string, unknown> = {};
      try {
        resolved = JSON.parse(ctx.sampleInput) as Record<string, unknown>;
      } catch {
        void 0;
      }
      const missing = ctx.declaredInputs.filter((n) => !(n in resolved));
      const upstream: string[] = [];
      for (const inp of missing) {
        const w = wires.find((x) => x.to === ctx.nodeId && x.toInput === inp);
        if (!w || w.from === "trigger") continue;
        const prod = funcs.find((f) => f.id === w.from);
        const out = runData[w.from]?.output;
        upstream.push(
          `- input "${inp}" is wired from ${w.from}.${w.fromOutput}. ${w.from}'s last output was: ${
            out !== undefined ? JSON.stringify(out) : "(no output recorded)"
          }.${prod?.bodySource ? `\n  ${w.from} code:\n${prod.bodySource}` : ""}`,
        );
      }
      const msg = [
        `A workflow step failed.`,
        `Error: "${ctx.error}"`,
        `Provider: "${provider}".`,
        `The step declares these inputs: ${ctx.declaredInputs.length ? ctx.declaredInputs.join(", ") : "(none)"}.`,
        `The step's resolved input was: ${ctx.sampleInput}`,
        missing.length
          ? `MISSING inputs (declared but absent from the resolved input): ${missing.join(", ")}. These are wired from upstream steps, so the producer likely returned undefined — inspect the producer(s) below and fix the step whose output is empty (often a wrong payload/field path). Do NOT ask the user for data the workflow already received.`
          : "",
        upstream.length ? `Upstream producers feeding the missing inputs:\n${upstream.join("\n")}` : "",
        ctx.callSite ? `It calls the provider like this:\n${ctx.callSite}` : "",
        `Diagnose whether this is a provider bug or a flow problem (the step not receiving its input), then act per your rules.`,
      ]
        .filter(Boolean)
        .join("\n\n");
      sendChatRef.current?.(msg);
    },
    [wires, funcs, runData],
  );

  const onConfigChange = useCallback(
    (funcId: string, port: string, value: string) => {
      setConfigValues((prev) => ({
        ...prev,
        [funcId]: { ...(prev[funcId] ?? {}), [port]: value },
      }));
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
          for (const f of o.funcs) map.set(f.id, f);
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
  }, [ops]);

  // Picking an upstream output / trigger field from the code editor's `input.`
  // autocomplete: create the wire AND ensure the target input port exists, so the
  // value actually reaches `input.<name>` at runtime.
  const onWireInput = useCallback(
    (p: {
      funcId: string;
      inputName: string;
      from: string;
      fromOutput: string;
    }) => {
      setWires((prev) => {
        const w: Wire = {
          from: p.from,
          fromOutput: p.fromOutput,
          to: p.funcId,
          toInput: p.inputName,
        };
        const map = new Map(prev.map((x) => [wireKey(x), x]));
        map.set(wireKey(w), w);
        return [...map.values()];
      });
      setFuncs((prev) =>
        prev.map((f) =>
          f.id === p.funcId && !f.inputs.some((i) => i.name === p.inputName)
            ? {
                ...f,
                inputs: [
                  ...f.inputs,
                  {
                    name: p.inputName,
                    role: "input",
                    type: "string",
                    required: true,
                  },
                ],
              }
            : f,
        ),
      );
      // No explicit dirty flag needed — the derived-doc autosave funnel below
      // picks up the funcs/wires change and debounce-saves.
    },
    [],
  );

  // Diagnostics from the last normalize ("input X removed", "wire Y dropped"),
  // shown as a dismissible lint banner in the editor.
  const [lintDiag, setLintDiag] = useState<string[]>([]);
  const clearLint = useCallback(() => setLintDiag([]), []);

  // After a manual code edit, ask the server to deterministically re-derive ports
  // and drop wires/gates that reference fields the edited code no longer exposes,
  // then apply the cleaned graph. Keeps hand-edits as consistent as AI builds.
  const normalizeAndApply = useCallback(
    async (nextFuncs: AuthoredFunc[], nextWires: Wire[]) => {
      try {
        const res = await fetch("/api/workflows/normalize", {
          method: "POST",
          headers: { "Content-Type": "application/json", ...spaceHeaders() },
          body: JSON.stringify({
            funcs: nextFuncs,
            wires: nextWires,
            eventFields: trigger.eventFields ?? [],
          }),
        });
        if (!res.ok) return;
        const data = (await res.json()) as {
          funcs: AuthoredFunc[];
          wires: Wire[];
          diagnostics: string[];
        };
        setFuncs(data.funcs);
        setWires(data.wires);
        setLintDiag(data.diagnostics ?? []);
      } catch {
        // network/normalize failure → keep the optimistic local edit as-is
      }
    },
    [trigger.eventFields],
  );

  // --- Canvas manual editing: add/remove edges, add/delete steps -------------
  const removeWire = useCallback((wk: string) => {
    setWires((prev) => prev.filter((w) => wireKey(w) !== wk));
  }, []);

  const onConnect = useCallback((c: Connection) => {
    if (!c.source || !c.target || !c.sourceHandle || !c.targetHandle) return;
    if (c.source === c.target) return;
    const wire: Wire = {
      from: c.source,
      fromOutput: c.sourceHandle,
      to: c.target,
      toInput: c.targetHandle,
    };
    setWires((prev) => {
      if (prev.some((w) => wireKey(w) === wireKey(wire))) return prev;
      // an input takes a single source: replace any existing wire into it
      const cleaned = prev.filter(
        (w) => !(w.to === wire.to && w.toInput === wire.toInput),
      );
      return [...cleaned, wire];
    });
  }, []);

  const isValidConnection = useCallback(
    (c: Connection | Edge) => {
      const source = c.source;
      const target = c.target;
      if (!source || !target || source === target) return false;
      if (source === "trigger") return true; // trigger has no inbound edges
      // reject if it would create a cycle (target can already reach source)
      const adj = new Map<string, Set<string>>();
      for (const w of wires) {
        if (!adj.has(w.from)) adj.set(w.from, new Set());
        adj.get(w.from)!.add(w.to);
      }
      const seen = new Set<string>();
      const stack = [target];
      while (stack.length) {
        const cur = stack.pop()!;
        if (cur === source) return false;
        if (seen.has(cur)) continue;
        seen.add(cur);
        for (const n of adj.get(cur) ?? []) stack.push(n);
      }
      return true;
    },
    [wires],
  );

  const addStep = useCallback(() => {
    const id = `step_${crypto.randomUUID().slice(0, 8)}`;
    const stub: AuthoredFunc = {
      id,
      title: "New step",
      summary: "",
      version: 1,
      kind: "adapter",
      pure: true,
      inputs: [],
      outputSchema: { type: "object", properties: {}, required: [] },
      bodySource: "export default async (ctx, input) => {\n  return {};\n}",
      requires: [],
      dangerClass: "benign",
      idempotency: null,
    };
    setFuncs((prev) => [...prev, stub]);
    setSelectedId(id);
  }, []);

  const deleteNode = useCallback((id: string) => {
    setFuncs((prev) =>
      prev
        .filter((f) => f.id !== id)
        .map((f) =>
          f.gate?.ref && String(f.gate.ref).startsWith(`${id}.`)
            ? { ...f, gate: undefined }
            : f,
        ),
    );
    setWires((prev) => prev.filter((w) => w.from !== id && w.to !== id));
    setSelectedId((cur) => (cur === id ? null : cur));
  }, []);

  // Apply a step code change then re-derive ports/wires via the normalize pass.
  const updateFuncCode = useCallback(
    (funcId: string, bodySource: string) => {
      const updated = funcs.map((f) =>
        f.id === funcId ? { ...f, bodySource } : f,
      );
      setFuncs(updated);
      void normalizeAndApply(updated, wires);
    },
    [funcs, wires, normalizeAndApply],
  );

  // "+ input" / "+ output" on a node: write the matching code (a const reference
  // / a return field), then normalize derives the port. No raw code typing.
  const addInputToFunc = useCallback(
    (funcId: string, rawName: string) => {
      const name = sanitizeField(rawName);
      if (!name) return;
      const f = funcs.find((x) => x.id === funcId);
      if (!f || f.inputs.some((i) => i.name === name)) return;
      updateFuncCode(funcId, insertInputRef(f.bodySource, name));
    },
    [funcs, updateFuncCode],
  );

  const addOutputToFunc = useCallback(
    (funcId: string, rawName: string) => {
      const name = sanitizeField(rawName);
      if (!name) return;
      const f = funcs.find((x) => x.id === funcId);
      if (!f || outputsOf(f).includes(name)) return;
      const next = insertOutputField(f.bodySource, name);
      if (next) updateFuncCode(funcId, next);
      else
        setLintDiag([
          `Couldn't add output "${name}" automatically — make the step end with a "return { ... }" object.`,
        ]);
    },
    [funcs, updateFuncCode],
  );

  // Provider method names for ctx.connections.<provider>.<method> autocomplete.
  const [providerMethods, setProviderMethods] = useState<
    Record<string, string[]>
  >({});
  const providerIdsKey = useMemo(
    () =>
      [...new Set(funcs.flatMap((f) => f.requires.map((r) => r.provider)))]
        .filter(Boolean)
        .sort()
        .join(","),
    [funcs],
  );
  useEffect(() => {
    const ids = providerIdsKey ? providerIdsKey.split(",") : [];
    if (!ids.length) {
      setProviderMethods({});
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/providers/methods", {
          method: "POST",
          headers: { "Content-Type": "application/json", ...spaceHeaders() },
          body: JSON.stringify({ ids }),
        });
        if (!res.ok) return;
        const data = (await res.json()) as Record<string, string[]>;
        if (!cancelled) setProviderMethods(data);
      } catch {
        // ignore — autocomplete just won't have method names
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [providerIdsKey]);

  useEffect(() => {
    const eventFields = trigger.eventFields ?? [];
    setWires((prev) => {
      const kept = prev.filter(
        (w) => !(w.from === "trigger" && !eventFields.includes(w.fromOutput)),
      );
      const additions: Wire[] = [];
      for (const f of funcs) {
        for (const p of f.inputs) {
          if (p.role === "config" || !eventFields.includes(p.name)) continue;
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
      // graph-aware fallback for nodes the user hasn't placed yet: dependency
      // depth on X, crossing-minimised order on Y (replaces the old index row).
      const layout = layoutPositions(funcs, wires, trigger);
      const funcNodes = funcs.map((f, i) => {
        const needsConnection =
          !f.pure && f.requires.some((r) => !connectedProviders.has(r.provider));
        const cfg = configValues[f.id] ?? {};
        const inputs = f.inputs.map((p) => {
          const wired = wires.some(
            (w) => w.to === f.id && w.toInput === p.name,
          );
          const isConfig = p.role === "config";
          return {
            name: p.name,
            bound: wired || (cfg[p.name] !== undefined && cfg[p.name] !== ""),
            variable: !wired && !isConfig,
          };
        });
        inputs.sort(
          (a, b) => Number(a.variable ?? false) - Number(b.variable ?? false),
        );
        // a required config left empty blocks the run; flag it on the node so a
        // collapsed node still shows it needs a value (filled in the input tab).
        const needsValue = f.inputs.some(
          (p) =>
            p.role === "config" &&
            p.required &&
            (cfg[p.name] === undefined || cfg[p.name] === ""),
        );
        return buildNode(
          f,
          prevPos.get(f.id) ??
            positionsRef.current[f.id] ??
            layout[f.id] ?? { x: 360 + i * 340, y: 160 },
          runStatus[f.id],
          needsConnection,
          inputs,
          needsValue,
          () => deleteNode(f.id),
          (n) => addInputToFunc(f.id, n),
          (n) => addOutputToFunc(f.id, n),
        );
      });
      // The trigger node only exposes the actual event-data fields it carries —
      // NOT the user-provided form values (those are global state, entered by the
      // user, never emitted by the trigger).
      const triggerOut = [...new Set(triggerFields)];
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
          positionsRef.current["trigger"] ??
          layout["trigger"] ?? { x: 40, y: 160 },
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
    setNodes,
    deleteNode,
    addInputToFunc,
    addOutputToFunc,
  ]);

  const rfEdges: Edge[] = useMemo(() => {
    const ids = new Set(funcs.map((f) => f.id));
    const showTrigger = trigger.kind !== "manual";
    if (showTrigger) ids.add("trigger");
    const wireEdges: Edge[] = wires
      .filter((w) => ids.has(w.from) && ids.has(w.to))
      .map((w) => ({
        id: wireKey(w),
        source: w.from,
        target: w.to,
        sourceHandle: w.fromOutput || undefined,
        targetHandle: w.toInput || undefined,
        type: "wire",
        animated: true,
        style: { stroke: "#6ea8ff" },
        data: { onDelete: () => removeWire(wireKey(w)) },
      }));
    // Trigger-fed inputs are implicit bindings (not wires) — draw them as edges
    // from the trigger node. ONLY the actual event-data fields (trigger.eventFields,
    // e.g. `payload` for a webhook) come from the trigger. Every OTHER unwired
    // input is a user-provided value (global state / input form) and must NOT be
    // wired to the trigger.
    const eventFields = trigger.eventFields ?? [];
    const triggerEdges: Edge[] = [];
    if (showTrigger) {
      for (const f of funcs) {
        for (const p of f.inputs) {
          if (p.role === "config") continue;
          if (!eventFields.includes(p.name)) continue;
          if (wires.some((w) => w.to === f.id && w.toInput === p.name)) continue;
          triggerEdges.push({
            id: `trigger.${p.name}->${f.id}.${p.name}`,
            source: "trigger",
            target: f.id,
            sourceHandle: p.name,
            targetHandle: p.name,
            animated: true,
            style: { stroke: "#6ea8ff" },
          });
        }
      }
    }
    // Conditional gate edges: a gated step runs only when an upstream decision
    // output matches. Draw a dashed amber edge from the decision to the gated
    // step, labelled with the condition, so the branch is visible.
    const gateEdges: Edge[] = [];
    for (const f of funcs) {
      if (!f.gate?.ref) continue;
      const [srcId, , field] = String(f.gate.ref).split(".");
      if (!ids.has(srcId)) continue;
      // The "if" prefix is rendered by the GateEdge chip itself.
      const label =
        f.gate.equals !== undefined
          ? `${field} = ${String(f.gate.equals)}`
          : f.gate.truthy === false
            ? `not ${field}`
            : field;
      gateEdges.push({
        id: `gate.${srcId}.${field}->${f.id}`,
        source: srcId,
        target: f.id,
        sourceHandle: field || undefined,
        type: "gate",
        animated: false,
        data: { label },
      });
    }
    return [...wireEdges, ...triggerEdges, ...gateEdges];
  }, [wires, funcs, trigger.kind, trigger.eventFields, removeWire]);

  // Re-run the graph layout for ALL nodes (overrides manual positions on demand).
  const arrangeLayout = useCallback(() => {
    const pos = layoutPositions(funcs, wires, trigger);
    positionsRef.current = { ...positionsRef.current, ...pos };
    setNodes((ns) =>
      ns.map((n) => (pos[n.id] ? { ...n, position: pos[n.id] } : n)),
    );
  }, [funcs, wires, trigger, setNodes]);

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
    persistedDoc.current = ""; // fresh workflow: baseline empty until first save
  };

  // ── Autosave funnel ───────────────────────────────────────────────────────
  // Everything persisted is derived into one `doc`; any change to it flips
  // `dirty`, and the single debounced effect below saves. No mutation site has
  // to mark dirty — add a field to buildWorkflowDoc and it's covered.
  const positions = useMemo(
    () =>
      Object.fromEntries(nodes.map((n) => [n.id, n.position])) as Record<
        string,
        { x: number; y: number }
      >,
    [nodes],
  );
  const doc = useMemo(
    () =>
      buildWorkflowDoc({
        name,
        funcs,
        wires,
        positions,
        config: configValues,
        nodeConnections,
        trigger,
        inputForm,
        variables,
      }),
    [
      name,
      funcs,
      wires,
      positions,
      configValues,
      nodeConnections,
      trigger,
      inputForm,
      variables,
    ],
  );
  const serializedDoc = useMemo(() => stableStringify(doc), [doc]);
  const dirty = serializedDoc !== persistedDoc.current;

  const save = async () => {
    const id = workflowId ?? crypto.randomUUID();
    const snapshot = serializedDoc; // capture: state may change during the await
    await saveMutation.mutateAsync({
      id,
      ...doc,
      conversationId: conversationId ?? undefined,
    });
    persistedDoc.current = snapshot;
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

  const applyVariables = useCallback((vars: Record<string, unknown>) => {
    setVariables(vars);
  }, []);

  const setTriggerParam = useCallback((key: string, value: string) => {
    setTrigger((t) => {
      if (t.kind !== "poll" || !t.poll) return t;
      return {
        ...t,
        poll: { ...t.poll, params: { ...(t.poll.params ?? {}), [key]: value } },
      };
    });
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

  // The ONE autosave point: any change to the derived doc → debounced save.
  // Guards: a logged-in user, an actual change, not an empty brand-new workflow,
  // and no save already in flight (avoid overlap — the next change catches up).
  useEffect(() => {
    if (!user || !dirty) return;
    if (!workflowId && funcs.length === 0) return;
    if (saveMutation.isPending) return;
    const t = setTimeout(() => void save(), 350);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serializedDoc, dirty, user, workflowId, funcs.length, saveMutation.isPending]);

  const load = async (id: string) => {
    const wf = await fetchWorkflow(id);
    positionsRef.current = wf.positions ?? {};
    setSelectedId(null);
    setWires(wf.wires ?? []);
    setFuncs(wf.funcs ?? []);
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
    // Seed the baseline so a freshly loaded workflow isn't seen as dirty (no
    // spurious save-on-open). Built the same way as the live doc so they match.
    persistedDoc.current = stableStringify(
      buildWorkflowDoc({
        name: wf.name ?? "untitled",
        funcs: wf.funcs ?? [],
        wires: wf.wires ?? [],
        positions: wf.positions ?? {},
        config: wf.config ?? {},
        nodeConnections: wf.nodeConnections ?? {},
        trigger: wf.trigger ?? { kind: "manual" },
        inputForm: wf.inputForm ?? null,
        variables: wf.variables ?? {},
      }),
    );
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
        <header className="flex items-center gap-3 rounded-2xl border border-border/40 bg-muted/40 px-2 py-2">
          {user && <SpaceSwitcher />}
          {user && managed && <PlanChip />}
      
          <div className="ml-auto flex items-center gap-3">
            <ContactUsLink />
            <Badge variant="secondary" className="font-normal">
              {t("header.funcCount", { n: funcs.length })}
            </Badge>
            {user && (workflowId || funcs.length > 0) && (
              <span
                className="flex items-center gap-1.5 text-xs text-muted-foreground"
                title={
                  dirty || saveMutation.isPending
                    ? t("common.saving")
                    : t("common.saved")
                }
              >
                {dirty || saveMutation.isPending ? (
                  <>
                    <Loader2 className="h-3.5 w-3.5 animate-spin text-amber-500" />
                    <span className="hidden sm:inline">{t("common.saving")}</span>
                  </>
                ) : (
                  <>
                    <Check className="h-3.5 w-3.5 text-green-500" />
                    <span className="hidden sm:inline">{t("common.saved")}</span>
                  </>
                )}
              </span>
            )}
            {user && remoteMcp && (
              <Button
                size="sm"
                variant="ghost"
                className="h-8 gap-1.5 px-2"
                title={t("mcp.title")}
                onClick={() => setMcpOpen(true)}
              >
                <Plug className="h-4 w-4" />
                <span className="hidden text-xs sm:inline">{t("mcp.title")}</span>
              </Button>
            )}
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
                {managed === true && (
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-8 w-8"
                    title={t("auth.signOut")}
                    onClick={signOut}
                  >
                    <LogOut className="h-4 w-4" />
                  </Button>
                )}
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

      {mcpOpen && <McpConnectDialog onClose={() => setMcpOpen(false)} />}
      {openSource && workflowId && (
        <ChangeReview
          source={openSource}
          workflowId={workflowId}
          onClose={() => setOpenSource(null)}
          onApplied={() => void load(workflowId)}
        />
      )}

      <div className="flex min-h-0 flex-1 gap-2 p-2">
        {user && (
          <LeftSidebar
            minimized={leftPanelMinimized}
            onMinimize={() => setLeftPanelMinimized(true)}
            onExpand={() => setLeftPanelMinimized(false)}
            currentId={workflowId}
            onLoad={openWorkflow}
            name={name}
            onName={setName}
            onNew={newWorkflow}
            missing={missingProviders}
          />
        )}
        <div className="relative flex min-w-0 flex-1 flex-col overflow-hidden rounded-2xl border border-border/40 bg-card">
          {workflowId && (
            <div className="absolute right-3 top-3 z-10">
              <WorkflowStatusIcon
                health={flowHealth.data}
                onClick={() =>
                  spaceId &&
                  void navigate({
                    to: "/s/$spaceId/w/$workflowId/monitor",
                    params: { spaceId, workflowId },
                  })
                }
              />
            </div>
          )}
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
                  onConnect={onConnect}
                  isValidConnection={isValidConnection}
                  onSelect={onSelectNode}
                  onArrange={arrangeLayout}
                  onAddStep={addStep}
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
                  onConfigChange={onConfigChange}
                  savePending={dirty || saveMutation.isPending}
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
                  onUpdateFuncCode={updateFuncCode}
                  onWireInput={onWireInput}
                  providerMethods={providerMethods}
                  lintDiag={lintDiag}
                  onClearLint={clearLint}
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
                    triggerKind={trigger.kind}
                    eventFields={trigger.eventFields ?? []}
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
          versions={<VersionsPanel workflowId={workflowId} onOpen={(v) => setOpenSource({ kind: "version", version: v })} />}
          node={
            <NodePanel
              func={selected}
              config={selected ? (configValues[selected.id] ?? {}) : {}}
              connections={selected ? (nodeConnections[selected.id] ?? {}) : {}}
              run={selected ? runData[selected.id] : undefined}
              onConfigChange={(port, value) =>
                selected && onConfigChange(selected.id, port, value)
              }
              onConnectionChange={(name, id) =>
                selected && onConnectionChange(selected.id, name, id)
              }
              savePending={dirty || saveMutation.isPending}
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
