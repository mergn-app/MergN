import { useTranslation } from "react-i18next";
import { useWorkflows } from "./queries";
import { cn } from "@/lib/utils";
import { Skeleton } from "@/components/ui/skeleton";
import { Workflow, Plus, PanelLeftClose, PanelLeftOpen } from "lucide-react";

export function WorkflowsPanel({
  currentId,
  onLoad,
  name,
  onName,
  onNew,
  minimized,
  onToggleMinimized,
}: {
  currentId: string | null;
  onLoad: (id: string) => void;
  name: string;
  onName: (value: string) => void;
  onNew: () => void;
  minimized: boolean;
  onToggleMinimized: () => void;
}) {
  const { t, i18n } = useTranslation();
  const { data: items = [], isLoading } = useWorkflows();

  return (
    <div className="flex h-full shrink-0 flex-col overflow-hidden rounded-2xl border border-border/40 bg-muted/40">
      <div className="border-b border-border/40 px-2.5 py-2">
        {minimized ? (
          <button
            onClick={onToggleMinimized}
            title="Expand panels"
            className="mx-auto flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <PanelLeftOpen className="size-4" />
          </button>
        ) : (
          <div className="flex items-center gap-1">
            <input
              value={name}
              onChange={(e) => onName(e.target.value)}
              placeholder={t("workflows.untitled")}
              spellCheck={false}
              title={name}
              className="min-w-0 flex-1 truncate bg-transparent text-sm font-medium text-foreground outline-none placeholder:text-muted-foreground/50"
            />
            <button
              onClick={onToggleMinimized}
              title="Minimize panels"
              className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <PanelLeftClose className="size-4" />
            </button>
          </div>
        )}
      </div>

      <div className="px-2 pt-2">
        <div className={cn("flex items-center rounded-lg bg-background-subtle px-2.5 py-1.5", minimized ? "justify-center gap-1" : "gap-2")}>
          {!minimized && (
            <span className="text-xs font-medium text-foreground/80">
              {t("workflows.saved")}
            </span>
          )}
          {!minimized && (
            <span className="rounded bg-muted/60 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground/70">
              {items.length}
            </span>
          )}
          <button
            onClick={onNew}
            title={t("workflows.newWorkflow")}
            className={cn(
              "flex size-5 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
              minimized ? "" : "ml-auto",
            )}
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
                "group flex cursor-pointer items-center rounded-xl border border-transparent px-2 py-2 transition-colors hover:bg-background-subtle",
                minimized ? "justify-center gap-0" : "gap-2.5",
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

              {!minimized && (
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium leading-tight">
                    {it.name}
                  </div>
                  <div className="truncate text-[11px] text-muted-foreground">
                    {t("workflows.meta", {
                      n: it.funcCount,
                      date: new Date(it.updatedAt).toLocaleDateString(i18n.language),
                    })}
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
