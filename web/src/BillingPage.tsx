import { useState, useEffect } from "react";
import { createPortal } from "react-dom";
import { useParams, useNavigate } from "@tanstack/react-router";
import {
  X,
  Loader2,
  CreditCard,
  Sparkles,
  Download,
  ExternalLink,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  useSubscription,
  useInvoices,
  openBillingPortal,
  type Invoice,
} from "./billing";
import { useAuth } from "./authContext";
import { EnterpriseDialog } from "./EnterpriseDialog";

function fmtAmount(cents: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: currency.toUpperCase(),
    }).format(cents / 100);
  } catch {
    return `$${(cents / 100).toFixed(2)}`;
  }
}

function fmtTs(ts: number): string {
  return new Date(ts * 1000).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

const INV_STATUS: Record<string, string> = {
  paid: "text-emerald-500",
  open: "text-amber-500",
  uncollectible: "text-rose-500",
};

function InvoicesSection({ spaceId }: { spaceId: string }) {
  const { data, isLoading } = useInvoices(spaceId);
  const invoices = (data ?? []).filter(
    (i) => i.status !== "draft" && i.status !== "void",
  );
  if (isLoading || invoices.length === 0) return null;

  return (
    <div className="mt-6">
      <h2 className="mb-2 px-1 text-xs font-medium tracking-wide text-muted-foreground">
        INVOICES
      </h2>
      <div className="divide-y divide-border/40 overflow-hidden rounded-2xl border border-border/50 bg-card">
        {invoices.map((inv: Invoice) => {
          const unpaid = inv.status === "open" || inv.status === "uncollectible";
          return (
            <div key={inv.id} className="flex items-center gap-3 px-4 py-3">
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium">
                  {fmtAmount(inv.amount, inv.currency)}
                </div>
                <div className="truncate text-xs text-muted-foreground">
                  {inv.number ?? inv.id} ·{" "}
                  {fmtTs(inv.paid_at || inv.period_start)}
                </div>
              </div>
              <span
                className={cn(
                  "text-xs font-medium capitalize",
                  INV_STATUS[inv.status ?? ""] ?? "text-muted-foreground",
                )}
              >
                {inv.status}
              </span>
              {unpaid && inv.hosted_url ? (
                <a
                  href={inv.hosted_url}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center gap-1 rounded-lg bg-amber-500/15 px-2.5 py-1 text-xs font-medium text-amber-500 hover:bg-amber-500/25"
                >
                  Pay <ExternalLink className="size-3" />
                </a>
              ) : inv.invoice_pdf ? (
                <a
                  href={inv.invoice_pdf}
                  target="_blank"
                  rel="noreferrer"
                  title="Download invoice"
                  className="rounded-lg p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                  <Download className="size-4" />
                </a>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function fmtDate(iso: string | null): string {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      day: "numeric",
      month: "short",
      year: "numeric",
    });
  } catch {
    return "";
  }
}

const STATUS: Record<string, { label: string; cls: string }> = {
  active: { label: "Active", cls: "bg-emerald-500/15 text-emerald-500" },
  trialing: { label: "Trial", cls: "bg-blue-500/15 text-blue-500" },
  past_due: { label: "Past due", cls: "bg-amber-500/15 text-amber-500" },
  free: { label: "Active", cls: "bg-muted text-muted-foreground" },
};

// Billing rendered as a modal OVERLAY (via authContext.openBilling) so it never
// unmounts the builder underneath — the open flow, chat stream and run keep
// going. Closing it just dismisses the overlay; the URL/flow are untouched.
export function BillingModal({
  spaceId,
  onClose,
}: {
  spaceId: string;
  onClose: () => void;
}) {
  const { managed } = useAuth();
  const { data: sub, isLoading } = useSubscription(spaceId);
  const [managing, setManaging] = useState(false);
  const [enterprise, setEnterprise] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  if (managed !== true) return null;

  const manage = async () => {
    if (!spaceId) return;
    setManaging(true);
    try {
      await openBillingPortal(spaceId);
    } catch {
      setManaging(false);
    }
  };

  // usage bar (whichever limit applies)
  const bar = (() => {
    if (!sub) return null;
    const { limits, usage } = sub;
    if (limits.chats_limit >= 0)
      return {
        used: usage.chats,
        total: limits.chats_limit,
        label: `${usage.chats} of ${limits.chats_limit} chats this month`,
      };
    if (limits.ai_tokens_limit >= 0)
      return {
        used: usage.ai_tokens,
        total: limits.ai_tokens_limit,
        label: `${(usage.ai_tokens / 1_000_000).toFixed(2)}M of ${(
          limits.ai_tokens_limit / 1_000_000
        ).toFixed(0)}M AI tokens this month`,
      };
    return null;
  })();

  const status = sub ? (STATUS[sub.status] ?? STATUS.free) : STATUS.free;
  const pct = bar ? Math.min(100, Math.round((bar.used / bar.total) * 100)) : 0;

  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-start justify-center overflow-y-auto bg-black/50 p-4 py-12"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-start justify-between">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">Billing</h1>
            <p className="text-sm text-muted-foreground">Your plan and usage.</p>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            title="Close"
          >
            <X className="size-4" />
          </button>
        </div>

        {isLoading || !sub ? (
          <div className="flex h-48 items-center justify-center rounded-2xl border border-border/50">
            <Loader2 className="size-5 animate-spin text-muted-foreground/70" />
          </div>
        ) : (
          <div className="overflow-hidden rounded-2xl border border-border/50 bg-card">
            {/* header */}
            <div className="flex items-center justify-between gap-3 border-b border-border/40 bg-muted/30 px-5 py-4">
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-lg font-semibold">{sub.plan_name}</span>
                  <span
                    className={cn(
                      "rounded-full px-2 py-0.5 text-[11px] font-medium",
                      status.cls,
                    )}
                  >
                    {status.label}
                  </span>
                </div>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {sub.plan_description}
                </p>
              </div>
              <div className="shrink-0 text-right">
                {sub.price_monthly != null && (
                  <div className="text-lg font-semibold">
                    ${sub.price_monthly}
                    <span className="text-xs font-normal text-muted-foreground">
                      /mo
                    </span>
                  </div>
                )}
              </div>
            </div>

            {/* body */}
            <div className="space-y-4 px-5 py-4">
              {bar && (
                <div>
                  <div className="mb-1.5 flex items-center justify-between text-xs text-muted-foreground">
                    <span>{bar.label}</span>
                    <span className="font-medium text-foreground">{pct}%</span>
                  </div>
                  <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                    <div
                      className={cn(
                        "h-full rounded-full transition-all",
                        pct >= 100 ? "bg-rose-500" : "bg-primary",
                      )}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                </div>
              )}

              {sub.current_period_end && (
                <p className="text-xs text-muted-foreground">
                  {sub.cancel_at_period_end ? "Ends on " : "Renews on "}
                  <span className="text-foreground">
                    {fmtDate(sub.current_period_end)}
                  </span>
                </p>
              )}

              <button
                onClick={manage}
                disabled={managing || !sub.billing_enabled}
                className="flex w-full items-center justify-center gap-2 rounded-xl bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {managing ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <CreditCard className="size-4" />
                )}
                {sub.plan_slug === "free" ? "Upgrade plan" : "Manage subscription"}
              </button>
              {!sub.billing_enabled && (
                <p className="text-center text-[11px] text-muted-foreground">
                  Billing isn't configured on this deployment.
                </p>
              )}
            </div>
          </div>
        )}

        {sub && <InvoicesSection spaceId={spaceId} />}

        <button
          onClick={() => setEnterprise(true)}
          className="mx-auto mt-6 flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          <Sparkles className="size-3.5" />
          Need higher limits? Talk to us about Enterprise
        </button>
      </div>

      {enterprise && <EnterpriseDialog onClose={() => setEnterprise(false)} />}
    </div>,
    document.body,
  );
}

// Thin route component kept for deep links and the Stripe portal return URL
// (APP_URL/s/<id>/billing). It opens the billing overlay on top of the builder
// rather than rendering a bare page, then drops the user back on the workspace.
export function BillingPage() {
  const { spaceId } = useParams({ strict: false }) as { spaceId?: string };
  const navigate = useNavigate();
  const { openBilling } = useAuth();
  useEffect(() => {
    if (spaceId) {
      openBilling(spaceId);
      void navigate({ to: "/s/$spaceId", params: { spaceId }, replace: true });
    } else {
      void navigate({ to: "/", replace: true });
    }
  }, [spaceId, openBilling, navigate]);
  return null;
}
