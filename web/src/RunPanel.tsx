import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { RefreshCw, Loader2, Check, Pencil } from "lucide-react";
import { ArrayEditorDialog } from "./ArrayEditorDialog";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { AuthoredFunc, InputForm, RunStepData, TriggerConfig, Wire } from "./types";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { spaceHeaders } from "./space";
import { useAuth } from "./authContext";
import {
  useRuns,
  fetchRun,
  generateInputForm,
  fetchProviderSource,
  useFiles,
  type ProviderSource,
} from "./queries";
import { CodeBlock } from "./CodeBlock";

interface RunRecord {
  nodeId: string;
  status: string;
  output?: unknown;
  error?: string;
  resolvedInput?: unknown;
}

const STATUS_DOT: Record<string, string> = {
  done: "bg-emerald-500",
  failed: "bg-rose-500",
  pending: "bg-amber-500 animate-pulse",
  skipped: "bg-muted-foreground/40",
};

function pretty(v: unknown): string {
  if (v === undefined) return "";
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

function SaveDot({ cur, saved }: { cur: string; saved: boolean }) {
  if (!saved) return <Loader2 className="h-3.5 w-3.5 animate-spin text-rose-400" />;
  if (cur !== "") return <Check className="h-3.5 w-3.5 text-emerald-400" />;
  return null;
}

export function RunPanel({
  funcs,
  wires,
  config,
  nodeConnections,
  workflowId,
  workflowName,
  inputForm,
  onInputForm,
  variableFields,
  trigger,
  savedTrigger,
  onTriggerParam,
  variables,
  onVariables,
  persistedVars,
  syncing,
  selected,
  theme,
  onStatus,
  onData,
  onRepair,
  onConfigChange,
}: {
  funcs: AuthoredFunc[];
  wires: Wire[];
  config: Record<string, Record<string, string>>;
  onConfigChange: (funcId: string, port: string, value: string) => void;
  nodeConnections: Record<string, Record<string, string>>;
  workflowId: string | null;
  workflowName: string;
  inputForm: InputForm | null;
  onInputForm: (form: InputForm | null) => void;
  variableFields: string[];
  trigger: TriggerConfig;
  savedTrigger: TriggerConfig;
  onTriggerParam: (key: string, value: string) => void;
  variables: Record<string, unknown>;
  onVariables: (vars: Record<string, unknown>) => void;
  persistedVars: Record<string, unknown>;
  syncing: boolean;
  selected: AuthoredFunc | null;
  theme: "dark" | "light";
  onStatus: (status: Record<string, string>) => void;
  onData: (data: Record<string, RunStepData>) => void;
  onRepair: (
    provider: string,
    ctx: {
      nodeId: string;
      error: string;
      callSite: string;
      sampleInput: string;
      declaredInputs: string[];
    },
  ) => void;
}) {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const { requireAuth } = useAuth();
  const runsQuery = useRuns(workflowId);
  const { data: filesData } = useFiles();
  const files = filesData ?? [];
  const fileFields = useMemo(
    () =>
      new Set(
        funcs.flatMap((f) =>
          f.inputs.filter((i) => i.type === "file").map((i) => i.name),
        ),
      ),
    [funcs],
  );
  const [input, setInput] = useState("{}");
  const [records, setRecords] = useState<RunRecord[]>([]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadingRun, setLoadingRun] = useState<string | null>(null);
  const [currentRunId, setCurrentRunId] = useState<string | null>(null);
  const [tab, setTab] = useState<
    "input" | "state" | "runs" | "code" | "provider"
  >("input");
  const [nodeView, setNodeView] = useState<string>("");
  const [provView, setProvView] = useState<string>("");
  const [provSource, setProvSource] = useState<ProviderSource | null>(null);
  const [provLoading, setProvLoading] = useState(false);
  const [formValues, setFormValues] = useState<Record<string, unknown>>(() => ({
    ...variables,
  }));
  const [inputMode, setInputMode] = useState<"form" | "json">("form");
  const [regenerating, setRegenerating] = useState(false);
  const [editingArray, setEditingArray] = useState<string | null>(null);

  useEffect(() => {
    if (!inputForm) return;
    setFormValues((prev) => {
      const next = { ...prev };
      for (const f of inputForm.fields) {
        if (next[f.name] === undefined)
          next[f.name] =
            f.control === "array"
              ? []
              : (f.defaultValue ?? (f.control === "toggle" ? "false" : ""));
      }
      return next;
    });
  }, [inputForm]);

  const persistInput = (fv: Record<string, unknown>) => {
    const next = { ...variables };
    for (const f of inputForm?.fields ?? [])
      next[f.name] = fv[f.name] ?? (f.control === "array" ? [] : "");
    onVariables(next);
  };

  const setField = (name: string, value: unknown) => {
    const next = { ...formValues, [name]: value };
    setFormValues(next);
    persistInput(next);
  };

  const buildFormInput = (): Record<string, unknown> => {
    const obj: Record<string, unknown> = {};
    if (!inputForm) return obj;
    for (const f of inputForm.fields) {
      if (f.control === "array") {
        obj[f.name] = Array.isArray(formValues[f.name])
          ? formValues[f.name]
          : [];
        continue;
      }
      const v = formValues[f.name] ?? f.defaultValue ?? "";
      if (f.control === "toggle") {
        obj[f.name] = v === "true";
      } else if (f.control === "number") {
        if (v === "") continue;
        const n = Number(v);
        obj[f.name] = Number.isNaN(n) ? v : n;
      } else {
        if (v === "" && !f.required) continue;
        obj[f.name] = v;
      }
    }
    return obj;
  };

  const regenerate = async () => {
    setRegenerating(true);
    setError(null);
    try {
      const hints: Record<string, string> = {};
      for (const f of funcs) {
        for (const p of f.inputs) {
          if (variableFields.includes(p.name) && f.title) hints[p.name] = f.title;
        }
      }
      const form = await generateInputForm(workflowName, variableFields, hints);
      onInputForm(form);
      setInputMode("form");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRegenerating(false);
    }
  };

  const useForm = !!inputForm && inputForm.fields.length > 0;

  const providers = [
    ...new Set(funcs.flatMap((f) => f.requires.map((r) => r.provider))),
  ];
  const activeProv =
    provView && providers.includes(provView) ? provView : (providers[0] ?? "");
  useEffect(() => {
    if (!activeProv) {
      setProvSource(null);
      return;
    }
    let cancelled = false;
    setProvLoading(true);
    fetchProviderSource(activeProv)
      .then((d) => !cancelled && setProvSource(d))
      .catch(() => !cancelled && setProvSource(null))
      .finally(() => !cancelled && setProvLoading(false));
    return () => {
      cancelled = true;
    };
  }, [activeProv]);


  const formNames = new Set((inputForm?.fields ?? []).map((f) => f.name));
  const fieldNamesByNode = new Map<string, Set<string>>();
  for (const f of funcs) {
    for (const p of f.inputs) {
      if (p.role === "config" || !formNames.has(p.name)) continue;
      if (wires.some((w) => w.to === f.id && w.toInput === p.name)) continue;
      let set = fieldNamesByNode.get(f.id);
      if (!set) {
        set = new Set();
        fieldNamesByNode.set(f.id, set);
      }
      set.add(p.name);
    }
  }
  // config inputs are per-node settings (each node keeps its own value, so two
  // nodes can both have a `channelId` without colliding). Surface them in the
  // SAME per-node input form as the global fields, so every value the user
  // provides lives in one place — never a separate red thing on the node.
  const configByNode = new Map<string, AuthoredFunc["inputs"]>();
  for (const f of funcs) {
    const cfgs = f.inputs.filter((p) => p.role === "config");
    if (cfgs.length) configByNode.set(f.id, cfgs);
  }
  const nodesWithFields = funcs.filter(
    (f) =>
      (fieldNamesByNode.get(f.id)?.size ?? 0) > 0 ||
      (configByNode.get(f.id)?.length ?? 0) > 0,
  );
  const titleCounts = new Map<string, number>();
  for (const f of nodesWithFields) {
    const base = f.title || f.id;
    titleCounts.set(base, (titleCounts.get(base) ?? 0) + 1);
  }
  const triggerHasSettings =
    trigger.kind === "poll" && (trigger.poll?.paramNames?.length ?? 0) > 0;
  const views: { id: string; label: string }[] = [
    ...(triggerHasSettings
      ? [{ id: "__trigger", label: t("trigger.title") }]
      : []),
    ...nodesWithFields.map((f) => {
      const base = f.title || f.id;
      return {
        id: f.id,
        label: (titleCounts.get(base) ?? 0) > 1 ? `${base} · ${f.id.slice(0, 4)}` : base,
      };
    }),
  ];
  const activeNode =
    nodeView && views.some((v) => v.id === nodeView)
      ? nodeView
      : (views[0]?.id ?? "");
  const visibleFields =
    activeNode === "__trigger"
      ? []
      : (inputForm?.fields ?? []).filter((f) =>
          fieldNamesByNode.get(activeNode)?.has(f.name),
        );
  const visibleConfig =
    activeNode === "__trigger" ? [] : (configByNode.get(activeNode) ?? []);

  const titleOf = (nodeId: string) =>
    nodeId === "trigger"
      ? t("trigger.title")
      : (funcs.find((x) => x.id === nodeId)?.title ?? nodeId);

  const providerForNode = (nodeId: string): string | undefined => {
    const f = funcs.find((x) => x.id === nodeId);
    return f && !f.pure && f.requires[0] ? f.requires[0].provider : undefined;
  };

  const streamRun = async (payload: Record<string, unknown>) => {
    setError(null);
    setRunning(true);
    setRecords([]);
    setTab("state");
    onStatus({});
    onData({});
    try {
      const res = await fetch("/api/run", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...spaceHeaders() },
        body: JSON.stringify(payload),
      });
      if (!res.body) throw new Error("no stream");

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      const recs: RunRecord[] = [];
      const status: Record<string, string> = {};
      const dataByNode: Record<string, RunStepData> = {};
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (!data || data === "[DONE]") continue;
          const rec = JSON.parse(data) as RunRecord;
          recs.push(rec);
          status[rec.nodeId] = rec.status;
          dataByNode[rec.nodeId] = {
            status: rec.status,
            resolvedInput: rec.resolvedInput,
            output: rec.output,
            error: rec.error,
          };
          setRecords([...recs]);
          onStatus({ ...status });
          onData({ ...dataByNode });
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
      if (workflowId) qc.invalidateQueries({ queryKey: ["runs", workflowId] });
    }
  };

  const run = async () => {
    if (!requireAuth(() => void run())) return;
    let parsed: Record<string, unknown>;
    if (useForm && inputMode === "form") {
      parsed = buildFormInput();
    } else {
      try {
        const j = JSON.parse(input || "{}");
        parsed = j && typeof j === "object" ? (j as Record<string, unknown>) : {};
      } catch {
        setError(t("run.invalidJson"));
        return;
      }
    }
    // include the saved form values (e.g. a picked file) so the run always uses
    // them, even from JSON mode; the explicit input above takes precedence.
    parsed = { ...variables, ...parsed };
    const id = crypto.randomUUID();
    setCurrentRunId(id);
    await streamRun({
      funcs,
      wires,
      config,
      nodeConnections,
      input: parsed,
      workflowId: workflowId ?? undefined,
      workflowName,
      runId: id,
    });
  };

  const resume = async () => {
    if (!currentRunId) return;
    const id = crypto.randomUUID();
    setCurrentRunId(id);
    await streamRun({
      funcs,
      wires,
      config,
      nodeConnections,
      workflowId: workflowId ?? undefined,
      workflowName,
      runId: id,
      resumeRunId: currentRunId,
    });
  };

  const openRun = async (id: string) => {
    setLoadingRun(id);
    try {
      const run = await fetchRun(id);
      setRecords(run.records as RunRecord[]);
      setCurrentRunId(id);
      const status: Record<string, string> = {};
      const dataByNode: Record<string, RunStepData> = {};
      for (const r of run.records) {
        status[r.nodeId] = r.status;
        dataByNode[r.nodeId] = {
          status: r.status,
          resolvedInput: r.resolvedInput,
          output: r.output,
          error: r.error,
        };
      }
      onStatus(status);
      onData(dataByNode);
      setTab("state");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoadingRun(null);
    }
  };

  const canResume =
    !!workflowId &&
    !!currentRunId &&
    records.some((r) => r.status === "failed");

  return (
    <div className="flex h-full flex-col bg-background-subtle/30">
      <div className="flex items-center gap-2 px-3 py-2">
        <Button
          size="sm"
          onClick={run}
          disabled={running || funcs.length === 0}
          className="h-7 rounded-lg px-3"
        >
          {running ? t("run.running") : t("run.run")}
        </Button>

        {canResume && (
          <Button
            size="sm"
            variant="outline"
            onClick={resume}
            disabled={running}
            className="h-7 rounded-lg px-3"
            title={t("run.resumeTitle")}
          >
            {t("run.resume")}
          </Button>
        )}

        <div className="flex rounded-lg border border-border/50 bg-muted/50 p-0.5 text-xs">
          {(["input", "state", "runs", "code", "provider"] as const).map(
            (tabKey) => (
            <button
              key={tabKey}
              onClick={() => setTab(tabKey)}
              className={cn(
                "flex items-center gap-1 rounded-md px-2.5 py-1 capitalize transition-colors",
                tab === tabKey
                  ? "bg-background text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {t(`run.tab.${tabKey}`)}
              {tabKey === "input" && syncing && (
                <RefreshCw className="h-2.5 w-2.5 animate-spin text-amber-300" />
              )}
            </button>
          ))}
        </div>

        {error && (
          <span className="text-xs text-destructive">⚠ {error}</span>
        )}
        {!error && records.length > 0 && (
          <span className="ml-auto text-[11px] text-muted-foreground">
            {t("run.doneCount", {
              done: records.filter((r) => r.status === "done").length,
              total: records.length,
            })}
          </span>
        )}
      </div>

      {tab === "input" ? (
        <div className="flex min-h-0 flex-1 flex-col px-3 pb-3">
          <div className="mb-2 flex items-center gap-2">
            {views.length > 0 && (
              <Select value={activeNode} onValueChange={setNodeView}>
                <SelectTrigger
                  size="sm"
                  className="h-7 w-auto min-w-[150px] bg-background text-xs"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {views.map((v) => (
                    <SelectItem key={v.id} value={v.id}>
                      {v.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
              {syncing && (
                <span className="flex items-center gap-1 text-amber-300">
                  <RefreshCw className="h-3 w-3 animate-spin" />
                  {t("run.updatingForm")}
                </span>
              )}
            </div>
            <div className="ml-auto flex items-center gap-1.5">
              {variableFields.length > 0 && (
                <button
                  onClick={regenerate}
                  disabled={regenerating || syncing}
                  title={t("run.makeFormTitle")}
                  className="flex items-center gap-1 rounded-md border border-border/50 px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
                >
                  <RefreshCw
                    className={cn(
                      "h-3 w-3",
                      (regenerating || syncing) && "animate-spin",
                    )}
                  />
                  {inputForm ? t("run.formLabel") : t("run.makeForm")}
                </button>
              )}
              {useForm && (
                <div className="flex rounded-md border border-border/50 bg-muted/50 p-0.5 text-[10px]">
                  {(["form", "json"] as const).map((m) => (
                    <button
                      key={m}
                      onClick={() => {
                        if (m === "json" && inputMode === "form") {
                          setInput(JSON.stringify(buildFormInput(), null, 2));
                        } else if (m === "form" && inputMode === "json") {
                          try {
                            const parsed = JSON.parse(input || "{}");
                            if (parsed && typeof parsed === "object") {
                              setFormValues((prev) => {
                                const next = { ...prev };
                                for (const [k, v] of Object.entries(parsed)) {
                                  next[k] = v;
                                }
                                return next;
                              });
                            }
                          } catch {
                            void 0;
                          }
                        }
                        setInputMode(m);
                      }}
                      className={cn(
                        "rounded px-1.5 py-0.5 uppercase transition-colors",
                        inputMode === m
                          ? "bg-background text-foreground"
                          : "text-muted-foreground hover:text-foreground",
                      )}
                    >
                      {m}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div className="min-h-0 flex-1 space-y-3 overflow-auto">
          {activeNode === "__trigger" ? (
            <div className="space-y-2 rounded-xl border border-border/50 bg-background p-3">
              <div className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/70">
                Trigger settings
              </div>
              {(trigger.poll?.paramNames ?? []).map((name) => {
                const cur = String(trigger.poll?.params?.[name] ?? "");
                const saved =
                  cur === String(savedTrigger.poll?.params?.[name] ?? "");
                return (
                  <div key={name} className="space-y-1">
                    <label className="flex items-center gap-2 text-xs">
                      <span className="font-mono text-[11px] text-foreground/90">
                        {name}
                      </span>
                      <span className="text-[10px] uppercase tracking-wide text-rose-400/80">
                        required
                      </span>
                    </label>
                    <div className="relative">
                      <input
                        value={cur}
                        onChange={(e) => onTriggerParam(name, e.target.value)}
                        placeholder={name}
                        className="w-full rounded-lg border border-border/60 bg-background-subtle px-2.5 py-1.5 pr-8 text-[12px] text-foreground/90 outline-none focus:border-border"
                      />
                      <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2">
                        <SaveDot cur={cur} saved={saved} />
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (useForm && inputMode === "json") || views.length === 0 ? (
            <textarea
              value={input}
              onChange={(e) => {
                const json = e.target.value;
                setInput(json);
                try {
                  const parsed = JSON.parse(json);
                  if (parsed && typeof parsed === "object") {
                    const fv = { ...formValues };
                    for (const [k, v] of Object.entries(parsed)) {
                      fv[k] = v;
                    }
                    setFormValues(fv);
                    persistInput(fv);
                  }
                } catch {
                  void 0;
                }
              }}
              spellCheck={false}
              placeholder='{ "email": "ada@x.com", "amount": 2000 }'
              className="min-h-[220px] w-full resize-none rounded-xl border border-border/50 bg-background p-3 font-mono text-xs outline-none transition-colors focus:border-foreground/20"
            />
          ) : (
            <div
              className={cn(
                "space-y-3 rounded-xl border border-border/50 bg-background p-3 transition-opacity",
                syncing && "pointer-events-none opacity-50",
              )}
            >
              {(useForm ? visibleFields : []).map((f) => {
                if (f.control === "array") {
                  const arr = Array.isArray(formValues[f.name])
                    ? (formValues[f.name] as string[])
                    : [];
                  const saved =
                    JSON.stringify(arr) ===
                    JSON.stringify(
                      Array.isArray(persistedVars[f.name])
                        ? persistedVars[f.name]
                        : [],
                    );
                  return (
                    <div key={f.name} className="space-y-1">
                      <label className="flex items-center gap-2 text-xs">
                        <span className="font-medium">{f.label}</span>
                        <span className="font-mono text-[10px] text-muted-foreground/50">
                          {f.name}
                        </span>
                        {f.required && (
                          <span className="text-[10px] text-rose-300/70">
                            {t("run.required")}
                          </span>
                        )}
                      </label>
                      <button
                        type="button"
                        onClick={() => setEditingArray(f.name)}
                        className="flex w-full items-center gap-2 rounded-lg border border-border/50 bg-background-subtle px-2.5 py-1.5 text-left text-xs transition-colors hover:border-border"
                      >
                        <span className="min-w-0 flex-1 truncate">
                          {arr.length ? (
                            t("array.count", { count: arr.length })
                          ) : (
                            <span className="text-muted-foreground/50">
                              {t("array.empty")}
                            </span>
                          )}
                        </span>
                        <SaveDot cur={arr.length ? "x" : ""} saved={saved} />
                        <Pencil className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      </button>
                      {f.help && (
                        <p className="text-[11px] leading-snug text-muted-foreground/70">
                          {f.help}
                        </p>
                      )}
                    </div>
                  );
                }
                if (fileFields.has(f.name)) {
                  const fid = String(formValues[f.name] ?? "");
                  return (
                    <div key={f.name} className="space-y-1">
                      <label className="flex items-center gap-2 text-xs">
                        <span className="font-medium">{f.label}</span>
                        <span className="font-mono text-[10px] text-muted-foreground/50">
                          {f.name}
                        </span>
                        {f.required && (
                          <span className="text-[10px] text-rose-300/70">
                            {t("run.required")}
                          </span>
                        )}
                      </label>
                      <Select
                        value={fid || undefined}
                        onValueChange={(v) => setField(f.name, v)}
                        disabled={!files.length}
                      >
                        <SelectTrigger
                          size="sm"
                          className="h-8 w-full bg-background-subtle text-xs"
                        >
                          <SelectValue placeholder={t("run.pickFile")} />
                        </SelectTrigger>
                        <SelectContent>
                          {files.map((x) => (
                            <SelectItem key={x.id} value={x.id} className="text-xs">
                              {x.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      {!files.length && (
                        <p className="text-[11px] text-muted-foreground/70">
                          {t("run.noFiles")}
                        </p>
                      )}
                    </div>
                  );
                }
                const value = String(
                  formValues[f.name] ?? f.defaultValue ?? "",
                );
                const cur = String(formValues[f.name] ?? "");
                const saved = cur === String(persistedVars[f.name] ?? "");
                return (
                  <div key={f.name} className="space-y-1">
                    <label className="flex items-center gap-2 text-xs">
                      <span className="font-medium">{f.label}</span>
                      <span className="font-mono text-[10px] text-muted-foreground/50">
                        {f.name}
                      </span>
                      {f.required && (
                        <span className="text-[10px] text-rose-300/70">
                          {t("run.required")}
                        </span>
                      )}
                    </label>
                    <div className="relative">
                    {f.control === "textarea" ? (
                      <textarea
                        value={value}
                        onChange={(e) => setField(f.name, e.target.value)}
                        placeholder={f.placeholder}
                        rows={3}
                        className="w-full resize-y rounded-lg border border-border/50 bg-background-subtle p-2 pr-8 text-xs outline-none transition-colors focus:border-foreground/20"
                      />
                    ) : f.control === "select" ? (
                      <select
                        value={value}
                        onChange={(e) => setField(f.name, e.target.value)}
                        className="h-8 w-full rounded-lg border border-border/50 bg-background-subtle px-2 pr-8 text-xs outline-none transition-colors focus:border-foreground/20"
                      >
                        <option value="">
                          {f.placeholder ?? t("run.select")}
                        </option>
                        {f.options?.map((o) => (
                          <option key={o.value} value={o.value}>
                            {o.label}
                          </option>
                        ))}
                      </select>
                    ) : f.control === "toggle" ? (
                      <button
                        type="button"
                        onClick={() =>
                          setField(f.name, value === "true" ? "false" : "true")
                        }
                        className={cn(
                          "flex h-6 w-11 items-center rounded-full p-0.5 transition-colors",
                          value === "true" ? "bg-emerald-500/80" : "bg-muted",
                        )}
                      >
                        <span
                          className={cn(
                            "size-5 rounded-full bg-background transition-transform",
                            value === "true" && "translate-x-5",
                          )}
                        />
                      </button>
                    ) : (
                      <Input
                        value={value}
                        onChange={(e) => setField(f.name, e.target.value)}
                        type={
                          f.control === "number"
                            ? "number"
                            : f.control === "date"
                              ? "date"
                              : "text"
                        }
                        placeholder={f.placeholder}
                        className="h-8 w-full rounded-lg bg-background-subtle pr-8 text-xs"
                      />
                    )}
                    {f.control !== "toggle" && (
                      <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2">
                        <SaveDot cur={cur} saved={saved} />
                      </span>
                    )}
                    </div>
                    {f.help && (
                      <p className="text-[11px] leading-snug text-muted-foreground/70">
                        {f.help}
                      </p>
                    )}
                  </div>
                );
              })}
              {visibleConfig.map((p) => {
                const cur = String(config[activeNode]?.[p.name] ?? "");
                return (
                  <div key={`cfg-${p.name}`} className="space-y-1">
                    <label className="flex items-center gap-2 text-xs">
                      <span className="font-medium">{p.name}</span>
                      <span className="font-mono text-[10px] text-muted-foreground/50">
                        {p.type}
                      </span>
                      {p.required && (
                        <span className="text-[10px] text-amber-300/80">
                          {t("run.required")}
                        </span>
                      )}
                    </label>
                    <Input
                      value={cur}
                      onChange={(e) =>
                        onConfigChange(activeNode, p.name, e.target.value)
                      }
                      type={p.type === "number" ? "number" : "text"}
                      placeholder={`${p.name}…`}
                      className="h-8 w-full rounded-lg bg-background-subtle text-xs"
                    />
                  </div>
                );
              })}
            </div>
          )}
          </div>
        </div>
      ) : tab === "runs" ? (
        <div className="min-h-0 flex-1 overflow-auto px-3 pb-3">
          {!workflowId ? (
            <div className="flex h-full items-center justify-center px-6 text-center text-xs text-muted-foreground">
              {t("run.saveForHistory")}
            </div>
          ) : (runsQuery.data?.length ?? 0) === 0 ? (
            <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
              {t("run.noRuns")}
            </div>
          ) : (
            <div className="space-y-1.5">
              {runsQuery.data?.map((r) => (
                <button
                  key={r.id}
                  onClick={() => openRun(r.id)}
                  className="flex w-full items-center gap-2 rounded-xl border border-border/50 bg-background/60 px-2.5 py-2 text-left transition-colors hover:border-border"
                >
                  <span
                    className={cn(
                      "size-2 shrink-0 rounded-full",
                      STATUS_DOT[r.status] ?? "bg-muted-foreground",
                    )}
                  />
                  <span className="shrink-0 rounded bg-muted/60 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                    {r.trigger}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
                    {new Date(r.startedAt).toLocaleString(i18n.language)}
                  </span>
                  <span className="shrink-0 text-[10px] text-muted-foreground/60">
                    {t("run.steps", { count: r.stepCount })}
                  </span>
                  {loadingRun === r.id && (
                    <span className="shrink-0 text-[10px] text-muted-foreground">
                      {t("common.loading")}
                    </span>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>
      ) : tab === "code" ? (
        <div className="flex min-h-0 flex-1 flex-col px-3 pb-3">
          {!selected ? (
            <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
              {t("run.selectStepCode")}
            </div>
          ) : (
            <>
              <div className="mb-2 flex items-center gap-2">
                <span className="text-xs font-medium">
                  {selected.title || selected.id}
                </span>
                <span className="font-mono text-[10px] text-muted-foreground/60">
                  {selected.id} · v{selected.version}
                </span>
                <button
                  onClick={() =>
                    navigator.clipboard?.writeText(selected.bodySource)
                  }
                  className="ml-auto rounded-md border border-border/50 px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:text-foreground"
                >
                  {t("run.copy")}
                </button>
              </div>
              <div className="min-h-0 flex-1">
                <CodeBlock
                  source={selected.bodySource}
                  name={selected.id}
                  theme={theme}
                  wrap={false}
                  fill
                />
              </div>
            </>
          )}
        </div>
      ) : tab === "provider" ? (
        <div className="flex min-h-0 flex-1 flex-col px-3 pb-3">
          {providers.length === 0 ? (
            <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
              {t("run.noProviders")}
            </div>
          ) : (
            <>
              <div className="mb-2 flex items-center gap-2">
                <Select value={activeProv} onValueChange={setProvView}>
                  <SelectTrigger
                    size="sm"
                    className="h-7 w-auto min-w-[150px] bg-background text-xs"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {providers.map((p) => (
                      <SelectItem key={p} value={p}>
                        {p}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {provSource?.clientSource && (
                  <button
                    onClick={() =>
                      navigator.clipboard?.writeText(provSource.clientSource)
                    }
                    className="ml-auto rounded-md border border-border/50 px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:text-foreground"
                  >
                    {t("run.copy")}
                  </button>
                )}
              </div>
              {provSource?.credentialFields.length ? (
                <div className="mb-2 flex flex-wrap gap-1.5">
                  {provSource.credentialFields.map((f) => (
                    <span
                      key={f.name}
                      title={f.label}
                      className="rounded bg-muted/60 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
                    >
                      cred.{f.name}
                    </span>
                  ))}
                </div>
              ) : null}
              <div className="min-h-0 flex-1">
                {provLoading ? (
                  <div className="flex h-full items-center justify-center">
                    <Loader2 className="h-4 w-4 animate-spin text-muted-foreground/70" />
                  </div>
                ) : provSource?.clientSource ? (
                  <CodeBlock
                    source={provSource.clientSource}
                    name={activeProv}
                    theme={theme}
                    wrap={false}
                    fill
                  />
                ) : (
                  <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
                    {t("connections.noCode")}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto px-3 pb-3">
          {records.length === 0 ? (
            <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
              {t("run.emptyState")}
            </div>
          ) : (
            <div className="space-y-2">
              {records.map((r, i) => {
                const provider =
                  r.status === "failed" ? providerForNode(r.nodeId) : undefined;
                return (
                  <div
                    key={i}
                    className="rounded-xl border border-border/50 bg-background/60 p-2.5"
                  >
                    <div className="flex items-center gap-2">
                      <span
                        className={cn(
                          "size-2 rounded-full",
                          STATUS_DOT[r.status] ?? "bg-muted-foreground",
                        )}
                      />
                      <span className="text-xs font-medium">
                        {titleOf(r.nodeId)}
                      </span>
                      <span className="font-mono text-[10px] text-muted-foreground/60">
                        {t(`status.${r.status}`, { defaultValue: r.status })}
                      </span>
                      {provider && (
                        <button
                          onClick={() => {
                            const f = funcs.find((x) => x.id === r.nodeId);
                            onRepair(provider, {
                              nodeId: r.nodeId,
                              error: r.error ?? "",
                              callSite: f?.bodySource ?? "",
                              sampleInput:
                                r.resolvedInput !== undefined
                                  ? JSON.stringify(r.resolvedInput)
                                  : "{}",
                              declaredInputs: f
                                ? f.inputs.map((p) => p.name)
                                : [],
                            });
                          }}
                          className="ml-auto rounded-md bg-amber-500/20 px-2 py-0.5 text-[11px] text-amber-200 hover:bg-amber-500/30"
                        >
                          {t("run.fixWithAi")}
                        </button>
                      )}
                    </div>

                    {r.nodeId !== "trigger" && (
                      <div className="mt-2 space-y-1.5">
                        <div>
                          <div className="text-[10px] text-muted-foreground/60">
                            {t("node.inputLabel")}
                          </div>
                          <pre className="mt-0.5 overflow-auto rounded-lg bg-muted/40 p-2 font-mono text-[11px] leading-relaxed text-foreground/85">
                            {pretty(r.resolvedInput ?? {})}
                          </pre>
                        </div>
                        {r.error ? (
                          <div>
                            <div className="text-[10px] text-rose-300/80">
                              {t("node.errorLabel")}
                            </div>
                            <pre className="mt-0.5 overflow-auto rounded-lg border border-rose-500/30 bg-rose-500/5 p-2 font-mono text-[11px] leading-relaxed text-rose-200">
                              {r.error}
                            </pre>
                          </div>
                        ) : (
                          r.output !== undefined && (
                            <div>
                              <div className="text-[10px] text-muted-foreground/60">
                                {t("node.outputLabel")}
                              </div>
                              <pre className="mt-0.5 overflow-auto rounded-lg bg-muted/40 p-2 font-mono text-[11px] leading-relaxed text-emerald-200/85">
                                {pretty(r.output)}
                              </pre>
                            </div>
                          )
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
      {editingArray &&
        (() => {
          const fld = (inputForm?.fields ?? []).find(
            (x) => x.name === editingArray,
          );
          const arr = Array.isArray(formValues[editingArray])
            ? (formValues[editingArray] as string[])
            : [];
          return (
            <ArrayEditorDialog
              title={fld?.label ?? editingArray}
              items={arr}
              onChange={(items) => setField(editingArray, items)}
              onClose={() => setEditingArray(null)}
            />
          );
        })()}
    </div>
  );
}
