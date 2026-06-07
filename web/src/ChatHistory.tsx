import { MessageSquare, Trash2, Plus } from "lucide-react";
import { cn } from "@/lib/utils";
import { Skeleton } from "@/components/ui/skeleton";
import type { ConversationMeta } from "./queries";

export function ChatHistory({
  conversations,
  isLoading,
  currentId,
  onSelect,
  onNew,
  onDelete,
}: {
  conversations: ConversationMeta[];
  isLoading: boolean;
  currentId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
}) {
  return (
    <div className="flex h-full w-full flex-col">
      <div className="px-2 pt-2">
        <button
          onClick={onNew}
          className="flex w-full items-center gap-2 rounded-lg bg-background-subtle px-2.5 py-1.5 text-left text-xs font-medium text-foreground/80 transition-colors hover:bg-secondary"
        >
          <Plus className="size-4" />
          New chat
        </button>
      </div>

      <div className="min-h-0 flex-1 space-y-1 overflow-auto p-2">
        {isLoading &&
          Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="flex items-center gap-2.5 px-2 py-2">
              <Skeleton className="size-8 shrink-0 rounded-lg" />
              <div className="min-w-0 flex-1 space-y-1.5">
                <Skeleton className="h-3 w-3/4" />
                <Skeleton className="h-2.5 w-1/3" />
              </div>
            </div>
          ))}

        {!isLoading && conversations.length === 0 && (
          <div className="px-2 py-6 text-center text-xs text-muted-foreground">
            No conversations yet.
          </div>
        )}

        {conversations.map((c) => {
          const active = c.id === currentId;
          return (
            <div
              key={c.id}
              onClick={() => onSelect(c.id)}
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
                <MessageSquare className="size-4" />
              </div>

              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium leading-tight">
                  {c.title}
                </div>
                <div className="truncate text-[11px] text-muted-foreground">
                  {new Date(c.updatedAt).toLocaleString()}
                </div>
              </div>

              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete(c.id);
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
