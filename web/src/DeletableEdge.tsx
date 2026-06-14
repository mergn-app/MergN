import {
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  type EdgeProps,
} from "@xyflow/react";
import { Trash2 } from "lucide-react";

interface EdgeData {
  onDelete?: () => void;
  canDelete?: boolean;
  onInsert?: () => void;
  canInsert?: boolean;
}

export function DeletableEdge(props: EdgeProps) {
  const [path, labelX, labelY] = getBezierPath({
    sourceX: props.sourceX,
    sourceY: props.sourceY,
    sourcePosition: props.sourcePosition,
    targetX: props.targetX,
    targetY: props.targetY,
    targetPosition: props.targetPosition,
  });
  const data = (props.data ?? {}) as EdgeData;

  return (
    <>
      <BaseEdge id={props.id} path={path} style={props.style} />
      {(data.canDelete || data.canInsert) && (
        <EdgeLabelRenderer>
          <div
            className="pointer-events-auto absolute flex gap-1"
            style={{
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
            }}
          >
            {data.canInsert && data.onInsert && (
              <button
                className="rounded-full border border-border/60 bg-background px-1.5 py-0.5 text-[10px] text-muted-foreground opacity-80 transition hover:opacity-100 hover:text-foreground"
                onClick={(e) => {
                  e.stopPropagation();
                  data.onInsert?.();
                }}
                title="Add node manually"
              >
                +
              </button>
            )}
            {data.canDelete && data.onDelete && (
              <button
                className="rounded-full border border-border/60 bg-background p-1 text-muted-foreground opacity-80 transition hover:opacity-100 hover:text-foreground"
                onClick={(e) => {
                  e.stopPropagation();
                  data.onDelete?.();
                }}
                title="Delete edge"
              >
                <Trash2 className="h-3 w-3" />
              </button>
            )}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}
