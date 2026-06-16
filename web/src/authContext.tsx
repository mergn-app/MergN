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
import { useTranslation } from "react-i18next";
import { X, ServerCrash } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { useSession, signOut } from "./auth";
import { AuthForm } from "./AuthForm";
import { EmailVerify } from "./EmailVerify";
import { syncAnalyticsUser } from "./analytics";

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  emailVerified?: boolean;
}

interface AuthContextValue {
  user: AuthUser | null;
  pending: boolean;
  authDisabled: boolean | null;
  managed: boolean | null;
  maxSpaces: number | null; // workspaces allowed per account (server-configured)
  remoteMcp: boolean; // remote MCP endpoint enabled (ENABLE_REMOTE_MCP)
  // Billing is shown as an OVERLAY (not a route) so opening it never unmounts the
  // builder — the open flow, chat stream and run view keep running underneath.
  billingSpaceId: string | null;
  openBilling: (spaceId: string) => void;
  closeBilling: () => void;
  requireAuth: (action?: () => void) => boolean;
  withAuth: <A extends unknown[]>(fn: (...args: A) => void) => (...args: A) => void;
  signOut: () => void;
}

const Ctx = createContext<AuthContextValue>({
  user: null,
  pending: true,
  authDisabled: null,
  managed: null,
  maxSpaces: null,
  remoteMcp: false,
  billingSpaceId: null,
  openBilling: () => {},
  closeBilling: () => {},
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

const LOCAL_USER: AuthUser = {
  id: "local",
  email: "local@localhost",
  name: "Local",
  emailVerified: true,
};

function ApiUnreachable({ onRetry }: { onRetry: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="flex h-screen w-screen flex-col items-center justify-center bg-background px-6 text-center text-foreground">
      <div className="flex size-12 items-center justify-center rounded-2xl bg-destructive/10 text-destructive">
        <ServerCrash className="size-6" />
      </div>
      <h1 className="mt-5 text-lg font-medium">{t("errors.apiUnreachableTitle")}</h1>
      <p className="mt-2 max-w-md text-sm leading-relaxed text-muted-foreground">
        {t("errors.apiUnreachableBody")}
      </p>
      <Button className="mt-6" onClick={onRetry}>
        {t("errors.retry")}
      </Button>
    </div>
  );
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [authDisabled, setAuthDisabled] = useState<boolean | null>(null);
  const [managed, setManaged] = useState<boolean | null>(null);
  const [maxSpaces, setMaxSpaces] = useState<number | null>(null);
  const [remoteMcp, setRemoteMcp] = useState(false);
  const [billingSpaceId, setBillingSpaceId] = useState<string | null>(null);
  const openBilling = useCallback((sid: string) => setBillingSpaceId(sid), []);
  const closeBilling = useCallback(() => setBillingSpaceId(null), []);
  const [requireVerify, setRequireVerify] = useState(false);
  const [apiUnreachable, setApiUnreachable] = useState(false);
  const [configAttempt, setConfigAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setApiUnreachable(false);
    fetch("/api/config")
      .then(async (r) => {
        if (!r.ok) throw new Error(String(r.status));
        return r.json() as Promise<{
          authDisabled?: boolean;
          managed?: boolean;
          maxSpaces?: number;
          remoteMcp?: boolean;
          requireEmailVerification?: boolean;
        }>;
      })
      .then((c) => {
        if (cancelled) return;
        setAuthDisabled(!!c.authDisabled);
        setManaged(!!c.managed);
        setMaxSpaces(typeof c.maxSpaces === "number" ? c.maxSpaces : null);
        setRemoteMcp(!!c.remoteMcp);
        setRequireVerify(!!c.requireEmailVerification);
      })
      .catch(() => {
        if (cancelled) return;
        setApiUnreachable(true);
      });
    return () => {
      cancelled = true;
    };
  }, [configAttempt]);

  const { data: session, isPending } = useSession();
  const [cachedUser, setCachedUser] = useState<AuthUser | null>(readCachedUser);

  const resolvedUser = (session?.user as AuthUser | undefined) ?? null;
  const user = authDisabled
    ? LOCAL_USER
    : isPending
      ? cachedUser
      : resolvedUser;
  const pending = authDisabled === null || (!authDisabled && isPending);

  useEffect(() => {
    if (authDisabled || isPending) return;
    writeCachedUser(resolvedUser);
    setCachedUser(resolvedUser);
  }, [authDisabled, isPending, resolvedUser]);

  useEffect(() => {
    if (pending) return;
    if (authDisabled) {
      syncAnalyticsUser(null);
      return;
    }
    syncAnalyticsUser(
      user
        ? {
            id: user.id,
            email: user.email,
            name: user.name,
          }
        : null,
    );
  }, [authDisabled, pending, user]);

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
      if (authDisabled || user) return true;
      pendingAction.current = action ?? null;
      setClosing(false);
      setOpen(true);
      return false;
    },
    [authDisabled, user],
  );

  const withAuth = useCallback(
    <A extends unknown[]>(fn: (...args: A) => void) =>
      (...args: A) => {
        if (!requireAuth(() => fn(...args))) return;
        fn(...args);
      },
    [requireAuth],
  );

  // MCP OAuth bounce-back: the server-rendered /authorize consent page redirects
  // an unauthenticated user here with ?mcpAuthorize=<path>. Once signed in, send
  // them back to finish the connect flow. Guarded to our own /authorize path so
  // it can't be used as an open redirect.
  useEffect(() => {
    if (pending) return;
    const next = new URLSearchParams(window.location.search).get("mcpAuthorize");
    if (!next || !next.startsWith("/authorize")) return;
    if (user) window.location.replace(next);
    else requireAuth();
  }, [pending, user, requireAuth]);

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

  if (apiUnreachable) {
    return (
      <ApiUnreachable onRetry={() => setConfigAttempt((n) => n + 1)} />
    );
  }

  // Signed in but email not verified (and the deployment requires it): gate the
  // whole app behind the verification screen until they enter the code.
  if (!pending && !authDisabled && requireVerify && user && !user.emailVerified) {
    return <EmailVerify email={user.email} />;
  }

  return (
    <Ctx.Provider
      value={{
        user,
        pending,
        authDisabled,
        managed,
        maxSpaces,
        remoteMcp,
        billingSpaceId,
        openBilling,
        closeBilling,
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
