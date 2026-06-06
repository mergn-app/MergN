import { useEffect, useRef, useState } from "react";
import { Check, ChevronsUpDown, Plus } from "lucide-react";
import { useSpaces, useCreateSpace } from "./queries";
import { getSpace, setSpace } from "./space";

const SAFE = /^[A-Za-z0-9_-]+$/;

export function SpaceSwitcher() {
  const current = getSpace();
  const { data: spaces = [] } = useSpaces();
  const createSpace = useCreateSpace();
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
        setCreating(false);
      }
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);

  const switchTo = (id: string) => {
    if (id === current) {
      setOpen(false);
      return;
    }
    setSpace(id);
    window.location.reload();
  };

  const create = () => {
    const id = name.trim();
    if (!SAFE.test(id)) return;
    createSpace.mutate(id, { onSuccess: () => switchTo(id) });
  };

  const ids = spaces.map((s) => s.id);
  if (!ids.includes(current)) ids.unshift(current);

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 rounded-lg border border-border/50 bg-background-subtle px-2.5 py-1.5 text-xs font-medium text-foreground/90 transition-colors hover:border-border"
      >
        <span className="size-1.5 rounded-full bg-emerald-500" />
        <span className="max-w-32 truncate">{current}</span>
        <ChevronsUpDown className="h-3.5 w-3.5 text-muted-foreground" />
      </button>

      {open && (
        <div className="absolute left-0 top-full z-50 mt-1 w-56 rounded-xl border border-border/60 bg-card p-1">
          <div className="px-2 py-1 text-[10px] font-medium uppercase tracking-widest text-muted-foreground/70">
            Spaces
          </div>
          <div className="max-h-64 overflow-auto">
            {ids.map((id) => (
              <button
                key={id}
                onClick={() => switchTo(id)}
                className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] text-foreground/85 transition-colors hover:bg-secondary"
              >
                <span className="flex-1 truncate">{id}</span>
                {id === current && (
                  <Check className="h-3.5 w-3.5 shrink-0 text-emerald-400" />
                )}
              </button>
            ))}
          </div>
          <div className="my-1 h-px bg-border/50" />
          {creating ? (
            <div className="flex items-center gap-1 p-1">
              <input
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") create();
                  if (e.key === "Escape") setCreating(false);
                }}
                placeholder="space-id"
                className="h-7 min-w-0 flex-1 rounded-md border border-border/50 bg-background px-2 font-mono text-xs outline-none transition-colors focus:border-foreground/20"
              />
              <button
                onClick={create}
                disabled={!SAFE.test(name.trim()) || createSpace.isPending}
                className="rounded-md bg-primary px-2 py-1 text-xs font-medium text-primary-foreground transition-opacity disabled:opacity-40"
              >
                Add
              </button>
            </div>
          ) : (
            <button
              onClick={() => setCreating(true)}
              className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
            >
              <Plus className="h-3.5 w-3.5" />
              New space
            </button>
          )}
        </div>
      )}
    </div>
  );
}
