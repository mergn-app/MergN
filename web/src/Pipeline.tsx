import { useTranslation } from "react-i18next";
import { ArrowLeftRight, Zap } from "lucide-react";
import { cn } from "@/lib/utils";
import type { AuthoredFunc } from "./types";
import { lineage, outputsOf, type Source } from "./lineage";

interface PipelineProps {
  funcs: AuthoredFunc[];
  wires: import("./types").Wire[];
  triggerFields: string[];
  runStatus: Record<string, string>;
  connectedProviders: Set<string>;
  configValues: Record<string, Record<string, string>>;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onInsertBetween: (wire: import("./types").Wire) => void;
  onDeleteNode: (id: string) => void;
  onDeleteEdge: (key: string) => void;
}

const STATUS_DOT: Record<string, string> = {
  done: "bg-emerald-500",
  failed: "bg-rose-500",
  pending: "bg-amber-500 animate-pulse",
};

function SourceChip({ source }: { source: Source }) {
  if (source.kind === "unbound") {
    return <span className="text-tone-rose-fg">⚠ unwired</span>;
  }
  if (source.kind === "config") {
    return <span className="text-muted-foreground">← config</span>;
  }
  if (source.kind === "trigger") {
    return (
      <span className="text-tone-amber-fg/90">
        ← <span className="text-tone-amber-fg">trigger</span>
      </span>
    );
  }
  return (
    <span className="text-tone-blue-fg">
      ←{" "}
      <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-tone-blue/12 px-1 text-[10px] font-medium text-tone-blue-fg">
        {source.num}
      </span>{" "}
      <span className="text-tone-blue-fg">{source.title}</span>
    </span>
  );
}

export function Pipeline({
  funcs,
  wires,
  triggerFields,
  runStatus,
  connectedProviders,
  configValues,
  selectedId,
  onSelect,
  onInsertBetween,
  onDeleteNode,
  onDeleteEdge,
}: PipelineProps) {
  const { t } = useTranslation();
  const { ordered, numberOf, sourceOf } = lineage(funcs, wires, configValues);

  if (funcs.length === 0 && triggerFields.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        {t("pipeline.describe")}
      </div>
    );
  }

  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto flex max-w-xl flex-col items-stretch gap-0 px-6 pb-6 pt-16">
        <div className="rounded-2xl border border-tone-amber/30 bg-tone-amber/5 p-3">
          <div className="flex items-center gap-2">
            <div className="flex items-center justify-center rounded-xl bg-tone-amber/15 p-1.5 text-tone-amber-fg">
              <Zap className="h-3.5 w-3.5" />
            </div>
            <span className="text-sm font-medium text-tone-amber-fg">
              {t("trigger.title")}
            </span>
            <span className="ml-auto text-[11px] text-muted-foreground">
              {t("pipeline.manualApi")}
            </span>
          </div>
          {triggerFields.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {triggerFields.map((field) => (
                <span
                  key={field}
                  className="rounded-md bg-tone-amber/12 px-1.5 py-0.5 font-mono text-[11px] text-tone-amber-fg"
                >
                  {field}
                </span>
              ))}
            </div>
          )}
        </div>

        {ordered.map((f) => {
          const num = numberOf.get(f.id) ?? 0;
          const status = runStatus[f.id];
          const needsConnection =
            !f.pure && f.requires.some((r) => !connectedProviders.has(r.provider));
          const provider = f.requires[0]?.provider;
          const outputs = outputsOf(f);

          const idx = ordered.findIndex((x) => x.id === f.id);
          const next = idx >= 0 && idx < ordered.length - 1 ? ordered[idx + 1] : null;
          const betweenWire = next
            ? wires.find((w) => w.from === f.id && w.to === next.id)
            : undefined;
          return (
            <div key={f.id} className="flex flex-col items-stretch">
              <div className="mx-auto h-8 w-px bg-border" />
              <button
                onClick={() => onSelect(f.id)}
                className={cn(
                  "w-full rounded-2xl border bg-card p-3 text-left transition-colors hover:border-foreground/25",
                  selectedId === f.id ? "border-primary/40" : "border-border",
                )}
              >
                <div className="flex items-center gap-2">
                  <div
                    className={cn(
                      "flex items-center justify-center rounded-xl p-1.5",
                      f.pure
                        ? "bg-tone-emerald/15 text-tone-emerald-fg"
                        : "bg-tone-blue/15 text-tone-blue-fg",
                    )}
                  >
                    {f.pure ? (
                      <ArrowLeftRight className="h-3.5 w-3.5" />
                    ) : (
                      <Zap className="h-3.5 w-3.5" />
                    )}
                  </div>
                  <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-muted px-1 text-[11px] font-medium text-muted-foreground">
                    {num}
                  </span>
                  <span className="truncate text-sm font-medium">{f.title}</span>
                  <div className="ml-auto flex items-center gap-2">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onDeleteNode(f.id);
                      }}
                      className="rounded-md border border-border/50 px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-foreground"
                    >
                      delete
                    </button>
                    {provider && (
                      <span className="font-mono text-[11px] text-muted-foreground">
                        {provider}
                      </span>
                    )}
                    {needsConnection && (
                      <span className="text-[11px] text-tone-amber-fg">
                        ⚠ {t("connections.needsConnection")}
                      </span>
                    )}
                    {status && (
                      <span
                        className={cn(
                          "size-2 rounded-full",
                          STATUS_DOT[status] ?? "bg-muted-foreground",
                        )}
                        title={status}
                      />
                    )}
                  </div>
                </div>

                {f.summary && (
                  <p className="mt-1.5 truncate text-xs text-muted-foreground">
                    {f.summary}
                  </p>
                )}

                <div className="mt-2.5 space-y-1 border-t border-border/60 pt-2.5 font-mono text-[11px]">
                  {f.inputs.map((p) => (
                    <div key={p.name} className="flex items-center gap-2">
                      <span className="w-5 shrink-0 text-muted-foreground/60">in</span>
                      <span className="text-foreground/90">{p.name}</span>
                      <span className="ml-auto">
                        <SourceChip source={sourceOf(f.id, p.name)} />
                      </span>
                    </div>
                  ))}
                  {outputs.map((o) => (
                    <div key={o} className="flex items-center gap-2">
                      <span className="w-5 shrink-0 text-muted-foreground/60">
                        out
                      </span>
                      <span className="text-tone-emerald-fg">{o}</span>
                    </div>
                  ))}
                </div>
              </button>
              {betweenWire && (
                <div className="group relative mx-auto my-2 flex h-7 w-full max-w-[240px] items-center justify-center">
                  <div className="absolute inset-x-3 top-1/2 h-px -translate-y-1/2 bg-border/70" />
                  <div className="relative flex gap-1 opacity-0 transition group-hover:opacity-100">
                    <button
                      onClick={() => onInsertBetween(betweenWire)}
                      className="rounded-full border border-border/60 bg-background px-2 py-0.5 text-[10px] text-muted-foreground hover:text-foreground"
                    >
                      add node manually
                    </button>
                    <button
                      onClick={() => onDeleteEdge(`${betweenWire.from}.${betweenWire.fromOutput}->${betweenWire.to}.${betweenWire.toInput}`)}
                      className="rounded-full border border-border/60 bg-background px-2 py-0.5 text-[10px] text-muted-foreground hover:text-foreground"
                    >
                      delete edge
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
