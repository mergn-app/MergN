// Single source of truth for the 4 health-status colors. The monitoring icon,
// the flow list rows, and (later) the diff/fix badges all read from here so the
// status colors stay consistent. NOT the same as run-status colors (RunPanel's
// STATUS_DOT) — health-status ≠ run-status.

export type HealthStatus = "healthy" | "degraded" | "failing" | "nodata";

export interface HealthColor {
  dot: string; // bg-* for a filled dot / icon color via text-*
  text: string; // text-* token
  ring: string; // ring-* for the subtle halo
  labelKey: string; // i18n key under "health.*"
  pulse: boolean; // animate the icon (attention) when unhealthy
}

export const HEALTH_COLOR: Record<HealthStatus, HealthColor> = {
  healthy: { dot: "bg-emerald-500", text: "text-emerald-500", ring: "ring-emerald-500/30", labelKey: "health.healthy", pulse: false },
  degraded: { dot: "bg-amber-500", text: "text-amber-500", ring: "ring-amber-500/30", labelKey: "health.degraded", pulse: true },
  failing: { dot: "bg-rose-500", text: "text-rose-500", ring: "ring-rose-500/30", labelKey: "health.failing", pulse: true },
  nodata: { dot: "bg-muted-foreground/40", text: "text-muted-foreground", ring: "ring-border", labelKey: "health.nodata", pulse: false },
};

export const healthColor = (s: string): HealthColor =>
  HEALTH_COLOR[(s as HealthStatus)] ?? HEALTH_COLOR.nodata;
