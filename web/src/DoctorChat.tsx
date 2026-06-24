import { memo, useEffect, useMemo, useRef, useState } from "react";
import { useChat, Chat } from "@ai-sdk/react";
import { useTranslation } from "react-i18next";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { DefaultChatTransport, type UIMessage } from "ai";
import {
  Stethoscope,
  Loader2,
  Brain,
  Trash2,
  Wrench,
  History as HistoryIcon,
  ArrowUpRight,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Markdown } from "./Markdown";
import { spaceHeaders } from "./space";
import { useAuth } from "./authContext";
import {
  useConversation,
  useDeleteConversation,
  reportLog,
  type FixEvent,
  type WorkflowVersionMeta,
} from "./queries";
import type { ChangeSource } from "./ChangeReview";
import { ChatComposer } from "./ChatComposer";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useStickToBottom } from "@/hooks/useStickToBottom";

interface ToolPart {
  type: string;
  state?: string;
  output?: unknown;
}

function errorMessage(e: Error): string {
  try {
    const parsed = JSON.parse(e.message) as { message?: string; error?: string };
    return parsed.message || parsed.error || e.message;
  } catch {
    return e.message;
  }
}

// Doctor chats live in a MODULE-LEVEL registry (outside React), keyed by
// conversationId. This keeps an in-flight stream alive when the component
// unmounts — e.g. you start a Doctor reply, switch to another flow, and come
// back: the same Chat instance is still streaming, and the remounted component
// simply re-subscribes to it instead of losing the process.
const chatRegistry = new Map<string, Chat<UIMessage>>();
const REGISTRY_MAX = 16; // bound memory — evict the oldest chat past this
let sharedQc: QueryClient | null = null;

function getDoctorChat(conversationId: string, workflowId: string, initialMessages: UIMessage[]): Chat<UIMessage> {
  let chat = chatRegistry.get(conversationId);
  if (!chat) {
    // evict the oldest (insertion-ordered) entries so visiting many flows in one
    // session doesn't retain every Chat instance forever
    while (chatRegistry.size >= REGISTRY_MAX) {
      const oldest = chatRegistry.keys().next().value;
      if (oldest === undefined) break;
      chatRegistry.delete(oldest);
    }
    chat = new Chat<UIMessage>({
      id: conversationId,
      messages: initialMessages,
      transport: new DefaultChatTransport({
        api: "/api/doctor/chat",
        prepareSendMessagesRequest({ messages, id }) {
          return {
            headers: spaceHeaders(),
            body: { message: messages[messages.length - 1], conversationId: id, workflowId },
          };
        },
      }),
      onError: (e) => reportLog({ message: "Doctor request failed", detail: errorMessage(e) }),
      onFinish: () => {
        if (!sharedQc) return;
        // the Doctor may have applied/proposed a fix or paused the flow — refresh
        void sharedQc.invalidateQueries({ queryKey: ["heal-events"] });
        void sharedQc.invalidateQueries({ queryKey: ["versions"] });
      },
    });
    chatRegistry.set(conversationId, chat);
  }
  return chat;
}

const STATUS_TONE: Record<string, string> = {
  proposed: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  applied: "bg-emerald-500/15 text-emerald-500",
  rejected: "bg-rose-500/15 text-rose-500",
  reverted: "bg-muted text-muted-foreground",
  failed: "bg-rose-500/15 text-rose-500",
};

// ── fix card: the Doctor diagnosed/applied/proposed a repair → review it ──────
function FixCard({ event, onOpen }: { event: FixEvent; onOpen: (s: ChangeSource) => void }) {
  const { t } = useTranslation();
  return (
    <div className="my-1.5 w-full rounded-2xl border border-amber-500/25 bg-amber-500/[0.06] p-3">
      <div className="flex items-center gap-2">
        <Wrench className="size-3.5 shrink-0 text-amber-500" />
        <span className="text-[13px] font-medium text-foreground">{t("doctor.fixCard.title")}</span>
        <span className={cn("ml-auto rounded-full px-2 py-0.5 text-[10px] font-medium", STATUS_TONE[event.status] ?? "bg-muted text-muted-foreground")}>
          {t(`doctor.status.${event.status}`, { defaultValue: event.status })}
        </span>
      </div>
      <p className="mt-1.5 text-[13px] leading-snug text-foreground/80">{event.diagnosis}</p>
      <button
        type="button"
        onClick={() => onOpen({ kind: "fix", event })}
        className="mt-2 flex items-center gap-1.5 rounded-lg border border-border/60 bg-background px-2.5 py-1 text-xs font-medium text-foreground transition-colors hover:bg-secondary"
      >
        {t("doctor.review")}
        <ArrowUpRight className="size-3.5" />
      </button>
    </div>
  );
}

// ── version card: the Doctor suggests switching to an earlier version ─────────
function VersionCard({ version, onOpen }: { version: WorkflowVersionMeta; onOpen: (s: ChangeSource) => void }) {
  const { t } = useTranslation();
  return (
    <div className="my-1.5 w-full rounded-2xl border border-sky-500/25 bg-sky-500/[0.06] p-3">
      <div className="flex items-center gap-2">
        <HistoryIcon className="size-3.5 shrink-0 text-sky-500" />
        <span className="text-[13px] font-medium text-foreground">{t("doctor.versionCard.title")}</span>
        <span className="ml-auto font-mono text-[10px] text-muted-foreground/70">v{version.seq}</span>
      </div>
      <p className="mt-1.5 text-[13px] leading-snug text-foreground/80">
        {version.message || version.label || t("doctor.versionCard.fallback", { seq: version.seq })}
      </p>
      <button
        type="button"
        onClick={() => onOpen({ kind: "version", version })}
        className="mt-2 flex items-center gap-1.5 rounded-lg border border-border/60 bg-background px-2.5 py-1 text-xs font-medium text-foreground transition-colors hover:bg-secondary"
      >
        {t("doctor.review")}
        <ArrowUpRight className="size-3.5" />
      </button>
    </div>
  );
}

const MessageItem = memo(function MessageItem({
  message,
  onOpen,
}: {
  message: UIMessage;
  onOpen: (s: ChangeSource) => void;
}) {
  const { t } = useTranslation();
  const isUser = message.role === "user";
  return (
    <div className={cn("flex min-w-0 max-w-full flex-col gap-1.5", isUser ? "items-end" : "items-start")}>
      <div
        className={cn(
          isUser
            ? "max-w-[85%] rounded-2xl rounded-br-md border border-border/60 bg-secondary px-3.5 py-2 text-[14px] leading-relaxed text-secondary-foreground wrap-anywhere"
            : "w-full min-w-0 overflow-hidden text-foreground/90",
        )}
      >
        {message.parts.map((part, i) => {
          if (part.type === "text") {
            return isUser ? (
              <span key={i} className="whitespace-pre-wrap">{part.text}</span>
            ) : (
              <Markdown key={i}>{part.text}</Markdown>
            );
          }
          if (part.type === "reasoning") {
            const text = (part as { text?: string }).text ?? "";
            if (!text.trim()) return null;
            return (
              <div key={i} className="my-1.5 w-full rounded-2xl border border-border/40 bg-muted/20 px-3.5 py-3">
                <div className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-muted-foreground/70">
                  <Brain className="size-3.5" />
                  {t("chat.thinkingLabel")}
                </div>
                <div className="text-muted-foreground">
                  <Markdown className="text-[13px]">{text}</Markdown>
                </div>
              </div>
            );
          }
          if (part.type === "data-doctor-fix") {
            const ev = (part as { data?: { event?: FixEvent } }).data?.event;
            return ev ? <FixCard key={i} event={ev} onOpen={onOpen} /> : null;
          }
          if (part.type === "data-doctor-version") {
            const v = (part as { data?: { version?: WorkflowVersionMeta } }).data?.version;
            return v ? <VersionCard key={i} version={v} onOpen={onOpen} /> : null;
          }
          if (part.type.startsWith("tool-")) {
            const p = part as ToolPart;
            const name = part.type.replace("tool-", "");
            const done = p.state === "output-available";
            return (
              <div
                key={i}
                className="my-1 flex w-fit max-w-full items-center gap-2 rounded-lg border border-border/50 bg-muted/40 px-2 py-1 font-mono text-[11px] text-muted-foreground"
              >
                <span className={cn("size-1.5 shrink-0 rounded-full", done ? "bg-emerald-500" : "bg-amber-500 animate-pulse")} />
                <span className="truncate">{t(`doctor.tool.${name}`, { defaultValue: name })}</span>
              </div>
            );
          }
          return null;
        })}
      </div>
    </div>
  );
});

const SUGGESTIONS = ["doctor.suggest.health", "doctor.suggest.lastFail", "doctor.suggest.summary"];

interface ThreadProps {
  workflowId: string;
  conversationId: string;
  onOpen: (s: ChangeSource) => void;
}

function DoctorThread({ conversationId, ...rest }: ThreadProps) {
  const { data, isLoading } = useConversation(conversationId);
  if (isLoading) {
    return (
      <div className="flex h-full w-full items-center justify-center">
        <Loader2 className="size-4 animate-spin text-muted-foreground/70" />
      </div>
    );
  }
  return <DoctorThreadInner key={conversationId} conversationId={conversationId} initialMessages={data ?? []} {...rest} />;
}

function DoctorThreadInner({
  workflowId,
  conversationId,
  onOpen,
  initialMessages,
}: ThreadProps & { initialMessages: UIMessage[] }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { requireAuth } = useAuth();
  const del = useDeleteConversation();
  const [input, setInput] = useState("");
  const taRef = useRef<HTMLTextAreaElement>(null);

  // keep the registry's onFinish able to invalidate queries with a live client
  useEffect(() => {
    sharedQc = qc;
  }, [qc]);

  // reuse the persistent Chat for this conversation (survives flow switches)
  const chat = useMemo(
    () => getDoctorChat(conversationId, workflowId, initialMessages),
    // initialMessages is only used on first creation; keying on the id is right
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [conversationId, workflowId],
  );

  const { messages, sendMessage, status, error, clearError, setMessages } = useChat({
    chat,
    experimental_throttle: 50,
  });
  const chatError = error ? errorMessage(error) : null;
  const scrollRef = useStickToBottom(messages);

  const busy = status === "streaming" || status === "submitted";

  const submit = () => {
    const text = input.trim();
    if (!text) return;
    const fire = () => {
      if (error) clearError();
      void sendMessage({ text });
      setInput("");
    };
    if (!requireAuth(fire)) return;
    fire();
  };

  // single chat per flow — "clear" wipes it (UI + server record) to start fresh
  const clearChat = () => {
    setMessages([]);
    chatRegistry.delete(conversationId); // drop the cached instance too
    del.mutate(conversationId);
  };

  return (
    <div className="flex h-full w-full flex-col">
      <div className="flex items-center gap-2 border-b border-border/40 px-3 py-1.5">
        <Stethoscope className="size-4 shrink-0 text-muted-foreground" />
        <span className="flex-1 text-xs font-medium text-foreground">{t("doctor.tab")}</span>
        <button
          type="button"
          onClick={clearChat}
          disabled={busy || messages.length === 0 || del.isPending}
          title={t("doctor.clearChat")}
          className="flex size-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40"
        >
          <Trash2 className="size-4" />
        </button>
      </div>

      <ScrollArea viewportRef={scrollRef} className="min-h-0 flex-1">
        <div className="flex flex-col gap-3 p-3">
          {messages.length === 0 && (
            <div className="flex flex-col items-center px-4 pb-2 pt-8 text-center">
              <div className="flex size-11 items-center justify-center rounded-2xl bg-secondary ring-1 ring-border">
                <Stethoscope className="size-5 text-foreground/80" />
              </div>
              <h2 className="mt-4 text-[15px] font-medium text-foreground">{t("doctor.emptyTitle")}</h2>
              <p className="mt-1 max-w-xs text-[13px] leading-relaxed text-muted-foreground">{t("doctor.emptySubtitle")}</p>
              <div className="mt-5 flex w-full flex-col gap-2">
                {SUGGESTIONS.map((key) => {
                  const ex = t(key);
                  return (
                    <button
                      key={key}
                      type="button"
                      onClick={() => {
                        setInput(ex);
                        requestAnimationFrame(() => taRef.current?.focus());
                      }}
                      className="group flex items-center gap-2.5 rounded-xl border border-border/50 bg-background-subtle px-3 py-2.5 text-left text-[13px] text-foreground/80 transition-colors hover:border-border hover:bg-secondary hover:text-foreground"
                    >
                      <span className="flex-1 leading-snug">{ex}</span>
                      <ArrowUpRight className="size-4 shrink-0 text-muted-foreground/50 transition-colors group-hover:text-foreground/70" />
                    </button>
                  );
                })}
              </div>
            </div>
          )}
          {messages.map((m) => (
            <MessageItem key={m.id} message={m} onOpen={onOpen} />
          ))}
          {busy && (
            <div className="flex items-center gap-2 px-1 text-xs text-muted-foreground">
              <Loader2 className="size-3 animate-spin text-muted-foreground/70" />
              <span>{t("doctor.working")}</span>
            </div>
          )}
        </div>
      </ScrollArea>

      {chatError && (
        <div className="mx-2 mb-1 rounded-xl border border-tone-rose/30 bg-tone-rose/10 px-3 py-2 text-xs text-tone-rose-fg">
          {chatError}
        </div>
      )}

      <ChatComposer
        value={input}
        onChange={setInput}
        onSubmit={submit}
        inputRef={taRef}
        submitDisabled={!input.trim() || busy}
        placeholder={t("doctor.placeholder")}
      />
    </div>
  );
}

// One Doctor chat per flow — a single fixed conversation id. No switching, no
// new-chat: just this flow's chat. The fixed id also means the persistent Chat
// in the registry survives flow switches automatically (an in-flight reply keeps
// streaming and is re-subscribed when you return to the flow).
export function DoctorChat({ workflowId, onOpen }: { workflowId: string; onOpen: (s: ChangeSource) => void }) {
  const conversationId = `doctor_${workflowId}_main`;
  return (
    <DoctorThread
      key={conversationId}
      workflowId={workflowId}
      conversationId={conversationId}
      onOpen={onOpen}
    />
  );
}
