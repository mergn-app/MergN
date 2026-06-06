import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { AuthoredFunc, InputForm, RunStepData, Wire } from "./types";
import { spaceHeaders } from "./space";
import { useRuns, fetchRun, generateInputForm } from "./queries";
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
};

function pretty(v: unknown): string {
  if (v === undefined) return "";
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

export function RunPanel({
  funcs,
  wires,
  config,
  workflowId,
  workflowName,
  inputForm,
  onInputForm,
  triggerFields,
  syncing,
  selected,
  theme,
  onStatus,
  onData,
  onRepair,
}: {
  funcs: AuthoredFunc[];
  wires: Wire[];
  config: Record<string, Record<string, string>>;
  workflowId: string | null;
  workflowName: string;
  inputForm: InputForm | null;
  onInputForm: (form: InputForm | null) => void;
  triggerFields: string[];
  syncing: boolean;
  selected: AuthoredFunc | null;
  theme: "dark" | "light";
  onStatus: (status: Record<string, string>) => void;
  onData: (data: Record<string, RunStepData>) => void;
  onRepair: (
    provider: string,
    ctx: {
      error: string;
      callSite: string;
      sampleInput: string;
      declaredInputs: string[];
    },
  ) => void;
}) {
  const qc = useQueryClient();
  const runsQuery = useRuns(workflowId);
  const [input, setInput] = useState("{}");
  const [records, setRecords] = useState<RunRecord[]>([]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadingRun, setLoadingRun] = useState<string | null>(null);
  const [currentRunId, setCurrentRunId] = useState<string | null>(null);
  const [tab, setTab] = useState<"input" | "state" | "runs" | "code">("input");
  const [formValues, setFormValues] = useState<Record<string, string>>({});
  const [inputMode, setInputMode] = useState<"form" | "json">("form");
  const [regenerating, setRegenerating] = useState(false);

  useEffect(() => {
    if (!inputForm) return;
    setFormValues((prev) => {
      const next = { ...prev };
      for (const f of inputForm.fields) {
        if (next[f.name] === undefined)
          next[f.name] =
            f.defaultValue ?? (f.control === "toggle" ? "false" : "");
      }
      return next;
    });
  }, [inputForm]);

  const setField = (name: string, value: string) =>
    setFormValues((prev) => ({ ...prev, [name]: value }));

  const buildFormInput = (): Record<string, unknown> => {
    const obj: Record<string, unknown> = {};
    if (!inputForm) return obj;
    for (const f of inputForm.fields) {
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
      const form = await generateInputForm(workflowName, triggerFields);
      onInputForm(form);
      setInputMode("form");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRegenerating(false);
    }
  };

  const useForm = !!inputForm && inputForm.fields.length > 0;

  const titleOf = (nodeId: string) =>
    nodeId === "trigger"
      ? "Trigger"
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
    let parsed: unknown;
    if (useForm && inputMode === "form") {
      parsed = buildFormInput();
    } else {
      try {
        parsed = JSON.parse(input || "{}");
      } catch {
        setError("Invalid JSON input");
        return;
      }
    }
    const id = crypto.randomUUID();
    setCurrentRunId(id);
    await streamRun({
      funcs,
      wires,
      config,
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
          {running ? "running…" : "▶ Run"}
        </Button>

        {canResume && (
          <Button
            size="sm"
            variant="outline"
            onClick={resume}
            disabled={running}
            className="h-7 rounded-lg px-3"
            title="Re-run from the failed step, reusing earlier outputs"
          >
            ⟲ Resume
          </Button>
        )}

        <div className="flex rounded-lg border border-border/50 bg-muted/50 p-0.5 text-xs">
          {(["input", "state", "runs", "code"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={cn(
                "flex items-center gap-1 rounded-md px-2.5 py-1 capitalize transition-colors",
                tab === t
                  ? "bg-background text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {t}
              {t === "input" && syncing && (
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
            {records.filter((r) => r.status === "done").length}/{records.length}{" "}
            done
          </span>
        )}
      </div>

      {tab === "input" ? (
        <div className="flex min-h-0 flex-1 flex-col px-3 pb-3">
          <div className="mb-2 flex items-center gap-2">
            <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
              {syncing && (
                <span className="flex items-center gap-1 text-amber-300">
                  <RefreshCw className="h-3 w-3 animate-spin" />
                  updating form…
                </span>
              )}
            </div>
            <div className="ml-auto flex items-center gap-1.5">
              {triggerFields.length > 0 && (
                <button
                  onClick={regenerate}
                  disabled={regenerating || syncing}
                  title="Generate an input form from the trigger fields"
                  className="flex items-center gap-1 rounded-md border border-border/50 px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
                >
                  <RefreshCw
                    className={cn(
                      "h-3 w-3",
                      (regenerating || syncing) && "animate-spin",
                    )}
                  />
                  {inputForm ? "form" : "make form"}
                </button>
              )}
              {useForm && (
                <div className="flex rounded-md border border-border/50 bg-muted/50 p-0.5 text-[10px]">
                  {(["form", "json"] as const).map((m) => (
                    <button
                      key={m}
                      onClick={() => {
                        if (m === "json" && inputMode === "form")
                          setInput(JSON.stringify(buildFormInput(), null, 2));
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

          {useForm && inputMode === "form" ? (
            <div
              className={cn(
                "min-h-0 flex-1 space-y-3 overflow-auto rounded-xl border border-border/50 bg-background p-3 transition-opacity",
                syncing && "pointer-events-none opacity-50",
              )}
            >
              {inputForm!.fields.map((f) => {
                const value = formValues[f.name] ?? f.defaultValue ?? "";
                return (
                  <div key={f.name} className="space-y-1">
                    <label className="flex items-center gap-2 text-xs">
                      <span className="font-medium">{f.label}</span>
                      <span className="font-mono text-[10px] text-muted-foreground/50">
                        {f.name}
                      </span>
                      {f.required && (
                        <span className="text-[10px] text-rose-300/70">
                          required
                        </span>
                      )}
                    </label>
                    {f.control === "textarea" ? (
                      <textarea
                        value={value}
                        onChange={(e) => setField(f.name, e.target.value)}
                        placeholder={f.placeholder}
                        rows={3}
                        className="w-full resize-y rounded-lg border border-border/50 bg-background-subtle p-2 text-xs outline-none transition-colors focus:border-foreground/20"
                      />
                    ) : f.control === "select" ? (
                      <select
                        value={value}
                        onChange={(e) => setField(f.name, e.target.value)}
                        className="h-8 w-full rounded-lg border border-border/50 bg-background-subtle px-2 text-xs outline-none transition-colors focus:border-foreground/20"
                      >
                        <option value="">{f.placeholder ?? "Select…"}</option>
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
                        className="h-8 rounded-lg bg-background-subtle text-xs"
                      />
                    )}
                    {f.help && (
                      <p className="text-[11px] leading-snug text-muted-foreground/70">
                        {f.help}
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
          ) : (
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              spellCheck={false}
              placeholder='{ "email": "ada@x.com", "amount": 2000 }'
              className="min-h-0 flex-1 resize-none rounded-xl border border-border/50 bg-background p-3 font-mono text-xs outline-none transition-colors focus:border-foreground/20"
            />
          )}
        </div>
      ) : tab === "runs" ? (
        <div className="min-h-0 flex-1 overflow-auto px-3 pb-3">
          {!workflowId ? (
            <div className="flex h-full items-center justify-center px-6 text-center text-xs text-muted-foreground">
              Save the workflow to keep a history of its runs.
            </div>
          ) : (runsQuery.data?.length ?? 0) === 0 ? (
            <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
              No runs yet.
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
                    {new Date(r.startedAt).toLocaleString()}
                  </span>
                  <span className="shrink-0 text-[10px] text-muted-foreground/60">
                    {r.stepCount} step{r.stepCount === 1 ? "" : "s"}
                  </span>
                  {loadingRun === r.id && (
                    <span className="shrink-0 text-[10px] text-muted-foreground">
                      loading…
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
              Select a step to see its generated code.
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
                  copy
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
      ) : (
        <div className="min-h-0 flex-1 overflow-auto px-3 pb-3">
          {records.length === 0 ? (
            <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
              Run the workflow to see each step's state here.
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
                        {r.status}
                      </span>
                      {provider && (
                        <button
                          onClick={() => {
                            const f = funcs.find((x) => x.id === r.nodeId);
                            onRepair(provider, {
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
                          🔧 fix with AI
                        </button>
                      )}
                    </div>

                    {r.nodeId !== "trigger" && (
                      <div className="mt-2 space-y-1.5">
                        <div>
                          <div className="text-[10px] text-muted-foreground/60">
                            input
                          </div>
                          <pre className="mt-0.5 overflow-auto rounded-lg bg-muted/40 p-2 font-mono text-[11px] leading-relaxed text-foreground/85">
                            {pretty(r.resolvedInput ?? {})}
                          </pre>
                        </div>
                        {r.error ? (
                          <div>
                            <div className="text-[10px] text-rose-300/80">error</div>
                            <pre className="mt-0.5 overflow-auto rounded-lg border border-rose-500/30 bg-rose-500/5 p-2 font-mono text-[11px] leading-relaxed text-rose-200">
                              {r.error}
                            </pre>
                          </div>
                        ) : (
                          r.output !== undefined && (
                            <div>
                              <div className="text-[10px] text-muted-foreground/60">
                                output
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
    </div>
  );
}
