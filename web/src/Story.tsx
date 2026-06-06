import { BookOpenText } from "lucide-react";
import { cn } from "@/lib/utils";
import type { AuthoredFunc, Wire } from "./types";
import { lineage, outputsOf, type Source } from "./lineage";

interface StoryProps {
  funcs: AuthoredFunc[];
  wires: Wire[];
  triggerFields: string[];
  runStatus: Record<string, string>;
  connectedProviders: Set<string>;
  configValues: Record<string, Record<string, string>>;
  building?: boolean;
  selectedId: string | null;
  onSelect: (id: string) => void;
}

type SkelLine = { w: string; head?: 1 | 2; gap: number };

const SKELETON_LINES: SkelLine[] = [
  { w: "60%", head: 1, gap: 0 },
  { w: "100%", head: undefined, gap: 28 },
  { w: "94%", head: undefined, gap: 12 },
  { w: "78%", head: undefined, gap: 12 },
  { w: "34%", head: 2, gap: 34 },
  { w: "100%", head: undefined, gap: 18 },
  { w: "88%", head: undefined, gap: 12 },
  { w: "66%", head: undefined, gap: 12 },
  { w: "40%", head: 2, gap: 34 },
  { w: "96%", head: undefined, gap: 18 },
  { w: "82%", head: undefined, gap: 12 },
  { w: "58%", head: undefined, gap: 12 },
];

function StorySkeleton() {
  return (
    <div className="h-full overflow-hidden">
      <article className="mx-auto max-w-2xl px-10 py-12">
        <div className="mb-9 flex items-center gap-2 text-xs text-muted-foreground">
          <span className="size-1.5 animate-pulse rounded-full bg-amber-400" />
          Writing your workflow
        </div>

        {SKELETON_LINES.map((line, i) => {
          const isLast = i === SKELETON_LINES.length - 1;
          return (
            <div
              key={i}
              className="flex items-center"
              style={{ marginTop: line.gap }}
            >
              <div
                className={cn(
                  "animate-pulse rounded-full",
                  line.head === 1
                    ? "h-6 bg-foreground/[0.13]"
                    : line.head === 2
                      ? "h-4 bg-foreground/[0.09]"
                      : "h-3 bg-foreground/[0.06]",
                )}
                style={{ width: line.w, animationDelay: `${i * 90}ms` }}
              />
              {isLast && (
                <span className="ml-2 inline-block h-4 w-[2px] animate-pulse rounded-full bg-foreground/40" />
              )}
            </div>
          );
        })}
      </article>
    </div>
  );
}

const TONE: Record<string, string> = {
  trigger: "bg-tone-amber/12 text-tone-amber-fg ring-tone-amber/30",
  step: "bg-tone-blue/12 text-tone-blue-fg ring-tone-blue/30",
  out: "bg-tone-emerald/12 text-tone-emerald-fg ring-tone-emerald/30",
  config: "bg-muted text-muted-foreground ring-border",
  bad: "bg-tone-rose/12 text-tone-rose-fg ring-tone-rose/30",
};

function Tok({ children, tone }: { children: React.ReactNode; tone: string }) {
  return (
    <span
      className={cn(
        "mx-0.5 inline-block rounded px-1.5 py-0.5 font-mono text-[12px] leading-none ring-1",
        TONE[tone],
      )}
    >
      {children}
    </span>
  );
}

function NumBadge({ n }: { n: number }) {
  return (
    <span className="mr-1 inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-muted px-1 text-[11px] font-medium text-muted-foreground">
      {n}
    </span>
  );
}

const STATUS_DOT: Record<string, string> = {
  done: "bg-emerald-500",
  failed: "bg-rose-500",
  pending: "bg-amber-500 animate-pulse",
};

export function Story({
  funcs,
  wires,
  triggerFields,
  runStatus,
  connectedProviders,
  configValues,
  building,
  selectedId,
  onSelect,
}: StoryProps) {
  const { ordered, sourceOf } = lineage(funcs, wires, configValues);

  if (building && funcs.length === 0) {
    return <StorySkeleton />;
  }

  if (funcs.length === 0 && triggerFields.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <div className="w-full max-w-md text-center">
          <div className="mx-auto flex size-12 items-center justify-center rounded-2xl bg-secondary ring-1 ring-border">
            <BookOpenText className="h-5 w-5 text-foreground/80" />
          </div>
          <h2 className="mt-5 text-lg font-medium text-foreground">
            Your workflow, in plain language
          </h2>
          <p className="mx-auto mt-1.5 max-w-xs text-[13px] leading-relaxed text-muted-foreground">
            Describe an automation in the chat — it appears here as readable
            steps you can follow end to end.
          </p>

          <div className="mt-7 overflow-hidden rounded-2xl border border-border/40 bg-card/40 p-5 text-left">
            <div className="pointer-events-none select-none space-y-3 text-[13px] leading-7 text-foreground/45 [-webkit-mask-image:linear-gradient(to_bottom,black_55%,transparent)] [mask-image:linear-gradient(to_bottom,black_55%,transparent)]">
              <p>
                <span className="text-muted-foreground/70">
                  When this runs, it receives{" "}
                </span>
                <Tok tone="trigger">email</Tok>
                <Tok tone="trigger">amount</Tok>
                <span className="text-muted-foreground/70"> from the trigger.</span>
              </p>
              <p>
                <NumBadge n={1} />
                <span className="font-medium text-foreground/70">
                  Create customer.
                </span>{" "}
                <span className="text-muted-foreground/70">It uses </span>
                <Tok tone="trigger">email</Tok>
                <span className="text-muted-foreground/70">, producing </span>
                <Tok tone="out">customerId</Tok>
                <span className="text-muted-foreground/70">.</span>
              </p>
              <p>
                <NumBadge n={2} />
                <span className="font-medium text-foreground/70">
                  Charge the card.
                </span>{" "}
                <span className="text-muted-foreground/70">It uses </span>
                <Tok tone="step">customerId</Tok>
                <span className="text-muted-foreground/70"> and </span>
                <Tok tone="trigger">amount</Tok>
                <span className="text-muted-foreground/70">.</span>
              </p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full overflow-auto">
      <article className="mx-auto max-w-2xl px-8 py-10 text-[15px] leading-8 text-foreground/90">
        <p>
          <span className="text-muted-foreground">When this workflow runs, </span>
          {triggerFields.length > 0 ? (
            <>
              it receives{" "}
              {triggerFields.map((f, i) => (
                <span key={f}>
                  <Tok tone="trigger">{f}</Tok>
                  {i < triggerFields.length - 1 ? " " : ""}
                </span>
              ))}
              <span className="text-muted-foreground"> from the trigger.</span>
            </>
          ) : (
            <span className="text-muted-foreground">it starts.</span>
          )}
        </p>

        <div className="mt-6 space-y-6">
          {ordered.map((f, idx) => {
            const num = idx + 1;
            const status = runStatus[f.id];
            const needsConnection =
              !f.pure &&
              f.requires.some((r) => !connectedProviders.has(r.provider));
            const provider = f.requires[0]?.provider;
            const outputs = outputsOf(f);

            const resolved = f.inputs.map((p) => ({
              name: p.name,
              src: sourceOf(f.id, p.name) as Source,
            }));
            const triggerIns = resolved.filter((r) => r.src.kind === "trigger");
            const configIns = resolved.filter((r) => r.src.kind === "config");
            const unbound = resolved.filter((r) => r.src.kind === "unbound");
            const stepGroups = new Map<
              number,
              { title: string; names: string[] }
            >();
            for (const r of resolved) {
              if (r.src.kind !== "step") continue;
              const g = stepGroups.get(r.src.num) ?? {
                title: r.src.title,
                names: [],
              };
              g.names.push(r.name);
              stepGroups.set(r.src.num, g);
            }

            const clauses: React.ReactNode[] = [];
            if (triggerIns.length)
              clauses.push(
                <span key="trig">
                  {triggerIns.map((r) => (
                    <Tok key={r.name} tone="trigger">
                      {r.name}
                    </Tok>
                  ))}
                  <span className="text-muted-foreground"> from the trigger</span>
                </span>,
              );
            for (const [n, g] of [...stepGroups].sort((a, b) => a[0] - b[0]))
              clauses.push(
                <span key={`s${n}`}>
                  {g.names.map((name) => (
                    <Tok key={name} tone="step">
                      {name}
                    </Tok>
                  ))}
                  <span className="text-muted-foreground"> from </span>
                  <NumBadge n={n} />
                  <span className="text-tone-blue-fg">{g.title}</span>
                </span>,
              );
            if (configIns.length)
              clauses.push(
                <span key="cfg">
                  {configIns.map((r) => (
                    <Tok key={r.name} tone="config">
                      {r.name}
                    </Tok>
                  ))}
                  <span className="text-muted-foreground"> from config</span>
                </span>,
              );

            return (
              <div
                key={f.id}
                onClick={() => onSelect(f.id)}
                className={cn(
                  "cursor-pointer rounded-2xl border border-transparent p-4 transition-colors hover:border-border hover:bg-card",
                  selectedId === f.id && "border-border bg-card",
                )}
              >
                <p>
                  <NumBadge n={num} />
                  <span className="font-medium text-foreground">{f.title}.</span>{" "}
                  <span className="text-foreground/85">{f.summary}</span>{" "}
                  {clauses.length > 0 && (
                    <span>
                      <span className="text-muted-foreground">It uses </span>
                      {clauses.map((c, i) => (
                        <span key={i}>
                          {c}
                          {i < clauses.length - 1 ? (
                            <span className="text-muted-foreground">
                              {i === clauses.length - 2 ? " and " : ", "}
                            </span>
                          ) : null}
                        </span>
                      ))}
                      <span className="text-muted-foreground">, </span>
                    </span>
                  )}
                  {outputs.length > 0 && (
                    <span>
                      <span className="text-muted-foreground">producing </span>
                      {outputs.map((o) => (
                        <Tok key={o} tone="out">
                          {o}
                        </Tok>
                      ))}
                    </span>
                  )}
                  <span className="text-muted-foreground">.</span>
                </p>

                {(provider || needsConnection || unbound.length > 0 || status) && (
                  <div className="mt-2 flex flex-wrap items-center gap-2 text-[12px]">
                    {status && (
                      <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                        <span
                          className={cn(
                            "size-2 rounded-full",
                            STATUS_DOT[status] ?? "bg-muted-foreground",
                          )}
                        />
                        {status}
                      </span>
                    )}
                    {provider && (
                      <span className="font-mono text-muted-foreground">
                        via {provider}
                      </span>
                    )}
                    {needsConnection && (
                      <span className="text-tone-amber-fg">⚠ needs connection</span>
                    )}
                    {unbound.length > 0 && (
                      <span className="text-tone-rose-fg">
                        ⚠ missing{" "}
                        {unbound.map((r) => (
                          <Tok key={r.name} tone="bad">
                            {r.name}
                          </Tok>
                        ))}
                      </span>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </article>
    </div>
  );
}
