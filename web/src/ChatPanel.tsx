import { useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ArrowUp } from "lucide-react";
import { ChatHistory } from "./ChatHistory";
import type { ConversationMeta } from "./queries";

// The chat panel toggles between a "list" view (new chat + previous chats +
// a prompt box at the bottom) and the active "chat" view. Typing in the list
// prompt starts a new chat with that message. The active chat carries its own
// back button (top-left) to return here. Replaces the old separate history tab.
export function ChatPanel({
  view,
  conversations,
  isLoading,
  currentId,
  onNew,
  onSelect,
  onDelete,
  onStartPrompt,
  chat,
}: {
  view: "list" | "chat";
  conversations: ConversationMeta[];
  isLoading: boolean;
  currentId: string | null;
  onNew: () => void;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onStartPrompt: (text: string) => void;
  chat: ReactNode;
}) {
  const { t } = useTranslation();
  const [input, setInput] = useState("");
  const taRef = useRef<HTMLTextAreaElement>(null);

  if (view === "chat") return <>{chat}</>;

  const submit = () => {
    const text = input.trim();
    if (!text) return;
    setInput("");
    if (taRef.current) taRef.current.style.height = "auto";
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
          onNew={onNew}
          onDelete={onDelete}
        />
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        className="p-2"
      >
        <div className="flex items-end gap-2 rounded-2xl border border-border/40 bg-background-subtle p-2 transition-colors focus-within:border-foreground/20">
          <textarea
            ref={taRef}
            value={input}
            rows={1}
            onChange={(e) => {
              setInput(e.target.value);
              const el = e.target;
              el.style.height = "auto";
              el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            placeholder={t("chat.placeholder")}
            className="max-h-40 min-h-9 flex-1 resize-none self-stretch border-none bg-transparent px-1 py-1 text-sm leading-relaxed text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-0"
          />
          <button
            type="submit"
            disabled={!input.trim()}
            className="flex size-8 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-30"
          >
            <ArrowUp className="size-4" />
          </button>
        </div>
      </form>
    </div>
  );
}
