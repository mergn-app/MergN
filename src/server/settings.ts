import type { DocStore } from "../store/docstore";
import type { LlmConfig } from "../agent/model";

// "_global" holds the self-host single config; managed/prod stores one per spaceId.
const GLOBAL = "_global";
const COLLECTION = "settings";
const LLM_ID = "llm";

export interface SettingsStore {
  getLlm(spaceId?: string): Promise<LlmConfig | null>;
  setLlm(spaceId: string, cfg: LlmConfig): Promise<void>;
  clearLlm(spaceId: string): Promise<void>;
}

export function createSettingsStore(store: DocStore): SettingsStore {
  return {
    async getLlm(spaceId = GLOBAL) {
      const doc = await store.get(spaceId, COLLECTION, LLM_ID);
      return doc ? (doc as unknown as LlmConfig) : null;
    },
    async setLlm(spaceId, cfg) {
      await store.put(
        spaceId,
        COLLECTION,
        LLM_ID,
        cfg as unknown as Record<string, unknown>,
      );
    },
    async clearLlm(spaceId) {
      await store.remove(spaceId, COLLECTION, LLM_ID);
    },
  };
}
