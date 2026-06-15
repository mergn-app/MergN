import { useTranslation } from "react-i18next";
import { useWorkflows, useDeleteWorkflow } from "./queries";
import { cn } from "@/lib/utils";
import { Skeleton } from "@/components/ui/skeleton";
import { Workflow, Trash2, Plus, PanelLeftClose, PanelLeftOpen } from "lucide-react";

export function WorkflowsPanel({
  currentId,
  onLoad,
  name,
  onName,
  onMinimize,
  onExpand,
  onNew,
  minimized,
}: {
  currentId: string | null;
  onLoad: (id: string) => void;
  name: string;
  onName: (value: string) => void;
  onMinimize?: () => void;
  onExpand?: () => void;
  onNew: () => void;
  minimized?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const { data: items = [], isLoading } = useWorkflows();
  const del = useDeleteWorkflow();

  return (
    <div
      className={cn(
        "flex h-full shrink-0 flex-col overflow-hidden rounded-2xl border border-border/40 bg-muted/40",
        minimized ? "w-16" : "w-60",
      )}
    >
      <div
        className={cn(
          "flex items-center gap-1 border-b border-border/40 px-3 py-2.5",
          minimized && "justify-center",
        )}
      >
        {minimized ? (
          <button
            onClick={onExpand}
            title={t("workflows.expandPanel")}
            className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <PanelLeftOpen className="size-4" />
          </button>
        ) : (
          <>
            <input
              value={name}
              onChange={(e) => onName(e.target.value)}
              placeholder={t("workflows.untitled")}
              spellCheck={false}
              title={name}
              className="min-w-0 flex-1 truncate bg-transparent text-sm font-medium text-foreground outline-none placeholder:text-muted-foreground/50"
            />
            <button
              onClick={onMinimize}
              title={t("workflows.minimizePanel")}
              className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <PanelLeftClose className="size-4" />
            </button>
          </>
        )}
      </div>

      <div className="px-2 pt-2">
        {minimized ? (
          <button
            onClick={onNew}
            title={t("workflows.newWorkflow")}
            className="mx-auto flex size-10 items-center justify-center rounded-lg bg-background-subtle text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <Plus className="size-5" />
          </button>
        ) : (
          <div className="flex items-center gap-2 rounded-lg bg-background-subtle px-2.5 py-1.5">
            <span className="text-xs font-medium text-foreground/80">
              {t("workflows.saved")}
            </span>
            <span className="rounded bg-muted/60 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground/70">
              {items.length}
            </span>
            <button
              onClick={onNew}
              title={t("workflows.newWorkflow")}
              className="ml-auto flex size-9 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <Plus className="size-5" />
            </button>
          </div>
        )}
      </div>

      <div className="min-h-0 flex-1 space-y-1 overflow-auto p-2">
        {isLoading &&
          Array.from({ length: 5 }).map((_, i) => (
            <div
              key={i}
              className={cn(
                "flex items-center gap-2.5 px-2 py-2",
                minimized && "justify-center",
              )}
            >
              <Skeleton className="size-8 shrink-0 rounded-lg" />
              {!minimized && (
                <div className="min-w-0 flex-1 space-y-1.5">
                  <Skeleton className="h-3 w-3/4" />
                  <Skeleton className="h-2.5 w-1/2" />
                </div>
              )}
            </div>
          ))}
        {!isLoading && items.length === 0 && !minimized && (
          <div className="px-2 py-6 text-center text-xs text-muted-foreground">
            {t("workflows.empty")}
          </div>
        )}
        {items.map((it) => {
          const active = it.id === currentId;
          return (
            <div
              key={it.id}
              onClick={() => onLoad(it.id)}
              title={it.name}
              className={cn(
                "group flex cursor-pointer items-center gap-2.5 rounded-xl border border-transparent px-2 py-2 transition-colors hover:bg-background-subtle",
                active && "border-border/60 bg-background-subtle",
                minimized && "justify-center",
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

              {!minimized && (
                <>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium leading-tight">
                      {it.name}
                    </div>
                    <div className="truncate text-[11px] text-muted-foreground">
                      {t("workflows.meta", {
                        n: it.funcCount,
                        date: new Date(it.updatedAt).toLocaleDateString(
                          i18n.language,
                        ),
                      })}
                    </div>
                  </div>

                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      del.mutate(it.id);
                    }}
                    className="flex size-6 shrink-0 items-center justify-center rounded-lg text-muted-foreground opacity-0 transition-all hover:bg-destructive/15 hover:text-destructive group-hover:opacity-100"
                    title={t("common.delete")}
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                </>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
