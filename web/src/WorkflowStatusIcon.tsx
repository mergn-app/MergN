import { Activity } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { healthColor } from "./status-palette";
import type { HealthState } from "./queries";

// The monitoring entry button: always the same sine/heartbeat shape (one
// recognizable affordance → the monitoring page), its COLOR conveys health at a
// glance. Pulses on degraded/failing. Tooltip names the cause.
export function WorkflowStatusIcon({
  health,
  onClick,
  className,
}: {
  health?: HealthState;
  onClick?: () => void;
  className?: string;
}) {
  const { t } = useTranslation();
  const status = health?.status ?? "nodata";
  const c = healthColor(status);

  // keep the tooltip short — the raw error/stack lives in the monitoring page,
  // not a hover title
  const cause =
    health?.livenessFail
      ? health.livenessFail.kind === "webhook"
        ? t("health.cause.webhookSilent")
        : t("health.cause.scheduleStopped")
      : health?.outcomeFail
        ? (health.outcomeFail.detail ?? "").slice(0, 80)
        : health?.lastError
          ? health.lastError.type
          : undefined;

  const label = t(c.labelKey);
  const title = cause ? `${label} — ${cause}` : label;

  const Btn = onClick ? "button" : "div";
  return (
    <Btn
      {...(onClick ? { onClick, type: "button" as const } : {})}
      title={title}
      aria-label={t("monitoring.open")}
      className={cn(
        "flex size-7 shrink-0 items-center justify-center rounded-lg transition-colors",
        onClick && "hover:bg-muted",
        className,
      )}
    >
      <Activity className={cn("size-4", c.text, c.pulse && "animate-pulse")} />
    </Btn>
  );
}
