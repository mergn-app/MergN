import { useWorkflows, useDeleteWorkflow } from "./queries";
import { cn } from "@/lib/utils";
import { Workflow, Trash2 } from "lucide-react";

export function WorkflowsPanel({
  currentId,
  onLoad,
}: {
  currentId: string | null;
  onLoad: (id: string) => void;
}) {
  const { data: items = [], isLoading } = useWorkflows();
  const del = useDeleteWorkflow();

  return (
    <div className="flex h-full w-60 shrink-0 flex-col overflow-hidden rounded-2xl border border-border/40 bg-muted/40 backdrop-blur-xl">
      <div className="flex items-center gap-2 px-4 py-3">
        <span className="text-sm font-semibold">Workflows</span>
        <span className="ml-auto rounded bg-muted/60 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground/80">
          {items.length}
        </span>
      </div>

      <div className="min-h-0 flex-1 space-y-1 overflow-auto p-2">
        {isLoading && (
          <div className="px-2 py-1 text-xs text-muted-foreground">loading…</div>
        )}
        {!isLoading && items.length === 0 && (
          <div className="px-2 py-6 text-center text-xs text-muted-foreground">
            No saved workflows yet.
          </div>
        )}
        {items.map((it) => {
          const active = it.id === currentId;
          return (
            <div
              key={it.id}
              onClick={() => onLoad(it.id)}
              className={cn(
                "group flex cursor-pointer items-center gap-2.5 rounded-xl border border-transparent px-2 py-2 transition-colors hover:bg-background-subtle",
                active && "border-border/60 bg-background-subtle",
              )}
            >
              <div
                className={cn(
                  "flex size-8 shrink-0 items-center justify-center rounded-lg transition-colors",
                  active
                    ? "bg-primary/15 text-foreground"
                    : "bg-muted/60 text-muted-foreground",
                )}
              >
                <Workflow className="size-4" />
              </div>

              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium leading-tight">
                  {it.name}
                </div>
                <div className="truncate text-[11px] text-muted-foreground">
                  {it.funcCount} funcs ·{" "}
                  {new Date(it.updatedAt).toLocaleDateString()}
                </div>
              </div>

              <button
                onClick={(e) => {
                  e.stopPropagation();
                  del.mutate(it.id);
                }}
                className="flex size-6 shrink-0 items-center justify-center rounded-lg text-muted-foreground opacity-0 transition-all hover:bg-destructive/15 hover:text-destructive group-hover:opacity-100"
                title="Delete"
              >
                <Trash2 className="size-3.5" />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
