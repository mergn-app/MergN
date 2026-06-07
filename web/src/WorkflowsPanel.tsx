import { useWorkflows, useDeleteWorkflow } from "./queries";
import { cn } from "@/lib/utils";
import { Skeleton } from "@/components/ui/skeleton";
import { Workflow, Trash2, Plus } from "lucide-react";

export function WorkflowsPanel({
  currentId,
  onLoad,
  name,
  onName,
  onSave,
  saving,
  canSave,
  onNew,
}: {
  currentId: string | null;
  onLoad: (id: string) => void;
  name: string;
  onName: (value: string) => void;
  onSave: () => void;
  saving: boolean;
  canSave: boolean;
  onNew: () => void;
}) {
  const { data: items = [], isLoading } = useWorkflows();
  const del = useDeleteWorkflow();

  return (
    <div className="flex h-full w-60 shrink-0 flex-col overflow-hidden rounded-2xl border border-border/40 bg-muted/40">
      <div className="flex items-center gap-1 border-b border-border/40 px-3 py-2.5">
        <input
          value={name}
          onChange={(e) => onName(e.target.value)}
          placeholder="Untitled workflow"
          spellCheck={false}
          className="min-w-0 flex-1 bg-transparent text-sm font-medium text-foreground outline-none placeholder:text-muted-foreground/50"
        />
        <button
          onClick={onSave}
          disabled={!canSave || saving}
          className="shrink-0 rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:pointer-events-none disabled:opacity-40"
        >
          {saving ? "saving…" : "Save"}
        </button>
      </div>

      <div className="px-2 pt-2">
        <div className="flex items-center gap-2 rounded-lg bg-background-subtle px-2.5 py-1.5">
          <span className="text-xs font-medium text-foreground/80">Saved</span>
          <span className="rounded bg-muted/60 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground/70">
            {items.length}
          </span>
          <button
            onClick={onNew}
            title="New workflow"
            className="ml-auto flex size-5 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <Plus className="size-4" />
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 space-y-1 overflow-auto p-2">
        {isLoading &&
          Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="flex items-center gap-2.5 px-2 py-2">
              <Skeleton className="size-8 shrink-0 rounded-lg" />
              <div className="min-w-0 flex-1 space-y-1.5">
                <Skeleton className="h-3 w-3/4" />
                <Skeleton className="h-2.5 w-1/2" />
              </div>
            </div>
          ))}
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
