import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ArrowLeftRight, Zap } from "lucide-react";
import { cn } from "@/lib/utils";
import type { AuthoredFunc, RunStepData } from "./types";
import { ScrollArea } from "@/components/ui/scroll-area";
import { NodeConnection } from "./NodeConnection";

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="space-y-2">
      <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/70">
        {title}
      </div>
      {children}
    </div>
  );
}

function TypePill({ children }: { children: ReactNode }) {
  return (
    <span className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
      {children}
    </span>
  );
}

function JsonBlock({
  value,
  tone = "default",
}: {
  value: unknown;
  tone?: "default" | "out" | "error";
}) {
  const text =
    typeof value === "string" ? value : JSON.stringify(value ?? null, null, 2);
  return (
    <pre
      className={cn(
        "overflow-auto rounded-lg border p-2.5 font-mono text-[11px] leading-relaxed",
        tone === "error"
          ? "border-tone-rose/30 bg-tone-rose/5 text-tone-rose-fg"
          : tone === "out"
            ? "border-border/50 bg-muted/30 text-tone-emerald-fg"
            : "border-border/50 bg-muted/30 text-foreground/85",
      )}
    >
      {text}
    </pre>
  );
}

const RUN_DOT: Record<string, string> = {
  done: "bg-emerald-500",
  failed: "bg-rose-500",
  pending: "bg-amber-500 animate-pulse",
};

export function NodePanel({
  func,
  connections,
  run,
  onConnectionChange,
  onFuncChange,
  onAddFunc,
}: {
  func: AuthoredFunc | null;
  connections?: Record<string, string>;
  run?: RunStepData;
  onConnectionChange?: (requirementName: string, connectionId: string) => void;
  onFuncChange?: (prevId: string, next: AuthoredFunc) => void;
  onAddFunc?: () => void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState("");
  const [draftError, setDraftError] = useState<string | null>(null);

  useEffect(() => {
    if (!func) {
      setDraft("");
      setDraftError(null);
      return;
    }
    setDraft(JSON.stringify(func, null, 2));
    setDraftError(null);
  }, [func]);

  const saveDraft = () => {
    if (!func) return;
    try {
      const raw = JSON.parse(draft) as Partial<AuthoredFunc>;
      const next: AuthoredFunc = {
        id: String(raw.id ?? func.id),
        title: String(raw.title ?? ""),
        summary: String(raw.summary ?? ""),
        version: Number(raw.version ?? 1) || 1,
        kind: String(raw.kind ?? "adapter"),
        pure: Boolean(raw.pure),
        inputs: Array.isArray(raw.inputs)
          ? raw.inputs.map((p) => ({
              name: String(p?.name ?? ""),
              role: "input",
              type: String(p?.type ?? "string"),
              required: Boolean(p?.required),
            }))
          : [],
        outputSchema:
          raw.outputSchema && typeof raw.outputSchema === "object"
            ? {
                type: String(raw.outputSchema.type ?? "object"),
                properties:
                  raw.outputSchema.properties &&
                  typeof raw.outputSchema.properties === "object"
                    ? raw.outputSchema.properties
                    : undefined,
                required: Array.isArray(raw.outputSchema.required)
                  ? raw.outputSchema.required.map((x) => String(x))
                  : undefined,
              }
            : { type: "object", properties: {}, required: [] },
        bodySource: String(raw.bodySource ?? ""),
        requires: Array.isArray(raw.requires)
          ? raw.requires.map((r) => ({
              name: String(r?.name ?? ""),
              provider: String(r?.provider ?? ""),
              scopes: Array.isArray(r?.scopes)
                ? r.scopes.map((s) => String(s))
                : [],
            }))
          : [],
        dangerClass:
          raw.dangerClass == null ? null : String(raw.dangerClass ?? "benign"),
        idempotency:
          raw.idempotency && typeof raw.idempotency === "object"
            ? {
                key: String(raw.idempotency.key ?? "runId+funcId"),
                mechanism: String(raw.idempotency.mechanism ?? "none"),
              }
            : null,
      };
      if (!next.id.trim()) throw new Error("id is required");
      if (!next.bodySource.trim()) throw new Error("bodySource is required");
      if (next.inputs.some((p) => !p.name.trim()))
        throw new Error("each input needs a name");
      onFuncChange?.(func.id, next);
      setDraft(JSON.stringify(next, null, 2));
      setDraftError(null);
    } catch (e) {
      setDraftError(e instanceof Error ? e.message : String(e));
    }
  };

  if (!func) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
        <div className="text-sm text-muted-foreground">{t("node.selectStep")}</div>
        <button
          onClick={() => onAddFunc?.()}
          className="rounded-lg border border-border/60 bg-background px-3 py-1.5 text-xs text-foreground transition-colors hover:border-border"
        >
          Add code node
        </button>
      </div>
    );
  }

  const outs = func.outputSchema?.properties
    ? Object.keys(func.outputSchema.properties)
    : (func.outputSchema?.required ?? []);
  const dataPorts = func.inputs;

  return (
    <ScrollArea className="h-full w-full">
      <div className="w-full min-w-0 space-y-6 p-5">
        <div className="flex gap-3">
          <div
            className={cn(
              "flex h-10 w-10 shrink-0 items-center justify-center rounded-xl",
              func.pure
                ? "bg-tone-emerald/15 text-tone-emerald-fg"
                : "bg-tone-blue/15 text-tone-blue-fg",
            )}
          >
            {func.pure ? (
              <ArrowLeftRight className="h-4 w-4" />
            ) : (
              <Zap className="h-4 w-4" />
            )}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h2 className="truncate text-[15px] font-semibold leading-tight">
                {func.title || func.id}
              </h2>
              <span
                className={cn(
                  "shrink-0 rounded-md px-1.5 py-0.5 text-[10px] font-medium",
                  func.pure
                    ? "bg-tone-emerald/12 text-tone-emerald-fg"
                    : "bg-tone-blue/12 text-tone-blue-fg",
                )}
              >
                {func.pure ? t("node.transform") : t("node.effectful")}
              </span>
            </div>
            {func.summary && (
              <p className="mt-1 break-words text-xs leading-relaxed text-muted-foreground">
                {func.summary}
              </p>
            )}
            <div className="mt-1.5 truncate font-mono text-[10px] text-muted-foreground/60">
              {func.id} · v{func.version}
            </div>
          </div>
        </div>

        {run && (
          <div className="space-y-2.5 rounded-2xl border border-border/50 bg-background-subtle/40 p-3.5">
            <div className="flex items-center gap-2">
              <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/70">
                {t("node.lastRun")}
              </span>
              <span className="ml-auto flex items-center gap-1.5 text-[11px] text-muted-foreground">
                <span
                  className={cn(
                    "size-2 rounded-full",
                    RUN_DOT[run.status] ?? "bg-muted-foreground",
                  )}
                />
                {t(`status.${run.status}`, { defaultValue: run.status })}
              </span>
            </div>
            <div className="space-y-1">
              <div className="text-[10px] text-muted-foreground/60">
                {t("node.inputLabel")}
              </div>
              <JsonBlock value={run.resolvedInput ?? {}} />
            </div>
            {run.error ? (
              <div className="space-y-1">
                <div className="text-[10px] text-tone-rose-fg">
                  {t("node.errorLabel")}
                </div>
                <JsonBlock value={run.error} tone="error" />
              </div>
            ) : (
              <div className="space-y-1">
                <div className="text-[10px] text-muted-foreground/60">
                  {t("node.outputLabel")}
                </div>
                <JsonBlock value={run.output ?? {}} tone="out" />
              </div>
            )}
          </div>
        )}

        <Section title={t("node.inputs")}>
          {dataPorts.length === 0 ? (
            <div className="text-xs text-muted-foreground/70">
              {t("node.none")}
            </div>
          ) : (
            <div className="space-y-1.5">
              {dataPorts.map((p) => (
                <div
                  key={p.name}
                  className="flex items-center gap-2 rounded-lg border border-border/40 bg-card px-2.5 py-1.5"
                >
                  <span className="min-w-0 flex-1 truncate font-mono text-xs text-foreground/90">
                    {p.name}
                  </span>
                  <TypePill>{p.type}</TypePill>
                  {!p.required && (
                    <span className="shrink-0 text-[10px] text-muted-foreground/60">
                      {t("node.optional")}
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
        </Section>

        <Section title={t("node.output")}>
          {outs.length === 0 ? (
            <div className="text-xs text-muted-foreground/70">—</div>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {outs.map((o) => (
                <span
                  key={o}
                  className="rounded-md bg-tone-emerald/12 px-2 py-1 font-mono text-[11px] text-tone-emerald-fg ring-1 ring-tone-emerald/30"
                >
                  {o}
                </span>
              ))}
            </div>
          )}
        </Section>

        {!func.pure && (
          <>
            <Section title={t("node.connections")}>
              {func.requires.length === 0 ? (
                <div className="text-xs text-muted-foreground/70">
              {t("node.none")}
            </div>
              ) : (
                <div className="space-y-2">
                  {func.requires.map((r) => (
                    <NodeConnection
                      key={r.name}
                      provider={r.provider}
                      requirementName={r.name}
                      selectedId={connections?.[r.name]}
                      onSelect={(name, id) => onConnectionChange?.(name, id)}
                    />
                  ))}
                </div>
              )}
            </Section>

            <Section title={t("node.safety")}>
              <div className="flex flex-wrap gap-1.5">
                <span className="rounded-md bg-muted px-2 py-1 text-[11px] text-muted-foreground">
                  {t("node.danger")} ·{" "}
                  <span className="text-foreground/80">{func.dangerClass}</span>
                </span>
                <span className="rounded-md bg-muted px-2 py-1 text-[11px] text-muted-foreground">
                  {t("node.idempotency")} ·{" "}
                  <span className="text-foreground/80">
                    {func.idempotency?.mechanism}
                  </span>
                </span>
              </div>
            </Section>
          </>
        )}

        <Section title="code node">
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <button
                onClick={saveDraft}
                className="rounded-md border border-border/60 bg-background px-2 py-1 text-[11px] font-medium transition-colors hover:border-border"
              >
                Save node
              </button>
              <button
                onClick={() => setDraft(JSON.stringify(func, null, 2))}
                className="rounded-md border border-border/60 bg-background px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
              >
                Reset
              </button>
            </div>
            <textarea
              spellCheck={false}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              className="min-h-[340px] w-full resize-y rounded-lg border border-border/50 bg-background p-2.5 font-mono text-[11px] leading-relaxed outline-none transition-colors focus:border-foreground/20"
            />
            {draftError && (
              <div className="rounded-lg border border-tone-rose/30 bg-tone-rose/5 px-2 py-1 text-[11px] text-tone-rose-fg">
                {draftError}
              </div>
            )}
          </div>
        </Section>
      </div>
    </ScrollArea>
  );
}
