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
      <div className="px-3 pt-3">
        <button
          onClick={onNew}
          className="flex w-full items-center justify-center gap-2 rounded-xl bg-primary px-3 py-2 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90"
        >
          <Plus className="size-4" />
          {t("history.newChat")}
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto px-3 pb-2 pt-4">
        <p className="mb-2.5 px-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground/70">
          {t("history.recentChats")}
        </p>

        {isLoading && (
          <div className="space-y-2.5">
            {Array.from({ length: 5 }).map((_, i) => (
              <div
                key={i}
                className="rounded-2xl border border-dashed border-border/60 px-4 py-3.5"
              >
                <Skeleton className="mb-2 h-4 w-3/4" />
                <Skeleton className="h-3 w-1/4" />
              </div>
            ))}
          </div>
        )}

        {!isLoading && conversations.length === 0 && (
          <div className="px-2 py-6 text-center text-xs text-muted-foreground">
            {t("history.empty")}
          </div>
        )}

        <div className="space-y-2.5">
          {conversations.map((c) => {
            const active = c.id === currentId;
            return (
              <div
                key={c.id}
                onClick={() => onSelect(c.id)}
                className={cn(
                  "group relative cursor-pointer rounded-2xl border border-dashed px-4 py-3.5 transition-colors",
                  active
                    ? "border-border bg-background-subtle"
                    : "border-border/50 hover:border-border hover:bg-background-subtle/60",
                )}
              >
                <div className="truncate pr-6 text-[15px] font-medium leading-tight text-foreground">
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
                  className="absolute right-3 top-3 flex size-6 items-center justify-center rounded-lg text-muted-foreground opacity-0 transition-all hover:bg-destructive/15 hover:text-destructive group-hover:opacity-100"
                  title={t("common.delete")}
                >
                  <Trash2 className="size-3.5" />
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
