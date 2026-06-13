import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useChat } from "@ai-sdk/react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { useQueryClient } from "@tanstack/react-query";
import { DefaultChatTransport, type UIMessage } from "ai";
import type { AuthoredFunc, InputForm, TriggerConfig, Wire, WorkflowOp } from "./types";
import { Sparkles, ArrowUpRight, Brain, Loader2, SquarePen, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Markdown } from "./Markdown";
import { spaceHeaders } from "./space";
import { useAuth } from "./authContext";
import { useConversation, useConnections, reportLog } from "./queries";
import { ConnectionDialog } from "./ConnectionDialog";
import { ModelPicker } from "./ModelPicker";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { ScrollArea } from "@/components/ui/scroll-area";

interface ToolPart {
  type: string;
  state?: string;
  output?: unknown;
}

const EXAMPLE_KEYS = [
  "chat.example.stripeSlack",
  "chat.example.digest",
  "chat.example.github",
];

interface Usage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

function usageOf(metadata: unknown): Usage | undefined {
  return (metadata as { totalUsage?: Usage } | undefined)?.totalUsage;
}

interface DesignItem {
  key: string;
  label: string;
  status: "active" | "pending" | "done" | "failed";
}

function fmtElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function errorMessage(e: Error): string {
  try {
    const parsed = JSON.parse(e.message) as { message?: string; error?: string };
    return parsed.message || parsed.error || e.message;
  } catch {
    return e.message;
  }
}

function streamLabel(
  messages: { role: string; parts: ToolPart[] }[],
  t: TFunction,
): string {
  const last = messages[messages.length - 1];
  if (!last || last.role !== "assistant") return t("chat.thinking");
  for (const p of last.parts) {
    if (p.type === "data-design") {
      const items =
        (p as { data?: { items?: DesignItem[] } }).data?.items ?? [];
      const active = items.find((it) => it.status === "active");
      if (active) return active.label;
      if (
        items.length &&
        items.some((it) => it.status === "active" || it.status === "pending")
      )
        return t("chat.designingWorkflow");
    }
  }
  for (const p of last.parts) {
    if (
      p.type.startsWith("tool-") &&
      p.state &&
      p.state !== "output-available"
    ) {
      const name = p.type.replace("tool-", "");
      return t(`chat.verb.${name}`, { defaultValue: t("chat.working") });
    }
  }
  const lastPart = last.parts[last.parts.length - 1];
  if (lastPart?.type === "reasoning") return t("chat.thinking");
  if (lastPart?.type === "text") return t("chat.writing");
  return t("chat.working");
}

function DesignProgress({ items }: { items: DesignItem[] }) {
  const { t } = useTranslation();
  const allDone = items.length > 0 && items.every((i) => i.status === "done");
  const failed = items.some((i) => i.status === "failed");
  const settled = allDone || failed;
  const doneCount = items.filter((i) => i.status === "done").length;
  const pct = items.length ? Math.round((doneCount / items.length) * 100) : 0;
  const startRef = useRef(Date.now());
  const [, force] = useState(0);
  useEffect(() => {
    if (settled) return;
    const timer = setInterval(() => force((n) => n + 1), 250);
    return () => clearInterval(timer);
  }, [settled]);
  const elapsed = Date.now() - startRef.current;

  return (
    <div className="my-1.5 w-full overflow-hidden p-4 border border-dashed border-border/40 rounded-3xl bg-background">
      <div className="flex items-center gap-2.5">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium leading-tight text-foreground">
            {failed
              ? t("chat.workflowFailed")
              : allDone
                ? t("chat.workflowReady")
                : t("chat.designingWorkflow")}
          </div>
          <div className="text-xs leading-tight text-muted-foreground">
            {t("chat.stepsProgress", { done: doneCount, total: items.length })}
          </div>
        </div>
        <span className="shrink-0 font-mono text-[11px] text-muted-foreground/70">
          {fmtElapsed(elapsed)}
        </span>
      </div>

      <div className="mt-2.5 h-1 w-full overflow-hidden rounded-full bg-muted/60">
        <div
          className={cn(
            "h-full rounded-full transition-all duration-500 ease-out",
            failed ? "bg-rose-500" : allDone ? "bg-emerald-500" : "bg-amber-400",
          )}
          style={{ width: failed ? "100%" : `${pct}%` }}
        />
      </div>

      <div className="mt-2.5 space-y-1">
        {items.map((it) => (
          <div
            key={it.key}
            className={cn(
              "flex items-center gap-2.5 rounded-xl border px-2.5 py-1.5 text-[13px] transition-colors",
              it.status === "active"
                ? "border-amber-500/25 bg-amber-500/[0.07]"
                : it.status === "failed"
                  ? "border-rose-500/25 bg-rose-500/[0.07]"
                  : it.status === "done"
                    ? "border-border/40 bg-background/50"
                    : "border-transparent bg-muted/20",
            )}
          >
            {it.status === "done" ? (
              <span className="flex size-3.5 shrink-0 items-center justify-center">
                <span className="size-2 rounded-full bg-emerald-500" />
              </span>
            ) : it.status === "active" ? (
              <Loader2 className="size-3.5 shrink-0 animate-spin text-amber-400" />
            ) : it.status === "failed" ? (
              <X className="size-3.5 shrink-0 text-rose-500" strokeWidth={3} />
            ) : (
              <span className="flex size-3.5 shrink-0 items-center justify-center">
                <span className="size-1.5 rounded-full ring-1 ring-muted-foreground/30" />
              </span>
            )}
            <span
              className={cn(
                "truncate transition-colors",
                it.status === "pending"
                  ? "text-muted-foreground/50"
                  : it.status === "active"
                    ? "font-medium text-foreground"
                    : "text-foreground/80",
              )}
            >
              {it.label}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

const MessageItem = memo(function MessageItem({
  message,
}: {
  message: UIMessage;
}) {
  const { t } = useTranslation();
  const isUser = message.role === "user";
  return (
    <div
      className={cn(
        "flex min-w-0 max-w-full flex-col gap-1.5",
        isUser ? "items-end" : "items-start",
      )}
    >
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
              <span key={i} className="whitespace-pre-wrap">
                {part.text}
              </span>
            ) : (
              <Markdown key={i}>{part.text}</Markdown>
            );
          }
          if (part.type === "reasoning") {
            const text = (part as { text?: string }).text ?? "";
            if (!text.trim()) return null;
            return (
              <div
                key={i}
                className="my-1.5 w-full rounded-2xl border border-border/40 bg-muted/20 px-3.5 py-3"
              >
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
          if (part.type === "data-design") {
            const items = (part as { data?: { items?: DesignItem[] } }).data
              ?.items;
            if (!items?.length) return null;
            return <DesignProgress key={i} items={items} />;
          }
          if (part.type === "tool-design_workflow") {
            return null;
          }
          if (part.type.startsWith("tool-")) {
            const p = part as ToolPart;
            const o = p.output as
              | {
                  id?: string;
                  from?: string;
                  to?: string;
                  wires?: { from?: string; to?: string }[];
                }
              | undefined;
            const label =
              o?.id ??
              (Array.isArray(o?.wires)
                ? o.wires.map((w) => `${w.from} → ${w.to}`).join(", ")
                : o?.from && o?.to
                  ? `${o.from} → ${o.to}`
                  : "");
            const done = p.state === "output-available";
            return (
              <div
                key={i}
                className="my-1 flex w-fit max-w-full items-center gap-2 rounded-lg border border-border/50 bg-muted/40 px-2 py-1 font-mono text-[11px] text-muted-foreground"
              >
                <span
                  className={cn(
                    "size-1.5 shrink-0 rounded-full",
                    done ? "bg-emerald-500" : "bg-amber-500 animate-pulse",
                  )}
                />
                <span className="shrink-0">
                  {part.type.replace("tool-", "")}
                </span>
                {label && (
                  <span className="truncate text-foreground/70">{label}</span>
                )}
              </div>
            );
          }
          return null;
        })}
      </div>
      {!isUser && usageOf(message.metadata) && (
        <div className="font-mono text-[10px] text-muted-foreground/60">
          ↑{usageOf(message.metadata)?.inputTokens ?? 0} ↓
          {usageOf(message.metadata)?.outputTokens ?? 0}
        </div>
      )}
    </div>
  );
});

interface ChatProps {
  conversationId: string;
  onNewChat: () => void;
  onOps: (ops: WorkflowOp[]) => void;
  onBuilding?: (building: boolean) => void;
  workflowState?: string;
  onReady?: (send: (text: string) => void) => void;
}

export function Chat(props: ChatProps) {
  const { data, isLoading } = useConversation(props.conversationId);
  if (isLoading) {
    return (
      <div className="flex h-full w-full items-center justify-center">
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground/70" />
      </div>
    );
  }
  return (
    <ChatThread
      key={props.conversationId}
      {...props}
      initialMessages={data ?? []}
    />
  );
}

function ChatThread({
  conversationId,
  onNewChat,
  onOps,
  onBuilding,
  workflowState,
  onReady,
  initialMessages,
}: ChatProps & { initialMessages: UIMessage[] }) {
  const { t, i18n } = useTranslation();
  const stateRef = useRef("");
  stateRef.current = workflowState ?? "";
  const qc = useQueryClient();

  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api: "/api/chat",
        prepareSendMessagesRequest({ messages, id }) {
          return {
            headers: spaceHeaders(),
            body: {
              message: messages[messages.length - 1],
              conversationId: id,
              workflowState: stateRef.current,
            },
          };
        },
      }),
    [],
  );

  const [chatError, setChatError] = useState<string | null>(null);
  const { messages, sendMessage, status } = useChat({
    id: conversationId,
    messages: initialMessages,
    transport,
    experimental_throttle: 50,
    onError: (e) => {
      const msg = errorMessage(e);
      setChatError(msg);
      reportLog({ message: "Chat request failed", detail: msg });
    },
    onFinish: () => {
      void qc.invalidateQueries({ queryKey: ["conversations"] });
      void qc.invalidateQueries({ queryKey: ["conversation"] });
    },
  });
  const { requireAuth } = useAuth();
  const initialIds = useRef(new Set(initialMessages.map((m) => m.id)));
  const [input, setInput] = useState("");
  const [connectProvider, setConnectProvider] = useState<string | null>(null);
  const handledConnects = useRef<Set<string>>(new Set());
  const { data: connectionsData } = useConnections();
  const taRef = useRef<HTMLTextAreaElement>(null);

  const grow = () => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 208) + "px";
  };

  const useExample = (text: string) => {
    setInput(text);
    requestAnimationFrame(() => {
      grow();
      taRef.current?.focus();
    });
  };

  const send = useCallback(
    (text: string) => void sendMessage({ text }),
    [sendMessage],
  );

  useEffect(() => {
    onReady?.(send);
  }, [send, onReady]);

  const ops = useMemo(() => {
    const out: WorkflowOp[] = [];
    const isFunc = (o: unknown): o is AuthoredFunc =>
      !!o &&
      typeof (o as AuthoredFunc).id === "string" &&
      Array.isArray((o as AuthoredFunc).inputs);
    messages.forEach((m) => {
      if (initialIds.current.has(m.id)) return;
      (m.parts as ToolPart[]).forEach((part, i) => {
        if (part.state !== "output-available") return;
        const key = `${m.id}:${i}`;
        const o = part.output as Record<string, unknown> | undefined;
        if (!o) return;
        switch (part.type) {
          case "tool-design_workflow": {
            const dw = o as {
              name?: string;
              funcs?: AuthoredFunc[];
              wires?: Wire[];
              trigger?: TriggerConfig;
              inputForm?: InputForm;
            };
            if (dw.name)
              out.push({ key: `${key}:n`, kind: "name", name: dw.name });
            if (dw.funcs?.length)
              out.push({ key: `${key}:f`, kind: "funcs", funcs: dw.funcs });
            if (dw.wires?.length)
              out.push({ key: `${key}:w`, kind: "wires", wires: dw.wires });
            if (dw.trigger)
              out.push({
                key: `${key}:t`,
                kind: "trigger",
                trigger: dw.trigger,
              });
            if (dw.inputForm)
              out.push({
                key: `${key}:if`,
                kind: "inputForm",
                inputForm: dw.inputForm,
              });
            break;
          }
          case "tool-author_func":
          case "tool-update_func":
            if (isFunc(o)) out.push({ key, kind: "funcs", funcs: [o] });
            break;
          case "tool-wire":
            if (Array.isArray(o.wires)) {
              const ws = (o.wires as Wire[]).filter((w) => w.from && w.to);
              if (ws.length) out.push({ key, kind: "wires", wires: ws });
            } else if (o.from && o.to) {
              out.push({ key, kind: "wires", wires: [o as unknown as Wire] });
            }
            break;
          case "tool-delete_func":
            if (typeof o.id === "string")
              out.push({ key, kind: "deleteFunc", id: o.id });
            break;
          case "tool-unwire":
            if (typeof o.to === "string")
              out.push({
                key,
                kind: "unwire",
                to: o.to,
                toInput: typeof o.toInput === "string" ? o.toInput : undefined,
              });
            break;
        }
      });
    });
    return out;
  }, [messages]);

  const building = useMemo(() => {
    for (const m of messages) {
      for (const part of m.parts as ToolPart[]) {
        if (
          part.type === "tool-design_workflow" &&
          part.state &&
          !part.state.startsWith("output")
        ) {
          return true;
        }
      }
    }
    return false;
  }, [messages]);

  useEffect(() => {
    onOps(ops);
  }, [ops, onOps]);

  useEffect(() => {
    // Wait until connections have loaded before deciding — otherwise the first
    // pass (empty list) marks the request_connection parts as handled and the
    // dialog pops for providers that are in fact already connected.
    if (!connectionsData) return;
    const connected = new Set(connectionsData.map((c) => c.provider));
    let target: string | null = null;
    messages.forEach((m) => {
      (m.parts as ToolPart[]).forEach((part, i) => {
        if (part.type !== "tool-request_connection") return;
        if (part.state !== "output-available") return;
        const key = `${m.id}:${i}`;
        if (handledConnects.current.has(key)) return;
        handledConnects.current.add(key);
        const o = part.output as { provider?: string } | undefined;
        // Don't auto-pop the dialog for a provider that's already connected.
        // On reload `handledConnects` is empty, so historical request_connection
        // calls would otherwise re-open the dialog for connections the user has
        // since set up.
        if (o?.provider && !connected.has(o.provider)) target = o.provider;
      });
    });
    if (target) setConnectProvider(target);
  }, [messages, connectionsData]);

  useEffect(() => {
    onBuilding?.(building);
  }, [building, onBuilding]);

  const totalTokens = useMemo(() => {
    const seen = new Set<string>();
    let sum = 0;
    for (const m of messages) {
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      const u = usageOf(m.metadata);
      if (u?.totalTokens) sum += u.totalTokens;
    }
    return sum;
  }, [messages]);

  const submit = (e: { preventDefault: () => void }) => {
    e.preventDefault();
    const text = input.trim();
    if (!text) return;
    const fire = () => {
      setChatError(null);
      send(text);
      setInput("");
      if (taRef.current) taRef.current.style.height = "auto";
    };
    if (!requireAuth(fire)) return;
    fire();
  };

  return (
    <div className="flex h-full w-full flex-col">
      <div className="flex items-center gap-2 px-3 py-1.5">
        <span className="ml-auto rounded bg-muted/60 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground/80">
          {t("chat.tokens", { n: totalTokens.toLocaleString(i18n.language) })}
        </span>
        {messages.length > 0 && (
          <button
            type="button"
            title={t("chat.newChat")}
            disabled={status === "streaming" || status === "submitted"}
            onClick={onNewChat}
            className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
          >
            <SquarePen className="size-3.5" />
          </button>
        )}
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-3 p-3">
          {messages.length === 0 && (
            <div className="flex flex-col items-center px-4 pb-2 pt-10 text-center">
              <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-secondary ring-1 ring-border">
                <Sparkles className="h-5 w-5 text-foreground/80" />
              </div>
              <h2 className="mt-4 text-[15px] font-medium text-foreground">
                {t("chat.emptyTitle")}
              </h2>
              <p className="mt-1 max-w-xs text-[13px] leading-relaxed text-muted-foreground">
                {t("chat.emptySubtitle")}
              </p>

              <div className="mt-6 flex w-full flex-col gap-2">
                {EXAMPLE_KEYS.map((key) => {
                  const ex = t(key);
                  return (
                    <button
                      key={key}
                      type="button"
                      onClick={() => useExample(ex)}
                      className="group flex items-center gap-2.5 rounded-xl border border-border/50 bg-background-subtle px-3 py-2.5 text-left text-[13px] text-foreground/80 transition-colors hover:border-border hover:bg-secondary hover:text-foreground"
                    >
                      <span className="flex-1 leading-snug">{ex}</span>
                      <ArrowUpRight className="h-4 w-4 shrink-0 text-muted-foreground/50 transition-colors group-hover:text-foreground/70" />
                    </button>
                  );
                })}
              </div>
            </div>
          )}
          {messages.map((m) => (
            <MessageItem key={m.id} message={m} />
          ))}
          {(status === "streaming" || status === "submitted") && (
            <div className="flex items-center gap-2 px-1 text-xs text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin text-muted-foreground/70" />
              <span>
                {streamLabel(
                  messages as { role: string; parts: ToolPart[] }[],
                  t,
                )}
              </span>
            </div>
          )}
        </div>
      </ScrollArea>

      {chatError && (
        <Alert className="mx-2 mb-1 w-auto rounded-xl border-tone-rose/30 bg-tone-rose/10 py-2 text-tone-rose-fg">
          <AlertDescription className="flex items-center gap-2 text-tone-rose-fg">
            <span className="min-w-0 flex-1">{chatError}</span>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={() => setChatError(null)}
              className="size-5 shrink-0 text-tone-rose-fg/70 hover:bg-tone-rose/20 hover:text-tone-rose-fg"
            >
              <X className="size-3.5" />
            </Button>
          </AlertDescription>
        </Alert>
      )}

      <form onSubmit={submit} className="p-2">
        <div className="flex items-end gap-2 rounded-2xl border border-border/40 bg-background-subtle p-2 transition-colors focus-within:border-foreground/20">
          <textarea
            ref={taRef}
            value={input}
            rows={1}
            onChange={(e) => {
              setInput(e.target.value);
              grow();
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit(e);
              }
            }}
            placeholder={t("chat.placeholder")}
            className="max-h-52 min-h-20 flex-1 resize-none self-stretch border-none bg-transparent px-1 py-1 text-sm leading-relaxed text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-0"
          />
          <Button
            type="submit"
            size="icon"
            disabled={status === "streaming" || status === "submitted"}
            className="h-8 w-8 shrink-0 rounded-xl"
          >
            ↑
          </Button>
        </div>
      </form>

      <ModelPicker />

      {connectProvider && (
        <ConnectionDialog
          provider={connectProvider}
          onClose={() => setConnectProvider(null)}
        />
      )}
    </div>
  );
}
