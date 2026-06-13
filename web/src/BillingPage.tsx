import { useState } from "react";
import { useParams, useNavigate } from "@tanstack/react-router";
import { ArrowLeft, Loader2, CreditCard, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import { useSubscription, openBillingPortal } from "./billing";
import { EnterpriseDialog } from "./EnterpriseDialog";

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

export function BillingPage() {
  const { spaceId } = useParams({ strict: false }) as { spaceId?: string };
  const navigate = useNavigate();
  const { data: sub, isLoading } = useSubscription(spaceId ?? "");
  const [managing, setManaging] = useState(false);
  const [enterprise, setEnterprise] = useState(false);

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

  return (
    <div className="flex min-h-screen w-full justify-center bg-background px-4 py-12 text-foreground">
      <div className="w-full max-w-md">
        <button
          onClick={() =>
            void navigate({
              to: "/s/$spaceId",
              params: { spaceId: spaceId ?? "" },
            })
          }
          className="mb-8 flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="size-4" />
          Back to workspace
        </button>

        <h1 className="mb-1 text-xl font-semibold tracking-tight">Billing</h1>
        <p className="mb-6 text-sm text-muted-foreground">
          Your plan and usage.
        </p>

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

        <button
          onClick={() => setEnterprise(true)}
          className="mx-auto mt-6 flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          <Sparkles className="size-3.5" />
          Need higher limits? Talk to us about Enterprise
        </button>
      </div>

      {enterprise && <EnterpriseDialog onClose={() => setEnterprise(false)} />}
    </div>
  );
}
