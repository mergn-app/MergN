import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useSession, signOut } from "./auth";
import { AuthForm } from "./AuthForm";

export interface AuthUser {
  id: string;
  email: string;
  name: string;
}

interface AuthContextValue {
  user: AuthUser | null;
  pending: boolean;
  requireAuth: (action?: () => void) => boolean;
  withAuth: <A extends unknown[]>(fn: (...args: A) => void) => (...args: A) => void;
  signOut: () => void;
}

const Ctx = createContext<AuthContextValue>({
  user: null,
  pending: true,
  requireAuth: () => false,
  withAuth: (fn) => fn,
  signOut: () => {},
});

const CACHE_KEY = "auth.user";

function readCachedUser(): AuthUser | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    return raw ? (JSON.parse(raw) as AuthUser) : null;
  } catch {
    return null;
  }
}

function writeCachedUser(user: AuthUser | null) {
  try {
    if (user) localStorage.setItem(CACHE_KEY, JSON.stringify(user));
    else localStorage.removeItem(CACHE_KEY);
  } catch {
    return;
  }
}

export function useAuth(): AuthContextValue {
  return useContext(Ctx);
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const { data: session, isPending } = useSession();
  const [cachedUser, setCachedUser] = useState<AuthUser | null>(readCachedUser);

  const resolvedUser = (session?.user as AuthUser | undefined) ?? null;
  const user = isPending ? cachedUser : resolvedUser;

  useEffect(() => {
    if (isPending) return;
    writeCachedUser(resolvedUser);
    setCachedUser(resolvedUser);
  }, [isPending, resolvedUser]);

  const [open, setOpen] = useState(false);
  const [closing, setClosing] = useState(false);
  const pendingAction = useRef<(() => void) | null>(null);
  const prevUserId = useRef<string | null>(null);
  const qc = useQueryClient();
  const navigate = useNavigate();

  useEffect(() => {
    const id = user?.id ?? null;
    if (id && id !== prevUserId.current) {
      qc.invalidateQueries();
      setClosing(true);
      const action = pendingAction.current;
      pendingAction.current = null;
      if (action) action();
    }
    if (!id && prevUserId.current) {
      qc.clear();
      void navigate({ to: "/", replace: true });
    }
    prevUserId.current = id;
  }, [user, qc, navigate]);

  const requireAuth = useCallback(
    (action?: () => void) => {
      if (user) return true;
      pendingAction.current = action ?? null;
      setClosing(false);
      setOpen(true);
      return false;
    },
    [user],
  );

  const withAuth = useCallback(
    <A extends unknown[]>(fn: (...args: A) => void) =>
      (...args: A) => {
        if (!requireAuth(() => fn(...args))) return;
        fn(...args);
      },
    [requireAuth],
  );

  const doSignOut = useCallback(() => {
    writeCachedUser(null);
    setCachedUser(null);
    void signOut();
  }, []);

  const close = () => {
    pendingAction.current = null;
    setClosing(true);
  };

  const onOverlayAnimEnd = (e: React.AnimationEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget || !closing) return;
    setOpen(false);
    setClosing(false);
  };

  return (
    <Ctx.Provider
      value={{
        user,
        pending: isPending,
        requireAuth,
        withAuth,
        signOut: doSignOut,
      }}
    >
      {children}
      {open && (
        <div
          className={cn(
            "fixed inset-0 z-100 flex items-center justify-center bg-background/70 p-4 backdrop-blur-xs duration-200",
            closing
              ? "animate-out fade-out fill-mode-forwards"
              : "animate-in fade-in",
          )}
          onMouseDown={close}
          onAnimationEnd={onOverlayAnimEnd}
        >
          <div
            className={cn(
              "relative w-full max-w-sm rounded-2xl border border-border/50 bg-card p-6 duration-200 ease-out",
              closing
                ? "animate-out fade-out zoom-out-95 slide-out-to-bottom-2 fill-mode-forwards"
                : "animate-in fade-in zoom-in-95 slide-in-from-bottom-2",
            )}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              onClick={close}
              className="absolute right-3 top-3 rounded-md p-1 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
            >
              <X className="h-4 w-4" />
            </button>
            <AuthForm />
          </div>
        </div>
      )}
    </Ctx.Provider>
  );
}
