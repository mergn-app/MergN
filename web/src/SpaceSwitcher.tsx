import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "@tanstack/react-router";
import { Check, ChevronsUpDown, Plus } from "lucide-react";
import { useSpaces, useCreateSpace } from "./queries";
import { getSpace } from "./space";
import { useAuth } from "./authContext";
import { Skeleton } from "@/components/ui/skeleton";

export function SpaceSwitcher() {
  const { t } = useTranslation();
  const current = getSpace();
  const navigate = useNavigate();
  const { user, pending, requireAuth } = useAuth();
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
    setOpen(false);
    if (id === current) return;
    void navigate({ to: "/s/$spaceId", params: { spaceId: id } });
  };

  const create = () => {
    const label = name.trim();
    if (!label) return;
    const fire = () =>
      createSpace.mutate(label, { onSuccess: (s) => switchTo(s.id) });
    if (!requireAuth(fire)) return;
    fire();
  };

  // One workspace per account — hide the create UI once the user has a space.
  const atLimit = spaces.length >= 1;

  const currentName =
    spaces.find((s) => s.id === current)?.name ??
    (user ? t("spaces.workspace") : t("spaces.signInToStart"));

  if (pending) return <Skeleton className="h-[30px] w-32 rounded-lg" />;

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => {
          if (!user) {
            requireAuth();
            return;
          }
          setOpen((o) => !o);
        }}
        className="flex items-center gap-1.5 rounded-lg border border-border/50 bg-background-subtle px-2.5 py-1.5 text-xs font-medium text-foreground/90 transition-colors hover:border-border"
      >
        <span className="size-1.5 rounded-full bg-emerald-500" />
        <span className="max-w-32 truncate">{currentName}</span>
        <ChevronsUpDown className="h-3.5 w-3.5 text-muted-foreground" />
      </button>

      {open && (
        <div className="absolute left-0 top-full z-50 mt-1 w-56 rounded-xl border border-border/60 bg-card p-1">
          <div className="px-2 py-1 text-[10px] font-medium uppercase tracking-widest text-muted-foreground/70">
            {t("spaces.title")}
          </div>
          <div className="max-h-64 overflow-auto">
            {spaces.map((s) => (
              <button
                key={s.id}
                onClick={() => switchTo(s.id)}
                className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] text-foreground/85 transition-colors hover:bg-secondary"
              >
                <span className="flex-1 truncate">{s.name}</span>
                {s.id === current && (
                  <Check className="h-3.5 w-3.5 shrink-0 text-emerald-400" />
                )}
              </button>
            ))}
          </div>
          {!atLimit && <div className="my-1 h-px bg-border/50" />}
          {atLimit ? null : creating ? (
            <div className="flex items-center gap-1 p-1">
              <input
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") create();
                  if (e.key === "Escape") setCreating(false);
                }}
                placeholder={t("spaces.spaceName")}
                className="h-7 min-w-0 flex-1 rounded-md border border-border/50 bg-background px-2 text-xs outline-none transition-colors focus:border-foreground/20"
              />
              <button
                onClick={create}
                disabled={!name.trim() || createSpace.isPending}
                className="rounded-md bg-primary px-2 py-1 text-xs font-medium text-primary-foreground transition-opacity disabled:opacity-40"
              >
                {t("spaces.add")}
              </button>
            </div>
          ) : (
            <button
              onClick={() => setCreating(true)}
              className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
            >
              <Plus className="h-3.5 w-3.5" />
              {t("spaces.newSpace")}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
