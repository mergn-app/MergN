import type { HealthState, HealthStatus } from "./health";

// Pure mapping from a health transition to an alert (or none). This is the heart
// of "what is worth alerting, and how severe" — no IO, fully testable. The alert
// service applies noise control and delivery on top.

export type Severity = "info" | "warn" | "critical";
export type AlertReason = "error" | "healed";

// Fine-grained event kind a user can route on (which channels/handler-flows fire
// for which situations). The user-facing concepts: a plain error, a flow that
// silently stopped firing, a flow that ran green but did nothing, a recovery,
// and an auto-heal.
export type AlertCategory =
  | "error"
  | "silent_failure"
  | "silent_success"
  | "recovered"
  | "healed";

export interface AlertEvent {
  workflowId: string;
  status: HealthStatus;
  severity: Severity;
  reason: AlertReason;
  category: AlertCategory;
  title: string;
  detail?: string;
}

// The structured payload handed to webhook channels and monitor-handler flows
// (the workflow channel's input). Stable, documented shape — what a custom
// integration reads.
export interface AlertPayload {
  category: AlertCategory;
  severity: Severity;
  reason: AlertReason;
  status: HealthStatus;
  title: string;
  detail?: string;
  sourceWorkflowId: string;
  sourceWorkflowName?: string;
  at: string;
}

export const severityToLogLevel = (s: Severity): "error" | "warn" | "info" =>
  s === "critical" ? "error" : s === "warn" ? "warn" : "info";

// Which situation is this? Derived from the health state (most specific first).
function categoryOf(state: HealthState): AlertCategory {
  if (state.livenessFail) return "silent_failure"; // stopped firing
  if (state.outcomeFail) return "silent_success"; // ran green, no real work
  return "error";
}

// Describe WHY a flow is failing/degraded, preferring the most specific cause.
function cause(state: HealthState): string {
  if (state.livenessFail)
    return state.livenessFail.kind === "webhook"
      ? "expected webhook events stopped arriving"
      : "the schedule stopped firing on time";
  if (state.outcomeFail)
    return state.outcomeFail.kind === "expectation"
      ? `ran but produced no usable output (${state.outcomeFail.detail})`
      : `output dropped to empty (${state.outcomeFail.detail})`;
  if (state.lastError)
    return `${state.lastError.type}: ${state.lastError.message}`;
  return "recent runs are failing";
}

// onChange only fires on a real status change, but guard anyway. `prev`
// undefined = first time we've seen this flow.
export function routeHealthTransition(
  prev: HealthStatus | undefined,
  state: HealthState,
): AlertEvent | null {
  const status = state.status;
  if (status === prev) return null;

  const base = { workflowId: state.workflowId, status, reason: "error" as const };

  switch (status) {
    case "failing":
      return { ...base, category: categoryOf(state), severity: "critical", title: "Workflow failing", detail: cause(state) };
    case "degraded":
      return { ...base, category: categoryOf(state), severity: "warn", title: "Workflow degraded", detail: cause(state) };
    case "healthy":
      // a recovery — only worth saying if it WAS unhealthy (don't greet a brand-new flow)
      if (prev === "failing" || prev === "degraded")
        return { ...base, category: "recovered", severity: "info", title: "Workflow recovered" };
      return null;
    case "nodata":
      return null; // idle / new flow — not actionable
    default:
      return null;
  }
}

// Build the structured payload for webhook channels / monitor-handler flows.
export function toAlertPayload(
  ev: AlertEvent,
  sourceWorkflowName: string | undefined,
  at: string,
): AlertPayload {
  return {
    category: ev.category,
    severity: ev.severity,
    reason: ev.reason,
    status: ev.status,
    title: ev.title,
    detail: ev.detail,
    sourceWorkflowId: ev.workflowId,
    sourceWorkflowName,
    at,
  };
}

// Render an alert as a single plain-text line (Telegram/Slack/Discord) — emoji
// by severity, with the workflow name when available.
export function formatAlertText(ev: AlertEvent, workflowName?: string): string {
  const icon = ev.severity === "critical" ? "🔴" : ev.severity === "warn" ? "🟡" : "🟢";
  const who = workflowName ? `"${workflowName}"` : ev.workflowId;
  return ev.detail
    ? `${icon} ${ev.title} — ${who}\n${ev.detail}`
    : `${icon} ${ev.title} — ${who}`;
}
