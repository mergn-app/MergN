import { useState, type ReactNode } from "react";
import { ChatHistory } from "./ChatHistory";
import { ChatComposer } from "./ChatComposer";
import type { ConversationMeta } from "./queries";

// The chat panel toggles between a "list" view (previous chats + a prompt box
// at the bottom) and the active "chat" view. Typing in the list
// prompt starts a new chat with that message. The active chat carries its own
// back button (top-left) to return here. Replaces the old separate history tab.
export function ChatPanel({
  view,
  conversations,
  isLoading,
  currentId,
  onSelect,
  onDelete,
  onStartPrompt,
  chat,
}: {
  view: "list" | "chat";
  conversations: ConversationMeta[];
  isLoading: boolean;
  currentId: string | null;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onStartPrompt: (text: string) => void;
  chat: ReactNode;
}) {
  const [input, setInput] = useState("");

  if (view === "chat") return <>{chat}</>;

  const submit = () => {
    const text = input.trim();
    if (!text) return;
    setInput("");
    onStartPrompt(text);
  };

  return (
    <div className="flex h-full w-full flex-col">
      <div className="min-h-0 flex-1">
        <ChatHistory
          conversations={conversations}
          isLoading={isLoading}
          currentId={currentId}
          onSelect={onSelect}
          onDelete={onDelete}
        />
      </div>

      <ChatComposer value={input} onChange={setInput} onSubmit={submit} />
    </div>
  );
}
