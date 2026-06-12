import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { AlertCircle, AlertTriangle, Info, Trash2, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import { useLogs, clearLogs, type LogEntry } from "./queries";

const LEVEL: Record<
  string,
  { icon: typeof AlertCircle; cls: string }
> = {
  error: { icon: AlertCircle, cls: "text-rose-400" },
  warn: { icon: AlertTriangle, cls: "text-amber-400" },
  info: { icon: Info, cls: "text-sky-400" },
};

function fmtTime(ts: string): string {
  const d = new Date(ts);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  const t = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  return sameDay ? t : `${d.toLocaleDateString([], { day: "2-digit", month: "2-digit" })} ${t}`;
}

function Row({ e }: { e: LogEntry }) {
  const [open, setOpen] = useState(false);
  const lv = LEVEL[e.level] ?? LEVEL.info;
  const Icon = lv.icon;
  const hasDetail = !!e.detail;
  return (
    <button
      type="button"
      onClick={() => hasDetail && setOpen((o) => !o)}
      className={cn(
        "w-full border-b border-border/30 px-3 py-2 text-left transition-colors hover:bg-background-subtle/60",
        hasDetail ? "cursor-pointer" : "cursor-default",
      )}
    >
      <div className="flex items-start gap-2">
        <Icon className={cn("mt-0.5 size-3.5 shrink-0", lv.cls)} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="font-mono text-[10px] text-muted-foreground">
              {fmtTime(e.ts)}
            </span>
            <span className="rounded bg-muted px-1.5 py-px text-[10px] uppercase tracking-wide text-muted-foreground">
              {e.source}
            </span>
          </div>
          <p className="mt-0.5 break-words text-xs text-foreground/90">{e.message}</p>
          {hasDetail && (
            <pre
              className={cn(
                "mt-1 overflow-x-auto whitespace-pre-wrap break-words rounded bg-background-subtle px-2 py-1 font-mono text-[11px] text-muted-foreground",
                open ? "block" : "line-clamp-1",
              )}
            >
              {e.detail}
            </pre>
          )}
        </div>
      </div>
    </button>
  );
}

export function LogsPanel({ active }: { active: boolean }) {
  const qc = useQueryClient();
  const { data, isLoading, refetch, isFetching } = useLogs(active);
  const logs = data ?? [];

  const onClear = async () => {
    await clearLogs().catch(() => {});
    qc.setQueryData(["logs"], []);
    void refetch();
  };

  return (
    <div className="flex h-full w-full flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-border/30 px-3 py-2">
        <span className="text-xs font-medium text-foreground">Loglar</span>
        <span className="text-[11px] text-muted-foreground">{logs.length}</span>
        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            onClick={() => refetch()}
            title="Yenile"
            className="rounded p-1 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
          >
            <RefreshCw className={cn("size-3.5", isFetching && "animate-spin")} />
          </button>
          <button
            type="button"
            onClick={onClear}
            title="Temizle"
            disabled={!logs.length}
            className="rounded p-1 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground disabled:opacity-40"
          >
            <Trash2 className="size-3.5" />
          </button>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {isLoading ? (
          <p className="px-3 py-4 text-xs text-muted-foreground">Yükleniyor…</p>
        ) : logs.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-1 px-6 text-center">
            <Info className="size-5 text-muted-foreground/50" />
            <p className="text-xs text-muted-foreground">Henüz log yok</p>
            <p className="text-[11px] text-muted-foreground/70">
              Build, çalıştırma ve bağlantı hataları burada görünür.
            </p>
          </div>
        ) : (
          logs.map((e) => <Row key={e.id} e={e} />)
        )}
      </div>
    </div>
  );
}
