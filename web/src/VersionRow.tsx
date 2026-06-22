import { useTranslation } from "react-i18next";
import {
  Wrench,
  RotateCcw,
  GitCommit,
  Pencil,
  MessageSquare,
  Plug,
  Play,
  ChevronRight,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { WorkflowVersionMeta, FixEvent } from "./queries";

// One visual language for history entries — shared by the editor's Versions tab and
// the monitoring History panel, so a version looks identical wherever it appears.

type SourceStyle = { icon: LucideIcon; fg: string; bg: string };
const SOURCE: Record<string, SourceStyle> = {
  healing: { icon: Wrench, fg: "text-emerald-600 dark:text-emerald-400", bg: "bg-emerald-500/10" },
  restore: { icon: RotateCcw, fg: "text-sky-600 dark:text-sky-400", bg: "bg-sky-500/10" },
  editor: { icon: Pencil, fg: "text-muted-foreground", bg: "bg-muted" },
  chat: { icon: MessageSquare, fg: "text-violet-600 dark:text-violet-400", bg: "bg-violet-500/10" },
  mcp: { icon: Plug, fg: "text-amber-600 dark:text-amber-400", bg: "bg-amber-500/10" },
  "run-snapshot": { icon: Play, fg: "text-muted-foreground", bg: "bg-muted" },
};
const FALLBACK: SourceStyle = { icon: GitCommit, fg: "text-muted-foreground", bg: "bg-muted" };

export function VersionRow({ v, time, onClick }: { v: WorkflowVersionMeta; time: string; onClick: () => void }) {
  const { t } = useTranslation();
  const s = SOURCE[v.source] ?? FALLBACK;
  const Icon = s.icon;
  return (
    <button
      onClick={onClick}
      className="group flex w-full items-center gap-3 rounded-xl border border-border/40 bg-background-subtle/30 px-3 py-2.5 text-left transition-all hover:border-border/70 hover:bg-background-subtle"
    >
      <span className={cn("grid size-8 shrink-0 place-items-center rounded-lg", s.bg)}>
        <Icon className={cn("size-4", s.fg)} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-[13px] font-semibold leading-none">v{v.seq}</span>
          <span className={cn("rounded-full px-2 py-0.5 text-[10px] font-medium", s.bg, s.fg)}>{t(`versions.source.${v.source}`)}</span>
          {v.label && <span className="truncate text-xs text-muted-foreground">{v.label}</span>}
          <span className="ml-auto shrink-0 text-[10px] text-muted-foreground/50">{time}</span>
        </div>
        {v.healing?.diagnosis && <div className="mt-1 line-clamp-1 text-[11px] text-muted-foreground/80">{v.healing.diagnosis}</div>}
      </div>
      <ChevronRight className="size-4 shrink-0 text-muted-foreground/25 transition group-hover:translate-x-0.5 group-hover:text-muted-foreground/60" />
    </button>
  );
}

export function FixRow({ e, time, onClick }: { e: FixEvent; time: string; onClick: () => void }) {
  const { t } = useTranslation();
  return (
    <button
      onClick={onClick}
      className="group flex w-full items-center gap-3 rounded-xl border border-amber-500/40 bg-amber-500/5 px-3 py-2.5 text-left transition-all hover:border-amber-500/60 hover:bg-amber-500/10"
    >
      <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-amber-500/15">
        <Wrench className="size-4 text-amber-500" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-400">{t("heal.status.proposed")}</span>
          <span className="text-[10px] text-muted-foreground/70">{t(`heal.mode.${e.mode}`)}</span>
          <span className="ml-auto shrink-0 text-[10px] text-muted-foreground/50">{time}</span>
        </div>
        <div className="mt-1 line-clamp-2 text-xs text-foreground/90">{e.diagnosis || t("heal.status.proposed")}</div>
      </div>
      <ChevronRight className="size-4 shrink-0 text-amber-500/40 transition group-hover:translate-x-0.5 group-hover:text-amber-500/70" />
    </button>
  );
}
