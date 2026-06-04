import { useEffect, useMemo, useState } from "react";
import { useChat } from "@ai-sdk/react";
import type { AuthoredFunc, Wire } from "./types";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";

interface ToolPart {
  type: string;
  state?: string;
  output?: unknown;
}

interface Usage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

function usageOf(metadata: unknown): Usage | undefined {
  return (metadata as { totalUsage?: Usage } | undefined)?.totalUsage;
}

export function Chat({
  onFuncs,
  onWires,
}: {
  onFuncs: (funcs: AuthoredFunc[]) => void;
  onWires: (wires: Wire[]) => void;
}) {
  const { messages, sendMessage, status } = useChat();
  const [input, setInput] = useState("");

  const authored = useMemo(() => {
    const out: AuthoredFunc[] = [];
    const seen = new Set<string>();
    for (const m of messages) {
      for (const part of m.parts as ToolPart[]) {
        const isFuncTool =
          part.type === "tool-author_func" ||
          part.type.startsWith("tool-provider_");
        if (isFuncTool && part.state === "output-available") {
          const f = part.output as AuthoredFunc;
          if (f?.id && Array.isArray(f.inputs) && !seen.has(f.id)) {
            seen.add(f.id);
            out.push(f);
          }
        }
      }
    }
    return out;
  }, [messages]);

  const wires = useMemo(() => {
    const out: Wire[] = [];
    const seen = new Set<string>();
    for (const m of messages) {
      for (const part of m.parts as ToolPart[]) {
        if (part.type === "tool-wire" && part.state === "output-available") {
          const w = part.output as Wire;
          if (w?.from && w?.to) {
            const key = `${w.from}.${w.fromOutput}->${w.to}.${w.toInput}`;
            if (!seen.has(key)) {
              seen.add(key);
              out.push(w);
            }
          }
        }
      }
    }
    return out;
  }, [messages]);

  useEffect(() => {
    onFuncs(authored);
  }, [authored, onFuncs]);

  useEffect(() => {
    onWires(wires);
  }, [wires, onWires]);

  const totalTokens = useMemo(() => {
    let sum = 0;
    for (const m of messages) {
      const u = usageOf(m.metadata);
      if (u?.totalTokens) sum += u.totalTokens;
    }
    return sum;
  }, [messages]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const text = input.trim();
    if (!text) return;
    sendMessage({ text });
    setInput("");
  };

  return (
    <div className="flex h-full w-full flex-col">
      <div className="flex items-center px-3 py-1.5">
        <span className="ml-auto rounded bg-muted/60 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground/80">
          {totalTokens.toLocaleString()} tokens
        </span>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-3 p-3">
          {messages.length === 0 && (
            <div className="text-sm text-muted-foreground">
              Describe a step, e.g. "format a signup into a Slack message".
            </div>
          )}
          {messages.map((m) => (
            <div
              key={m.id}
              className={cn(
                "max-w-[90%]",
                m.role === "user" ? "self-end" : "self-start",
              )}
            >
              <div className="mb-1 text-[11px] text-muted-foreground">{m.role}</div>
              <div
                className={cn(
                  "whitespace-pre-wrap rounded-xl px-3 py-2 text-sm shadow-sm",
                  m.role === "user"
                    ? "bg-muted/25 text-foreground"
                    : "bg-muted/10 text-foreground",
                )}
              >
                {m.parts.map((part, i) => {
                  if (part.type === "text") return <span key={i}>{part.text}</span>;
                  if (part.type.startsWith("tool-")) {
                    const p = part as ToolPart;
                    const o = p.output as
                      | { id?: string; from?: string; to?: string }
                      | undefined;
                    const label =
                      o?.id ?? (o?.from && o?.to ? `${o.from} → ${o.to}` : "");
                    return (
                      <div
                        key={i}
                        className="py-1 font-mono text-xs text-[#6ea8ff]"
                      >
                        🔧 {part.type.replace("tool-", "")} [{p.state}]
                        {label ? ` → ${label}` : ""}
                      </div>
                    );
                  }
                  return null;
                })}
              </div>
              {m.role === "assistant" && usageOf(m.metadata) && (
                <div className="mt-1 font-mono text-[10px] text-muted-foreground/70">
                  ↑{usageOf(m.metadata)?.inputTokens ?? 0} ↓
                  {usageOf(m.metadata)?.outputTokens ?? 0}
                </div>
              )}
            </div>
          ))}
          {status === "streaming" && (
            <div className="text-xs text-muted-foreground">…</div>
          )}
        </div>
      </ScrollArea>

      <form onSubmit={submit} className="p-2">
        <div className="flex items-end gap-2 rounded-2xl border border-border/40 bg-background-subtle p-1.5 transition-colors focus-within:border-foreground/20">
          <Input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Message the builder…"
            className="flex-1 border-none bg-transparent shadow-none focus-visible:ring-0"
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
    </div>
  );
}
