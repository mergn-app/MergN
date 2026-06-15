import { useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { Skeleton } from "@/components/ui/skeleton";
import { Link2 } from "lucide-react";
import { useConnections, type ConnectionMeta } from "./queries";
import { ConnectionDialog } from "./ConnectionDialog";

interface Row {
  provider: string;
  connection?: ConnectionMeta;
}

export function ConnectionsPanel({
  missing,
  minimized,
}: {
  missing: string[];
  minimized?: boolean;
}) {
  const { t } = useTranslation();
  const { data: items = [], isLoading } = useConnections();
  const [open, setOpen] = useState<Row | null>(null);

  const rows: Row[] = [
    ...missing.map((p) => ({ provider: p, connection: undefined })),
    ...items.map((c) => ({ provider: c.provider, connection: c })),
  ];

  return (
    <div className="flex h-64 w-full shrink-0 flex-col overflow-hidden rounded-2xl border border-border/40 bg-muted/40">
      <div className="px-2 pt-2">
        {minimized ? (
          <div className="flex items-center justify-center rounded-lg bg-background-subtle px-2.5 py-2.5">
            <Link2 className="size-3.5 shrink-0 text-foreground/80" />
          </div>
        ) : (
          <div className="flex items-center gap-2 rounded-lg bg-background-subtle px-2.5 py-1.5">
            <span className="text-xs font-medium text-foreground/80">
              {t("connections.title")}
            </span>
            <span className="rounded bg-muted/60 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground/70">
              {items.length}
            </span>
          </div>
        )}
      </div>

      <div className="min-h-0 flex-1 space-y-0.5 overflow-auto p-2">
        {isLoading &&
          Array.from({ length: 4 }).map((_, i) => (
            <div
              key={i}
              className={cn(
                "flex items-center gap-2.5 px-2 py-2",
                minimized && "justify-center",
              )}
            >
              {minimized ? (
                <Skeleton className="size-8 shrink-0 rounded-lg" />
              ) : (
                <>
                  <Skeleton className="size-2 shrink-0 rounded-full" />
                  <Skeleton className="h-3 flex-1" />
                  <Skeleton className="h-2.5 w-12" />
                </>
              )}
            </div>
          ))}
        {!isLoading && rows.length === 0 && !minimized && (
          <div className="px-2 py-6 text-center text-xs text-muted-foreground">
            {t("connections.empty")}
          </div>
        )}

        {rows.map((r, i) => {
          const connected = !!r.connection;
          const label = r.connection?.account ?? r.provider;
          return (
            <button
              key={`${r.provider}-${r.connection?.id ?? i}`}
              onClick={() => setOpen(r)}
              title={label}
              className={cn(
                "flex w-full rounded-xl px-2 transition-colors hover:bg-background-subtle",
                minimized
                  ? "justify-center py-1"
                  : "items-center gap-2.5 py-2 text-left",
              )}
            >
              {minimized ? (
                <span className="flex size-6 shrink-0 items-center justify-center rounded-lg">
                  <span
                    className={cn(
                      "size-2 shrink-0 rounded-full",
                      connected ? "bg-emerald-500" : "bg-amber-500",
                    )}
                  />
                </span>
              ) : (
                <>
                  <span
                    className={cn(
                      "size-2 shrink-0 rounded-full",
                      connected ? "bg-emerald-500" : "bg-amber-500",
                    )}
                  />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span
                      className={cn(
                        "truncate text-xs font-medium",
                        !r.connection?.account && "font-mono",
                      )}
                    >
                      {label}
                    </span>
                    {r.connection?.account && (
                      <span className="truncate font-mono text-[11px] text-muted-foreground">
                        {r.provider}
                      </span>
                    )}
                  </span>
                  <span
                    className={cn(
                      "text-[11px]",
                      connected ? "text-muted-foreground" : "text-amber-300/80",
                    )}
                  >
                    {connected
                      ? t("connections.connected")
                      : t("connections.connect")}
                  </span>
                </>
              )}
            </button>
          );
        })}
      </div>

      {open && (
        <ConnectionDialog
          provider={open.provider}
          connection={open.connection}
          onClose={() => setOpen(null)}
        />
      )}
    </div>
  );
}
