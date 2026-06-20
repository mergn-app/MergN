import { useTranslation } from "react-i18next";
import { Plus } from "lucide-react";
import { useWorkflowVersions, useCreateCheckpoint, type WorkflowVersionMeta } from "./queries";
import { VersionRow } from "./VersionRow";

const fmt = (iso: string) => new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

// Editor side-panel tab: the workflow's version timeline as a vertical list.
// Clicking a version opens the change-review diff (NOT a restore confirm) — the
// restore action lives inside that review ("switch to this version").
export function VersionsPanel({ workflowId, onOpen }: { workflowId: string | null; onOpen: (v: WorkflowVersionMeta) => void }) {
  const { t } = useTranslation();
  const versions = useWorkflowVersions(workflowId).data ?? [];
  const checkpoint = useCreateCheckpoint(workflowId);

  if (!workflowId) {
    return (
      <div className="flex h-full w-full items-center justify-center p-4 text-center text-xs text-muted-foreground/70">
        {t("run.saveForHistory")}
      </div>
    );
  }
  return (
    <div className="flex w-full flex-col">
      <div className="flex shrink-0 items-center gap-2 px-3 py-2">
        <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/60">{t("panel.versions")}</span>
        {checkpoint.data?.deduped && <span className="text-[10px] text-muted-foreground">{t("versions.noChange")}</span>}
        <button
          onClick={() => checkpoint.mutate({})}
          disabled={checkpoint.isPending}
          title={t("versions.save")}
          className="ml-auto grid size-7 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40"
        >
          <Plus className="size-4" />
        </button>
      </div>
      <div className="min-h-0 flex-1 space-y-1.5 overflow-auto p-2 pt-0">
        {versions.length === 0 ? (
          <div className="flex h-full items-center justify-center p-4 text-center text-xs text-muted-foreground/70">{t("versions.empty")}</div>
        ) : (
          versions.map((v) => <VersionRow key={v.id} v={v} time={fmt(v.createdAt)} onClick={() => onOpen(v)} />)
        )}
      </div>
    </div>
  );
}
