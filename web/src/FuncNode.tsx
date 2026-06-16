import { Handle, Position, type NodeProps } from "@xyflow/react";
import { useTranslation } from "react-i18next";
import { ArrowLeftRight, Zap } from "lucide-react";
import { cn } from "@/lib/utils";

interface Port {
  name: string;
  bound?: boolean;
  variable?: boolean;
}

interface FuncNodeData {
  title: string;
  summary: string;
  pure: boolean;
  status?: string;
  needsConnection?: boolean;
  needsValue?: boolean;
  gated?: boolean;
  inputs: Port[];
  outputs: string[];
}

function PortDot({
  id,
  type,
  tone,
}: {
  id: string;
  type: "target" | "source";
  tone: string;
}) {
  return (
    <Handle
      id={id}
      type={type}
      position={type === "target" ? Position.Left : Position.Right}
      style={{ position: "relative", transform: "none", top: "auto", left: "auto", right: "auto" }}
      className={cn("!h-2.5 !w-2.5 !rounded-full !border-2 !bg-background", tone)}
    />
  );
}

export function FuncNode({ data, selected }: NodeProps) {
  const { t } = useTranslation();
  const d = data as unknown as FuncNodeData;
  const statusRing =
    d.status === "done"
      ? "ring-2 ring-emerald-500/60"
      : d.status === "failed"
        ? "ring-2 ring-rose-500/60"
        : d.status === "pending"
          ? "ring-2 ring-amber-500/70 animate-pulse"
          : d.status === "skipped"
            ? "opacity-50 ring-2 ring-muted-foreground/30"
            : "";

  return (
    <div
      className={cn(
        "group relative w-72 rounded-3xl border p-1 ring-offset-background transition-all",
        selected
          ? "border-primary/30 ring-2 ring-primary/20 ring-offset-2"
          : "border-border",
        statusRing,
      )}
    >
      <div className="overflow-hidden rounded-[1.2rem] bg-background ring-1 ring-border">
        <div className="flex gap-2 p-2 font-medium">
          <div
            className={cn(
              "flex h-9 w-9 shrink-0 items-center justify-center rounded-2xl",
              d.pure
                ? "bg-tone-emerald/15 text-tone-emerald-fg"
                : "bg-tone-blue/15 text-tone-blue-fg",
            )}
          >
            {d.pure ? (
              <ArrowLeftRight className="h-4 w-4" />
            ) : (
              <Zap className="h-4 w-4" />
            )}
          </div>
          <div className="flex min-w-0 flex-1 flex-col items-start gap-1 px-1 py-0.5">
            <div className="flex w-full items-center gap-1.5">
              <h3 className="min-w-0 flex-1 truncate text-base font-medium leading-none">
                {d.title}
              </h3>
              {d.gated && (
                <span
                  title={t("node.conditional")}
                  className="shrink-0 rounded bg-amber-500/15 px-1.5 py-0.5 font-mono text-[9px] font-semibold tracking-wide text-amber-500 ring-1 ring-amber-500/30"
                >
                  IF
                </span>
              )}
            </div>
            <p className="w-full truncate text-xs leading-tight text-muted-foreground">
              {d.summary}
            </p>
          </div>
        </div>

        {(d.inputs.length > 0 || d.outputs.length > 0) && (
          <div className="flex gap-2 border-t border-border/60 px-1.5 py-1.5">
            <div className="flex flex-1 flex-col gap-0.5">
              {d.inputs.map((p) => (
                <div key={p.name} className="flex h-6 items-center gap-1.5">
                  <PortDot
                    id={p.name}
                    type="target"
                    tone={p.bound ? "!border-tone-blue" : "!border-tone-amber"}
                  />
                  <span
                    className={cn(
                      "truncate font-mono text-[11px]",
                      p.bound ? "text-foreground/80" : "text-tone-amber-fg",
                    )}
                  >
                    {p.name}
                  </span>
                </div>
              ))}
            </div>
            <div className="flex flex-1 flex-col gap-0.5">
              {d.outputs.map((o) => (
                <div key={o} className="flex h-6 items-center justify-end gap-1.5">
                  <span className="truncate font-mono text-[11px] text-tone-emerald-fg">
                    {o}
                  </span>
                  <PortDot id={o} type="source" tone="!border-tone-emerald" />
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {(d.needsConnection || d.needsValue) && (
        <div
          title={
            d.needsConnection
              ? t("connections.needsConnection")
              : t("node.needsValue")
          }
          className="absolute -right-1 -top-1 size-2.5 rounded-full bg-amber-500 ring-2 ring-background"
        />
      )}
    </div>
  );
}
