import { createPortal } from "react-dom";
import { useState } from "react";
import { X, History, RotateCcw, Check } from "lucide-react";
import {
  useWorkflowVersions,
  useCreateCheckpoint,
  useRestoreVersion,
  type WorkflowVersionMeta,
} from "./queries";

// Version-history panel: list + checkpoint + restore.
const SOURCE_LABEL: Record<WorkflowVersionMeta["source"], string> = {
  editor: "Edit",
  chat: "AI chat",
  mcp: "MCP",
  "run-snapshot": "Run",
  healing: "Self-heal",
  restore: "Restore",
};

export function VersionHistory({
  workflowId,
  onClose,
  onRestored,
}: {
  workflowId: string;
  onClose: () => void;
  onRestored: () => void;
}) {
  const versions = useWorkflowVersions(workflowId);
  const checkpoint = useCreateCheckpoint(workflowId);
  const restore = useRestoreVersion(workflowId);
  const [label, setLabel] = useState("");
  const [confirmId, setConfirmId] = useState<string | null>(null);

  const save = () => {
    checkpoint.mutate(
      { label: label.trim() || undefined },
      { onSuccess: () => setLabel("") },
    );
  };

  const doRestore = (id: string) => {
    restore.mutate(id, {
      onSuccess: () => {
        setConfirmId(null);
        onRestored();
      },
    });
  };

  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        className="flex max-h-[85vh] w-full max-w-md flex-col rounded-2xl border border-border/50 bg-card"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-border/40 px-5 py-3">
          <History className="size-4 text-muted-foreground" />
          <span className="text-sm font-semibold">Version history</span>
          <button
            onClick={onClose}
            className="ml-auto text-muted-foreground hover:text-foreground"
          >
            <X className="size-4" />
          </button>
        </div>

        {/* checkpoint */}
        <div className="flex items-center gap-2 border-b border-border/40 px-5 py-3">
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Label (optional)"
            className="flex-1 rounded-lg border border-border/50 bg-background px-3 py-1.5 text-xs outline-none focus:border-border"
            onKeyDown={(e) => e.key === "Enter" && save()}
          />
          <button
            onClick={save}
            disabled={checkpoint.isPending}
            className="rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50"
          >
            Save version
          </button>
        </div>
        {checkpoint.data?.deduped && (
          <p className="px-5 pt-2 text-[11px] text-muted-foreground">
            No changes since the last version.
          </p>
        )}

        {/* list */}
        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
          {versions.isLoading && (
            <p className="px-2 py-3 text-xs text-muted-foreground">Loading…</p>
          )}
          {versions.data?.length === 0 && (
            <p className="px-2 py-3 text-xs text-muted-foreground">
              No versions yet — save one above.
            </p>
          )}
          <div className="space-y-1">
            {versions.data?.map((v) => (
              <div
                key={v.id}
                className="flex items-center gap-2 rounded-lg border border-border/50 px-3 py-2"
              >
                <span className="w-7 shrink-0 text-xs font-medium text-muted-foreground">
                  v{v.seq}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                      {SOURCE_LABEL[v.source]}
                    </span>
                    {v.label && (
                      <span className="truncate text-xs font-medium">
                        {v.label}
                      </span>
                    )}
                  </div>
                  <div className="text-[10px] text-muted-foreground">
                    {new Date(v.createdAt).toLocaleString()}
                  </div>
                </div>
                {confirmId === v.id ? (
                  <button
                    onClick={() => doRestore(v.id)}
                    disabled={restore.isPending}
                    className="flex items-center gap-1 rounded-md bg-amber-500/15 px-2 py-1 text-[11px] font-medium text-amber-600 disabled:opacity-50 dark:text-amber-400"
                  >
                    <Check className="size-3" /> Confirm
                  </button>
                ) : (
                  <button
                    onClick={() => setConfirmId(v.id)}
                    title="Restore this version"
                    className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                  >
                    <RotateCcw className="size-3.5" />
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
