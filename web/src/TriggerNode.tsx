import { Handle, Position, type NodeProps } from "@xyflow/react";
import { useTranslation } from "react-i18next";
import { Zap } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ActivationState } from "./queries";

interface TriggerNodeData {
  fields: string[];
  kind?: string;
  activation?: ActivationState | "loading";
  busy?: boolean;
  onToggle?: () => void;
}

export function TriggerNode({ data }: NodeProps) {
  const { t } = useTranslation();
  const d = data as unknown as TriggerNodeData;
  const showToggle =
    (d.activation === "active" || d.activation === "paused") && !!d.onToggle;
  return (
    <div className="w-56 rounded-3xl border border-tone-amber/40 bg-tone-amber/5 p-1">
      <div className="overflow-hidden rounded-[1.2rem] bg-background ring-1 ring-tone-amber/20">
        <div className="flex gap-2 p-2">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-2xl bg-tone-amber/15 text-tone-amber-fg">
            <Zap className="h-4 w-4" />
          </div>
          <div className="flex min-w-0 flex-1 flex-col items-start justify-center gap-1 px-1">
            <h3 className="text-base font-medium leading-none">
              {t("trigger.title")}
            </h3>
            <p className="text-xs capitalize leading-none text-muted-foreground">
              {t(`trigger.kind.${d.kind ?? "manual"}`)}
            </p>
          </div>
          {showToggle && (
            <button
              type="button"
              disabled={d.busy}
              onClick={(e) => {
                e.stopPropagation();
                d.onToggle?.();
              }}
              className={cn(
                "flex h-fit items-center gap-1.5 self-center rounded-lg border px-2 py-1 text-[11px] transition-colors disabled:opacity-50",
                d.activation === "active"
                  ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
                  : "border-border/60 bg-background-subtle text-muted-foreground",
              )}
            >
              <span
                className={cn(
                  "size-2 rounded-full",
                  d.activation === "active"
                    ? "bg-emerald-400"
                    : "bg-muted-foreground/50",
                )}
              />
              {d.activation === "active" ? "Active" : "Paused"}
            </button>
          )}
        </div>

        {d.fields.length > 0 && (
          <div className="flex flex-col gap-0.5 border-t border-tone-amber/15 px-1.5 py-1.5">
            {d.fields.map((field) => (
              <div key={field} className="flex h-6 items-center justify-end gap-1.5">
                <span className="truncate font-mono text-[11px] text-tone-amber-fg">
                  {field}
                </span>
                <Handle
                  id={field}
                  type="source"
                  position={Position.Right}
                  style={{ position: "relative", transform: "none", top: "auto", right: "auto" }}
                  className="!h-2.5 !w-2.5 !rounded-full !border-2 !border-tone-amber !bg-background"
                />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
