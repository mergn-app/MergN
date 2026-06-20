import type { HealTrigger } from "./heal-modes";

// Engine-independent heal queue. A failed run fires a trigger here and returns
// immediately — heal NEVER runs inline (it must not block or crash the run
// engine). This in-process bridge is best-effort and non-durable (pending heals
// are lost on restart — accepted; the next failure re-triggers). A durable
// JetStream consumer replaces it once the event bus lands.

export interface HealDispatcher {
  enqueue(trigger: HealTrigger): void; // fire-and-forget; never throws
}

export function createHealDispatcher(deps: {
  orchestrate: (trigger: HealTrigger) => Promise<unknown>;
  onError?: (e: unknown) => void;
}): HealDispatcher {
  // Serialize per (space, workflow): if a heal is already running for a flow,
  // skip the new trigger — prevents concurrent double-fix / races on one flow.
  const inFlight = new Set<string>();
  return {
    enqueue(trigger) {
      const key = `${trigger.spaceId}:${trigger.workflowId}`;
      if (inFlight.has(key)) return;
      inFlight.add(key);
      // detached — never blocks or throws into the caller (the run engine).
      void (async () => {
        try {
          await deps.orchestrate(trigger);
        } catch (e) {
          deps.onError?.(e);
        } finally {
          inFlight.delete(key);
        }
      })();
    },
  };
}
