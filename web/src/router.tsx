import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  useNavigate,
  useParams,
} from "@tanstack/react-router";
import { App } from "./App";
import { AuthForm } from "./AuthForm";
import { LanguageSwitcher } from "./LanguageSwitcher";
import { LegalLinks } from "./LegalLinks";
import { AuthProvider, useAuth } from "./authContext";
import { useSpaces } from "./queries";
import { setSpace, getLastSpace } from "./space";
import { BillingPage, BillingModal } from "./BillingPage";
import { LegalPage } from "./LegalPage";
import { MonitoringPage } from "./MonitoringPage";

// Billing overlay lives ABOVE the route Outlet so opening it never unmounts the
// builder (App) underneath — chat, run and the open flow keep going.
function BillingOverlay() {
  const { billingSpaceId, closeBilling } = useAuth();
  if (!billingSpaceId) return null;
  return <BillingModal spaceId={billingSpaceId} onClose={closeBilling} />;
}

function RootLayout() {
  return (
    <AuthProvider>
      <Outlet />
      <BillingOverlay />
    </AuthProvider>
  );
}

function Loader() {
  const { t } = useTranslation();
  return (
    <div className="flex h-screen w-screen items-center justify-center bg-background text-sm text-muted-foreground">
      {t("common.loadingPage")}
    </div>
  );
}

function IndexPage() {
  const { user, pending } = useAuth();
  const navigate = useNavigate();
  const { data: spaces } = useSpaces();

  useEffect(() => {
    if (user && spaces && spaces.length > 0) {
      // Restore the space the user was last in (if it still exists), so a fresh
      // login / landing on the root doesn't snap them to the first-created space
      // — which may not be the one holding their connections and workflows.
      const last = getLastSpace();
      const target = spaces.some((s) => s.id === last) ? last : spaces[0].id;
      void navigate({
        to: "/s/$spaceId",
        params: { spaceId: target },
        replace: true,
      });
    }
  }, [user, spaces, navigate]);

  if (pending || user) return <Loader />;
  return <App key="anon" spaceId="" routeWorkflowId={null} />;
}

function LoginPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  useEffect(() => {
    if (user) void navigate({ to: "/", replace: true });
  }, [user, navigate]);
  return (
    <div className="flex h-screen w-screen flex-col bg-background text-foreground">
      <div className="p-2 pb-0">
        <header className="flex items-center gap-3 rounded-2xl border border-border/40 bg-muted/40 px-4 py-2">
          <div className="ml-auto flex items-center gap-3">
            <LegalLinks />
            <LanguageSwitcher />
          </div>
        </header>
      </div>
      <div className="flex flex-1 items-center justify-center p-4">
        <div className="w-full max-w-sm rounded-2xl border border-border/50 bg-card p-6">
          <AuthForm showLegalLinks={false} />
        </div>
      </div>
    </div>
  );
}

function BuilderPage() {
  const params = useParams({ strict: false }) as {
    spaceId?: string;
    workflowId?: string;
  };
  const spaceId = params.spaceId ?? "";
  return (
    <App
      key={spaceId}
      spaceId={spaceId}
      routeWorkflowId={params.workflowId ?? null}
    />
  );
}

const rootRoute = createRootRoute({ component: RootLayout });

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  loader: () => setSpace(""),
  component: IndexPage,
});

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login",
  component: LoginPage,
});

const spaceRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/s/$spaceId",
  loader: ({ params }) => setSpace(params.spaceId),
  component: BuilderPage,
});

const workflowRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/s/$spaceId/w/$workflowId",
  loader: ({ params }) => setSpace(params.spaceId),
  component: BuilderPage,
});

const billingRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/s/$spaceId/billing",
  loader: ({ params }) => setSpace(params.spaceId),
  component: BillingPage,
});

const monitorRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/s/$spaceId/w/$workflowId/monitor",
  loader: ({ params }) => setSpace(params.spaceId),
  component: MonitoringPage,
});

const termsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/terms",
  loader: () => setSpace(""),
  component: () => <LegalPage kind="terms" />,
});

const privacyRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/privacy",
  loader: () => setSpace(""),
  component: () => <LegalPage kind="privacy" />,
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  loginRoute,
  spaceRoute,
  workflowRoute,
  billingRoute,
  monitorRoute,
  termsRoute,
  privacyRoute,
]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
