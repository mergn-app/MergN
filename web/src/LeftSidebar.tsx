import { cn } from "@/lib/utils";
import { WorkflowsPanel } from "./WorkflowsPanel";
import { ConnectionsPanel } from "./ConnectionsPanel";

export function LeftSidebar({
  minimized,
  onMinimize,
  onExpand,
  currentId,
  onLoad,
  name,
  onName,
  onNew,
  missing,
}: {
  minimized: boolean;
  onMinimize: () => void;
  onExpand: () => void;
  currentId: string | null;
  onLoad: (id: string) => void;
  name: string;
  onName: (value: string) => void;
  onNew: () => void;
  missing: string[];
}) {
  return (
    <div
      className={cn(
        "flex shrink-0 flex-col gap-2 overflow-hidden transition-[width] duration-300 ease-in-out motion-reduce:transition-none",
        minimized ? "w-16" : "w-60",
      )}
    >
      <div className="min-h-0 flex-1">
        <WorkflowsPanel
          minimized={minimized}
          currentId={currentId}
          onLoad={onLoad}
          name={name}
          onName={onName}
          onMinimize={onMinimize}
          onExpand={onExpand}
          onNew={onNew}
        />
      </div>
      <ConnectionsPanel missing={missing} minimized={minimized} />
    </div>
  );
}
