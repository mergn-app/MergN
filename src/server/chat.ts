import type { DocStore } from "../store/docstore";

const COLLECTION = "conversations";
const TITLE_MAX = 60;

export interface ConversationMeta {
  id: string;
  title: string;
  updatedAt: string;
}

export interface ConversationDoc {
  id: string;
  userId: string;
  title: string;
  messages: unknown[];
  createdAt: string;
  updatedAt: string;
}

export interface ChatStore {
  listConversations(
    spaceId: string,
    userId: string,
  ): Promise<ConversationMeta[]>;
  getConversation(
    spaceId: string,
    userId: string,
    id: string,
  ): Promise<ConversationDoc | null>;
  saveConversation(
    spaceId: string,
    userId: string,
    id: string,
    messages: unknown[],
  ): Promise<void>;
  deleteConversation(
    spaceId: string,
    userId: string,
    id: string,
  ): Promise<void>;
}

function deriveTitle(messages: unknown[]): string {
  for (const m of messages) {
    const msg = m as { role?: string; parts?: { type?: string; text?: string }[] };
    if (msg.role !== "user") continue;
    const text = (msg.parts ?? [])
      .filter((p) => p.type === "text" && p.text)
      .map((p) => p.text as string)
      .join(" ")
      .trim();
    if (text) {
      return text.length > TITLE_MAX ? text.slice(0, TITLE_MAX) + "…" : text;
    }
  }
  return "New chat";
}

export function createChatStore(store: DocStore): ChatStore {
  async function read(
    spaceId: string,
    userId: string,
    id: string,
  ): Promise<ConversationDoc | null> {
    const doc = (await store.get(spaceId, COLLECTION, id)) as unknown as
      | ConversationDoc
      | null;
    if (!doc || doc.userId !== userId) return null;
    return doc;
  }

  return {
    async listConversations(spaceId, userId) {
      const docs = (await store.list(
        spaceId,
        COLLECTION,
      )) as unknown as ConversationDoc[];
      return docs
        .filter((d) => d.userId === userId)
        .map((d) => ({ id: d.id, title: d.title, updatedAt: d.updatedAt }))
        .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
    },

    getConversation: read,

    async saveConversation(spaceId, userId, id, messages) {
      const existing = await read(spaceId, userId, id);
      const now = new Date().toISOString();
      const doc: ConversationDoc = {
        id,
        userId,
        title: existing?.title ?? deriveTitle(messages),
        messages,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      await store.put(
        spaceId,
        COLLECTION,
        id,
        doc as unknown as Record<string, unknown>,
      );
    },

    async deleteConversation(spaceId, userId, id) {
      const doc = await read(spaceId, userId, id);
      if (doc) await store.remove(spaceId, COLLECTION, id);
    },
  };
}
