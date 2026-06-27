import { useState } from "react";
import {
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  type EdgeProps,
} from "@xyflow/react";
import { X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";

// A normal data wire that reveals a delete button at its midpoint on hover, so a
// connection can be removed directly on the canvas. The button lives in an
// EdgeLabelRenderer portal (outside the SVG), so hover is tracked with local
// state via a transparent thick hit-path over the wire + the button itself.
export function WireEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  markerEnd,
  style,
  data,
}: EdgeProps) {
  const { t } = useTranslation();
  const [hover, setHover] = useState(false);
  const [path, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });
  const onDelete = (data as { onDelete?: () => void } | undefined)?.onDelete;

  return (
    <>
      <BaseEdge id={id} path={path} markerEnd={markerEnd} style={style} />
      {onDelete && (
        <>
          {/* invisible, wide hit area so hovering anywhere on the wire reveals × */}
          <path
            d={path}
            fill="none"
            stroke="transparent"
            strokeWidth={22}
            style={{ cursor: "pointer" }}
            onMouseEnter={() => setHover(true)}
            onMouseLeave={() => setHover(false)}
          />
          <EdgeLabelRenderer>
            <div
              className="nodrag nopan absolute"
              style={{
                left: labelX,
                top: labelY,
                transform: "translate(-50%, -50%)",
                pointerEvents: "all",
              }}
              onMouseEnter={() => setHover(true)}
              onMouseLeave={() => setHover(false)}
            >
              <button
                type="button"
                title={t("canvas.removeWire")}
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete();
                }}
                className={cn(
                  "flex size-5 items-center justify-center rounded-full border bg-background shadow-sm transition-all",
                  hover
                    ? "scale-100 border-rose-400/70 text-rose-500 opacity-100"
                    : "pointer-events-none scale-75 border-border text-muted-foreground opacity-0",
                )}
              >
                <X className="size-3" />
              </button>
            </div>
          </EdgeLabelRenderer>
        </>
      )}
    </>
  );
}
