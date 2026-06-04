import { useState } from "react";
import { Button } from "@/components/ui/button";
import type { AuthoredFunc, Wire } from "./types";

interface RunRecord {
  nodeId: string;
  status: string;
  output?: unknown;
  error?: string;
}

export function RunPanel({
  funcs,
  wires,
  config,
  onStatus,
}: {
  funcs: AuthoredFunc[];
  wires: Wire[];
  config: Record<string, Record<string, string>>;
  onStatus: (status: Record<string, string>) => void;
}) {
  const [input, setInput] = useState("{}");
  const [records, setRecords] = useState<RunRecord[]>([]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setError(null);
    let parsed: unknown;
    try {
      parsed = JSON.parse(input || "{}");
    } catch {
      setError("Invalid JSON input");
      return;
    }
    setRunning(true);
    setRecords([]);
    onStatus({});
    try {
      const res = await fetch("/api/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ funcs, wires, config, input: parsed }),
      });
      if (!res.body) throw new Error("no stream");

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      const recs: RunRecord[] = [];
      const status: Record<string, string> = {};
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (!data || data === "[DONE]") continue;
          const rec = JSON.parse(data) as RunRecord;
          recs.push(rec);
          status[rec.nodeId] = rec.status;
          setRecords([...recs]);
          onStatus({ ...status });
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="flex h-56 flex-col border-t border-border/40 bg-muted/20">
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <span className="text-xs font-semibold">Run</span>
        <Button size="sm" onClick={run} disabled={running || funcs.length === 0}>
          {running ? "running…" : "▶ Run"}
        </Button>
        {error && <span className="text-xs text-destructive">{error}</span>}
      </div>
      <div className="flex min-h-0 flex-1">
        <div className="flex w-1/3 flex-col border-r p-2">
          <div className="mb-1 text-[11px] text-muted-foreground">
            trigger input (JSON)
          </div>
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            spellCheck={false}
            className="min-h-0 flex-1 resize-none rounded-md border bg-background p-2 font-mono text-xs"
          />
        </div>
        <div className="min-w-0 flex-1 overflow-auto p-2 font-mono text-[11px]">
          {records.length === 0 && (
            <div className="text-muted-foreground">no run yet</div>
          )}
          {records.map((r, i) => (
            <div
              key={i}
              className={
                r.status === "failed"
                  ? "text-destructive"
                  : r.status === "done"
                    ? "text-emerald-400"
                    : "text-muted-foreground"
              }
            >
              {r.status.padEnd(8)} {r.nodeId}
              {r.output !== undefined ? ` → ${JSON.stringify(r.output)}` : ""}
              {r.error ? ` ⚠ ${r.error}` : ""}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
