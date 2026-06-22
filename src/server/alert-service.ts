import type { HealthState, HealthStatus } from "./health";
import type { LogStore } from "./logs";
import type { AlertChannelStore } from "./alert-store";
import { deliverToChannel, type Fetch } from "./alert-channels";
import {
  routeHealthTransition,
  formatAlertText,
  toAlertPayload,
  severityToLogLevel,
  type AlertEvent,
  type AlertPayload,
  type Severity,
} from "./alert-router";

// Wires health transitions to delivery. Guarantees:
//  - the log channel ALWAYS records the alert (a DocStore write the UI shows),
//    so an alert is never lost even with zero external channels configured;
//  - external channels are best-effort and isolated — one failing channel never
//    blocks the others, and nothing here throws into the health monitor.

const SEVERITY_RANK: Record<Severity, number> = { info: 0, warn: 1, critical: 2 };

// Flap guard: suppress a repeat alert for the same (workflow,status) within the
// cooldown. Recoveries (info) always pass — "all clear" should never be muted.
const COOLDOWN_MS = Number(process.env.ALERT_COOLDOWN_MS) || 300_000;

export interface AlertServiceDeps {
  channels: AlertChannelStore;
  logs: LogStore;
  workflowName?: (spaceId: string, workflowId: string) => Promise<string | undefined>;
  // every flow whose trigger is "monitor" (auto-dispatch targets) + its optional
  // event filter. A handler with no filter fires on all categories.
  listHandlers?: (
    spaceId: string,
  ) => Promise<Array<{ workflowId: string; events?: string[] }>>;
  // run a monitor-handler flow with the alert payload as its input
  dispatchWorkflow?: (
    spaceId: string,
    workflowId: string,
    payload: AlertPayload,
  ) => Promise<void>;
  // is this flow itself a monitor-handler? (loop guard — a handler's own alert
  // must never dispatch handlers, or it would loop)
  isHandler?: (spaceId: string, workflowId: string) => Promise<boolean>;
  // does this flow opt INTO external notifications? Default OFF — the activity
  // log always records the alert, but external channels + handler flows only
  // fire when the user enabled alerts for the source flow (no spam by default).
  alertsEnabled?: (spaceId: string, workflowId: string) => Promise<boolean>;
  fetch?: Fetch;
  now?: () => number;
}

export interface AlertService {
  onHealthChange(
    spaceId: string,
    state: HealthState,
    prev: HealthStatus | undefined,
  ): Promise<void>;
  // exposed for a "send test alert" endpoint (force bypasses the opt-in gate)
  deliver(spaceId: string, ev: AlertEvent, forceNotify?: boolean): Promise<void>;
}

export function createAlertService(deps: AlertServiceDeps): AlertService {
  const now = deps.now ?? (() => Date.now());
  const lastSent = new Map<string, { status: HealthStatus; at: number }>();

  function shouldSend(spaceId: string, ev: AlertEvent): boolean {
    if (ev.severity === "info") return true; // recoveries always go through
    const key = `${spaceId} ${ev.workflowId}`;
    const prior = lastSent.get(key);
    if (prior && prior.status === ev.status && now() - prior.at < COOLDOWN_MS) return false;
    lastSent.set(key, { status: ev.status, at: now() });
    return true;
  }

  async function warnLog(spaceId: string, message: string, detail: string, workflowId: string) {
    await deps.logs
      .append(spaceId, { level: "warn", source: "alert", message, detail, workflowId })
      .catch(() => {});
  }

  // forceNotify=true skips the opt-in gate (used by the "send test alert" button).
  async function deliver(spaceId: string, ev: AlertEvent, forceNotify = false): Promise<void> {
    const name = await deps.workflowName?.(spaceId, ev.workflowId).catch(() => undefined);
    const payload = toAlertPayload(ev, name, new Date(now()).toISOString());
    const delivery = {
      text: formatAlertText(ev, name),
      subject: `${ev.title}${name ? ` — ${name}` : ""}`,
      event: payload,
    };

    // 1) guaranteed sink: the activity log (always works, UI-visible).
    await deps.logs
      .append(spaceId, {
        level: severityToLogLevel(ev.severity),
        source: "alert",
        message: ev.title,
        detail: ev.detail,
        workflowId: ev.workflowId,
      })
      .catch(() => {});

    // Opt-in gate: external delivery (channels + handler flows) only when the
    // source flow has alerts enabled (or explicitly forced). The log above
    // already recorded it — no spam by default.
    const notify = forceNotify || ((await deps.alertsEnabled?.(spaceId, ev.workflowId).catch(() => false)) ?? false);
    if (!notify) return;

    // Loop guard: if the SOURCE flow is itself a monitor-handler, its own alert
    // must not dispatch handlers (else handler-fails → alert → handler → …).
    const sourceIsHandler = (await deps.isHandler?.(spaceId, ev.workflowId).catch(() => false)) ?? false;

    // 2) notification channels: best-effort, isolated, severity + category filtered.
    const channels = await deps.channels.resolve(spaceId).catch(() => []);
    for (const { meta, secret } of channels) {
      if (meta.minSeverity && SEVERITY_RANK[ev.severity] < SEVERITY_RANK[meta.minSeverity]) continue;
      if (meta.categories && !meta.categories.includes(ev.category)) continue;
      try {
        await deliverToChannel(meta.kind, secret, delivery, deps.fetch);
      } catch (e) {
        await warnLog(spaceId, `Alert channel '${meta.kind}' failed`, e instanceof Error ? e.message : String(e), ev.workflowId);
      }
    }

    // 3) monitor-handler flows: auto-run every "monitor"-trigger flow whose event
    // filter matches. No binding step — creating the flow is enough.
    if (!sourceIsHandler && deps.listHandlers && deps.dispatchWorkflow) {
      const handlers = await deps.listHandlers(spaceId).catch(() => []);
      for (const h of handlers) {
        if (h.events && h.events.length && !h.events.includes(ev.category)) continue;
        try {
          await deps.dispatchWorkflow(spaceId, h.workflowId, payload);
        } catch (e) {
          await warnLog(spaceId, `Monitor handler '${h.workflowId}' failed to dispatch`, e instanceof Error ? e.message : String(e), ev.workflowId);
        }
      }
    }
  }

  return {
    deliver,
    async onHealthChange(spaceId, state, prev) {
      const ev = routeHealthTransition(prev, state);
      if (!ev) return;
      if (!shouldSend(spaceId, ev)) return;
      await deliver(spaceId, ev);
    },
  };
}
