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
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { Sun, Moon, Zap } from "lucide-react";
import { Chat } from "./Chat";
import { TriggerDialog } from "./TriggerDialog";
import { Pipeline } from "./Pipeline";
import { Story } from "./Story";
import { FuncNode } from "./FuncNode";
import { TriggerNode } from "./TriggerNode";
import { NodePanel } from "./NodePanel";
import { RightPanel, type RightTab } from "./RightPanel";
import { WorkflowsPanel } from "./WorkflowsPanel";
import { SpaceSwitcher } from "./SpaceSwitcher";
import { LanguageSwitcher } from "./LanguageSwitcher";
import { ConnectionsPanel } from "./ConnectionsPanel";
import { ChatHistory } from "./ChatHistory";
import { RunPanel } from "./RunPanel";
import {
  useSaveWorkflow,
  fetchWorkflow,
  generateInputForm,
  useConnections,
  useConversations,
  useDeleteConversation,
  getWorkflowStatus,
  pauseWorkflow,
  resumeWorkflow,
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

const NO_CONNECTIONS: ConnectionMeta[] = [];

const nodeTypes = { func: FuncNode, trigger: TriggerNode };

function buildNode(
  f: AuthoredFunc,
  position: { x: number; y: number },
  status: string | undefined,
  needsConnection: boolean,
  inputs: { name: string; bound: boolean; variable?: boolean }[],
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
    },
  };
}

function Canvas({
  nodes,
  edges,
  onNodesChange,
  onSelect,
  colorMode,
}: {
  nodes: Node[];
  edges: Edge[];
  onNodesChange: OnNodesChange<Node>;
  onSelect: (id: string) => void;
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
      onNodesChange={onNodesChange}
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
  const [loadedConvId, setLoadedConvId] = useState<string | null>(null);
  const [view, setView] = useState<"story" | "pipeline" | "graph">("story");
  const [bottomHeight, setBottomHeight] = useState(256);
  const [building, setBuilding] = useState(false);

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
  const { user, requireAuth, signOut } = useAuth();
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

  const newChat = useCallback(() => {
    setConversationId(crypto.randomUUID());
    setActiveTab("chat");
  }, []);

  const selectChat = useCallback((id: string) => {
    setConversationId(id);
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
        return buildNode(
          f,
          prevPos.get(f.id) ??
            positionsRef.current[f.id] ?? { x: 360 + i * 340, y: 160 },
          runStatus[f.id],
          needsConnection,
          inputs,
        );
      });
      if (
        trigger.kind === "manual" ||
        (funcs.length === 0 && triggerFields.length === 0)
      )
        return funcNodes;
      const triggerNode: Node = {
        id: "trigger",
        type: "trigger",
        position:
          prevPos.get("trigger") ??
          positionsRef.current["trigger"] ?? { x: 40, y: 160 },
        data: {
          fields: triggerFields,
          kind: trigger.kind,
          activation,
          busy: actBusy,
          onToggle: toggleActivation,
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
    trigger,
    activation,
    actBusy,
    setNodes,
  ]);

  const rfEdges: Edge[] = useMemo(() => {
    const ids = new Set(funcs.map((f) => f.id));
    if (trigger.kind !== "manual") ids.add("trigger");
    return wires
      .filter((w) => ids.has(w.from) && ids.has(w.to))
      .map((w) => ({
        id: wireKey(w),
        source: w.from,
        target: w.to,
        sourceHandle: w.fromOutput || undefined,
        targetHandle: w.toInput || undefined,
        animated: true,
        style: { stroke: "#6ea8ff" },
      }));
  }, [wires, funcs, trigger.kind]);

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
          <Badge variant="secondary" className="ml-auto font-normal">
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
            <ConnectionsPanel missing={missingProviders} theme={theme} />
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
          </div>
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
            conversationId ? (
              <Chat
                conversationId={conversationId}
                onNewChat={newChat}
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
          history={
            <ChatHistory
              conversations={(conversationsQuery.data ?? []).filter((cv) =>
                workflowId
                  ? cv.workflowId === workflowId ||
                    cv.id === conversationId ||
                    cv.id === loadedConvId
                  : cv.id === conversationId,
              )}
              isLoading={conversationsQuery.isLoading}
              currentId={conversationId}
              onSelect={selectChat}
              onNew={newChat}
              onDelete={removeChat}
            />
          }
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
