// Webhook liveness — opt-in heartbeat. A webhook's cadence has no guarantee, so
// a naive "it went silent" alarm is a false positive. Instead the user DECLARES
// the cadence they expect; we compare actual arrivals (= webhook-triggered runs)
// against it. No config → no signal → zero false positives.

export interface WebhookHeartbeat {
  shape: "rate" | "silence";
  // rate: "~`expected` events per `window`; alert if actual drops below
  // (1-`dropPct`) of it" (e.g. expected 5/day, dropPct 0.5 → alert under 2.5/day)
  window?: "hour" | "day" | "week";
  expected?: number;
  dropPct?: number;
  // silence: "alert if no event for more than `maxSilenceMin` minutes"
  maxSilenceMin?: number;
}

export interface LivenessConfig {
  schedule?: { enabled: boolean; tolerancePct?: number };
  webhook?: { endpointHealth?: boolean; heartbeat?: WebhookHeartbeat };
}

const WINDOW_MS = {
  hour: 3_600_000,
  day: 86_400_000,
  week: 604_800_000,
} as const;

export function evaluateHeartbeat(params: {
  hb: WebhookHeartbeat;
  arrivals: number[]; // webhook arrival timestamps (ms)
  now: number;
  activeSince?: number; // when the flow/config became active (ms) — rate warm-up guard
}): { detail: string } | null {
  const { hb, arrivals, now } = params;

  if (hb.shape === "silence") {
    const maxMs = (hb.maxSilenceMin ?? 0) * 60_000;
    if (!maxMs) return null;
    if (!arrivals.length) return null; // never received → can't tell silent vs new
    const last = Math.max(...arrivals);
    return now - last > maxMs
      ? { detail: `no webhook event for over ${hb.maxSilenceMin} min` }
      : null;
  }

  // rate
  const expected = hb.expected ?? 0;
  if (!expected) return null;
  const windowMs = WINDOW_MS[hb.window ?? "day"];
  // don't judge the rate until the flow has existed for a full window
  if (params.activeSince !== undefined && now - params.activeSince < windowMs)
    return null;
  const dropPct = hb.dropPct ?? 0.5;
  const threshold = expected * (1 - dropPct);
  const count = arrivals.filter((t) => t >= now - windowMs).length;
  return count < threshold
    ? {
        detail: `${count} events in the last ${hb.window ?? "day"} < expected ≥${threshold.toFixed(1)} (${Math.round((1 - dropPct) * 100)}% of ${expected})`,
      }
    : null;
}
