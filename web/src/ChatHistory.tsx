import { useTranslation } from "react-i18next";
import { Trash2, Plus } from "lucide-react";
import { cn } from "@/lib/utils";
import { Skeleton } from "@/components/ui/skeleton";
import type { ConversationMeta } from "./queries";

function relTime(iso: string, locale: string): string {
  const d = new Date(iso);
  const diff = Date.now() - d.getTime();
  const day = 86_400_000;
  if (diff < 7 * day && diff >= 0) {
    const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
    if (diff < 3_600_000)
      return rtf.format(-Math.max(1, Math.floor(diff / 60_000)), "minute");
    if (diff < day) return rtf.format(-Math.floor(diff / 3_600_000), "hour");
    return rtf.format(-Math.floor(diff / day), "day");
  }
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString(
    locale,
    sameYear
      ? { day: "numeric", month: "short" }
      : { day: "numeric", month: "short", year: "numeric" },
  );
}

const CARD =
  "rounded-2xl border border-dashed px-4 py-3.5 transition-colors cursor-pointer";

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
  const { t, i18n } = useTranslation();
  return (
    <div className="flex h-full w-full flex-col">
      <div className="min-h-0 flex-1 space-y-2.5 overflow-auto p-3">
        {/* New chat — same card style as the items, pinned to the top */}
        <div
          onClick={onNew}
          className={cn(
            CARD,
            "flex items-center gap-2 border-border/50 font-medium text-foreground hover:border-border hover:bg-background-subtle/60",
          )}
        >
          <Plus className="size-4" />
          {t("history.newChat")}
        </div>

        {isLoading &&
          Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className={cn(CARD, "border-border/60")}>
              <Skeleton className="mb-2 h-4 w-3/4" />
              <Skeleton className="h-3 w-1/4" />
            </div>
          ))}

        {!isLoading &&
          conversations.map((c) => {
            const active = c.id === currentId;
            return (
              <div
                key={c.id}
                onClick={() => onSelect(c.id)}
                className={cn(
                  CARD,
                  "group relative",
                  active
                    ? "border-border bg-background-subtle"
                    : "border-border/50 hover:border-border hover:bg-background-subtle/60",
                )}
              >
                <div className="truncate pr-7 text-[15px] font-medium leading-tight text-foreground">
                  {c.title}
                </div>
                <div className="mt-1 text-xs text-muted-foreground">
                  {relTime(c.updatedAt, i18n.language)}
                </div>

                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onDelete(c.id);
                  }}
                  className="absolute right-3 top-1/2 flex size-6 -translate-y-1/2 items-center justify-center rounded-lg text-muted-foreground opacity-0 transition-all hover:bg-destructive/15 hover:text-destructive group-hover:opacity-100"
                  title={t("common.delete")}
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
