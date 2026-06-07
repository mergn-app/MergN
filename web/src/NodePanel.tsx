import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ArrowLeftRight, Zap } from "lucide-react";
import { cn } from "@/lib/utils";
import type { AuthoredFunc, RunStepData } from "./types";
import { Input } from "@/components/ui/input";
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
  config,
  connections,
  run,
  onConfigChange,
  onConnectionChange,
}: {
  func: AuthoredFunc | null;
  config: Record<string, string>;
  connections?: Record<string, string>;
  run?: RunStepData;
  onConfigChange: (port: string, value: string) => void;
  onConnectionChange?: (requirementName: string, connectionId: string) => void;
}) {
  const { t } = useTranslation();
  if (!func) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-center text-sm text-muted-foreground">
        {t("node.selectStep")}
      </div>
    );
  }

  const outs = func.outputSchema?.properties
    ? Object.keys(func.outputSchema.properties)
    : (func.outputSchema?.required ?? []);
  const configPorts = func.inputs.filter((p) => p.role === "config");
  const dataPorts = func.inputs.filter((p) => p.role !== "config");

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

        {configPorts.length > 0 && (
          <Section title={t("node.settings")}>
            <div className="space-y-2.5">
              {configPorts.map((p) => (
                <div key={p.name} className="space-y-1">
                  <label className="flex items-center gap-2 text-xs">
                    <span className="min-w-0 truncate font-medium">{p.name}</span>
                    <TypePill>{p.type}</TypePill>
                    {!p.required && (
                      <span className="shrink-0 text-[10px] text-muted-foreground/60">
                        {t("node.optional")}
                      </span>
                    )}
                  </label>
                  <Input
                    value={config[p.name] ?? ""}
                    onChange={(e) => onConfigChange(p.name, e.target.value)}
                    type={p.type === "number" ? "number" : "text"}
                    placeholder={`${p.name}…`}
                    className="h-8 rounded-lg bg-background text-sm"
                  />
                </div>
              ))}
            </div>
          </Section>
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
      </div>
    </ScrollArea>
  );
}
