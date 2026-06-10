import type { TriggerConfig } from "./types";

const UNIT_MS: Record<string, number> = {
  second: 1000,
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
};

export function triggerIntervalMs(trigger: TriggerConfig): number | null {
  const s = trigger.schedule;
  if (
    trigger.kind === "schedule" &&
    s?.mode === "interval" &&
    s.intervalValue &&
    s.intervalUnit
  ) {
    return s.intervalValue * UNIT_MS[s.intervalUnit];
  }
  const p = trigger.poll;
  if (trigger.kind === "poll" && p?.intervalValue && p.intervalUnit) {
    return p.intervalValue * UNIT_MS[p.intervalUnit];
  }
  return null;
}
