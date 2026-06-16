import {
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  type EdgeProps,
} from "@xyflow/react";

// Conditional-gate edge: a dashed amber link from a decision output to the step
// it gates, with the condition shown as a chip on the edge. The chip uses the
// app's design tokens (bg-card / border / radius / text scale) so it reads as
// part of the UI in both light and dark themes — not a raw SVG label.
export function GateEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
  markerEnd,
}: EdgeProps) {
  const [path, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });
  const label = (data as { label?: string } | undefined)?.label;

  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        markerEnd={markerEnd}
        style={{ stroke: "#f59e0b", strokeWidth: 1.5, strokeDasharray: "5 4" }}
      />
      {label && (
        <EdgeLabelRenderer>
          <div
            style={{
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
            }}
            className="nodrag nopan pointer-events-none absolute flex items-center gap-1 rounded-md border border-amber-500/40 bg-card px-1.5 py-0.5 text-[11px] font-medium leading-none text-amber-600 shadow-sm dark:text-amber-400"
          >
            {/* literal "IF" (not CSS uppercase) — text-transform is locale-aware
                and turns "if" into "İF" in Turkish */}
            <span className="font-mono text-[10px] tracking-wide opacity-70">IF</span>
            <span className="text-foreground/80">{label}</span>
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}
