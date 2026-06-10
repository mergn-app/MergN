import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Code2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { Skeleton } from "@/components/ui/skeleton";
import { useConnections, type ConnectionMeta } from "./queries";
import { ConnectionDialog } from "./ConnectionDialog";
import { ProviderCodeDialog } from "./ProviderCodeDialog";

interface Row {
  provider: string;
  connection?: ConnectionMeta;
}

export function ConnectionsPanel({
  missing,
  theme,
}: {
  missing: string[];
  theme: "dark" | "light";
}) {
  const { t } = useTranslation();
  const { data: items = [], isLoading } = useConnections();
  const [open, setOpen] = useState<Row | null>(null);
  const [codeProvider, setCodeProvider] = useState<string | null>(null);

  const rows: Row[] = [
    ...missing.map((p) => ({ provider: p, connection: undefined })),
    ...items.map((c) => ({ provider: c.provider, connection: c })),
  ];

  return (
    <div className="flex h-64 shrink-0 flex-col overflow-hidden rounded-2xl border border-border/40 bg-muted/40">
      <div className="px-2 pt-2">
        <div className="flex items-center gap-2 rounded-lg bg-background-subtle px-2.5 py-1.5">
          <span className="text-xs font-medium text-foreground/80">
            {t("connections.title")}
          </span>
          <span className="rounded bg-muted/60 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground/70">
            {items.length}
          </span>
        </div>
      </div>

      <div className="min-h-0 flex-1 space-y-0.5 overflow-auto p-2">
        {isLoading &&
          Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="flex items-center gap-2.5 px-2 py-2">
              <Skeleton className="size-2 shrink-0 rounded-full" />
              <Skeleton className="h-3 flex-1" />
              <Skeleton className="h-2.5 w-12" />
            </div>
          ))}
        {!isLoading && rows.length === 0 && (
          <div className="px-2 py-6 text-center text-xs text-muted-foreground">
            {t("connections.empty")}
          </div>
        )}

        {rows.map((r, i) => {
          const connected = !!r.connection;
          return (
            <div
              key={`${r.provider}-${r.connection?.id ?? i}`}
              className="group flex items-center gap-1 rounded-xl pr-1 transition-colors hover:bg-background-subtle"
            >
              <button
                onClick={() => setOpen(r)}
                className="flex min-w-0 flex-1 items-center gap-2.5 px-2 py-2 text-left"
              >
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
                    {r.connection?.account ?? r.provider}
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
              </button>
              <button
                onClick={() => setCodeProvider(r.provider)}
                title={t("connections.viewCode")}
                className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-all hover:bg-muted hover:text-foreground group-hover:opacity-100"
              >
                <Code2 className="size-3.5" />
              </button>
            </div>
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
      {codeProvider && (
        <ProviderCodeDialog
          provider={codeProvider}
          theme={theme}
          onClose={() => setCodeProvider(null)}
        />
      )}
    </div>
  );
}
