import type { DocStore } from "../store/docstore";
import type { FixMode } from "./fix-engine";

// Per-flow self-healing settings — the policy a user sets per workflow. Kept in
// its OWN collection (not on SavedWorkflow) so a settings change never races with
// editor/chat saves or triggers an unnecessary version seal. The heal orchestrator
// reads `enabled`+`fixMode`; the dispatcher reads `autoReplay`.
const COLLECTION = "flow_settings";

export interface FlowSettings {
  enabled: boolean; // self-healing opt-in (default false — nothing auto-runs unasked)
  fixMode: FixMode; // notify | propose | auto (only meaningful when enabled)
  autoReplay: boolean; // after a successful auto-heal, replay buffered events
}

export const DEFAULT_FLOW_SETTINGS: FlowSettings = {
  enabled: false,
  fixMode: "propose",
  autoReplay: false,
};

export interface FlowSettingsStore {
  // `fallback` is the default used when this flow has no stored settings — lets the
  // heal orchestrator preserve the deployment env defaults (HEAL_DEFAULT_*) for
  // untouched flows, while the settings UI reads/writes the plain defaults.
  get(spaceId: string, workflowId: string, fallback?: FlowSettings): Promise<FlowSettings>;
  set(spaceId: string, workflowId: string, patch: Partial<FlowSettings>): Promise<FlowSettings>;
}

export function createFlowSettingsStore(store: DocStore): FlowSettingsStore {
  async function get(spaceId: string, workflowId: string, fallback = DEFAULT_FLOW_SETTINGS): Promise<FlowSettings> {
    const doc = (await store.get(spaceId, COLLECTION, workflowId)) as Partial<FlowSettings> | null;
    return { ...fallback, ...(doc ?? {}) };
  }
  return {
    get,
    async set(spaceId, workflowId, patch) {
      const next: FlowSettings = { ...(await get(spaceId, workflowId)), ...patch };
      await store.put(spaceId, COLLECTION, workflowId, next as unknown as Record<string, unknown>);
      return next;
    },
  };
}
