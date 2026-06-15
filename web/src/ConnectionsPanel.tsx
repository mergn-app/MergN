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
  const detail = (hidden?: boolean) =>
    cn(
      "overflow-hidden transition-[opacity,max-width] duration-300 ease-in-out motion-reduce:transition-none",
      hidden ? "max-w-0 opacity-0" : "max-w-full opacity-100",
    );

  return (
    <div className="flex h-64 w-full shrink-0 flex-col overflow-hidden rounded-2xl border border-border/40 bg-muted/40">
      <div className="px-2 pt-2">
        <div className="relative flex min-h-9 items-center justify-center rounded-lg bg-background-subtle px-2.5 py-1.5">
          <Link2
            className={cn(
              "size-3.5 shrink-0 text-foreground/80 transition-[opacity,transform] duration-300 ease-in-out motion-reduce:transition-none",
              minimized
                ? "scale-100 opacity-100"
                : "pointer-events-none absolute scale-95 opacity-0",
            )}
          />
          <div
            className={cn(
              "flex w-full items-center gap-2 transition-[opacity,transform] duration-300 ease-in-out motion-reduce:transition-none",
              minimized
                ? "pointer-events-none scale-95 opacity-0"
                : "scale-100 opacity-100",
            )}
          >
            <span className="text-xs font-medium text-foreground/80">
              {t("connections.title")}
            </span>
            <span className="rounded bg-muted/60 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground/70">
              {items.length}
            </span>
          </div>
        </div>
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
              <Skeleton className="size-2 shrink-0 rounded-full" />
              {!minimized && (
                <>
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
                "flex w-full items-center gap-2.5 rounded-xl px-2 py-2 text-left transition-[colors,justify-content] duration-300 ease-in-out hover:bg-background-subtle",
                minimized && "justify-center",
              )}
            >
              <span
                className={cn(
                  "size-2 shrink-0 rounded-full",
                  connected ? "bg-emerald-500" : "bg-amber-500",
                )}
              />
              <div className={cn(detail(minimized), "min-w-0 flex-1")}>
                <span
                  className={cn(
                    "block truncate text-xs font-medium",
                    !r.connection?.account && "font-mono",
                  )}
                >
                  {label}
                </span>
                {r.connection?.account && (
                  <span className="block truncate font-mono text-[11px] text-muted-foreground">
                    {r.provider}
                  </span>
                )}
              </div>
              <div className={detail(minimized)}>
                <span
                  className={cn(
                    "whitespace-nowrap text-[11px]",
                    connected ? "text-muted-foreground" : "text-amber-300/80",
                  )}
                >
                  {connected
                    ? t("connections.connected")
                    : t("connections.connect")}
                </span>
              </div>
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
