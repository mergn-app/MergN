import Stripe from "stripe";
import type { DocStore } from "../store/docstore";
import {
  PLANS,
  DEFAULT_PLAN_SLUG,
  getPlan,
  planStripePriceId,
  planForStripePriceId,
  type Plan,
} from "./plans";

const SYS = "__sys";
const COLLECTION = "billing";

export interface BillingRecord {
  spaceId: string;
  planSlug: string;
  stripeCustomerId?: string;
  stripeSubscriptionId?: string;
  subscriptionStatus?: string; // active | trialing | past_due | canceled | free
  currentPeriodEnd?: string;
  cancelAtPeriodEnd?: boolean;
  updatedAt: string;
}

export interface SubscriptionView {
  plan_slug: string;
  plan_name: string;
  plan_description: string;
  price_monthly: number | null;
  currency: string;
  status: string;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
  limits: { chats_limit: number; ai_tokens_limit: number };
}

export interface InvoiceView {
  id: string;
  number: string | null;
  status: string | null;
  amount: number;
  currency: string;
  period_start: number;
  period_end: number;
  paid_at: number | null;
  invoice_pdf: string | null;
  hosted_url: string | null;
}

export interface BillingService {
  enabled(): boolean;
  getOrInit(
    spaceId: string,
    owner?: { email?: string; name?: string },
  ): Promise<BillingRecord>;
  getSubscription(
    spaceId: string,
    owner?: { email?: string; name?: string },
  ): Promise<SubscriptionView>;
  createPortalSession(spaceId: string, returnUrl: string): Promise<string>;
  getInvoices(spaceId: string): Promise<InvoiceView[]>;
  handleWebhook(payload: string | Buffer, signature: string): Promise<void>;
  planOf(spaceId: string): Promise<Plan>;
}

export interface BillingDeps {
  // Called when a subscription's billing cycle renews (invoice paid) so usage
  // counters can be reset on the billing day rather than the calendar month.
  onRenewal?: (spaceId: string) => Promise<void>;
}

export function createBilling(
  store: DocStore,
  deps: BillingDeps = {},
): BillingService {
  const key = process.env.STRIPE_SECRET_KEY;
  const stripe = key ? new Stripe(key) : null;
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET || "";

  async function get(spaceId: string): Promise<BillingRecord | null> {
    return (await store.get(SYS, COLLECTION, spaceId)) as unknown as
      | BillingRecord
      | null;
  }

  async function save(rec: BillingRecord): Promise<BillingRecord> {
    rec.updatedAt = new Date().toISOString();
    await store.put(
      SYS,
      COLLECTION,
      rec.spaceId,
      rec as unknown as Record<string, unknown>,
    );
    return rec;
  }

  // Map a Stripe subscription onto our record (plan from its price id + status).
  function applySubscription(rec: BillingRecord, sub: Stripe.Subscription) {
    const priceId = sub.items.data[0]?.price?.id;
    const plan = priceId ? planForStripePriceId(priceId) : undefined;
    rec.planSlug = plan?.slug ?? rec.planSlug ?? DEFAULT_PLAN_SLUG;
    rec.stripeSubscriptionId = sub.id;
    rec.subscriptionStatus = sub.status;
    rec.cancelAtPeriodEnd = sub.cancel_at_period_end;
    const periodEnd = (sub as unknown as { current_period_end?: number })
      .current_period_end;
    rec.currentPeriodEnd = periodEnd
      ? new Date(periodEnd * 1000).toISOString()
      : undefined;
  }

  async function findByCustomer(
    customerId: string,
  ): Promise<BillingRecord | null> {
    const all = (await store.list(SYS, COLLECTION)) as unknown as BillingRecord[];
    return all.find((r) => r.stripeCustomerId === customerId) ?? null;
  }

  return {
    enabled() {
      return Boolean(stripe);
    },

    async getOrInit(spaceId, owner) {
      const existing = await get(spaceId);
      if (existing) return existing;

      const rec: BillingRecord = {
        spaceId,
        planSlug: DEFAULT_PLAN_SLUG,
        subscriptionStatus: "free",
        updatedAt: new Date().toISOString(),
      };

      // Auto-provision a Stripe customer + free subscription when Stripe is
      // configured (and a free price exists). Otherwise this is a local-only
      // free record (self-host / before keys are set).
      const freePlan = getPlan("free");
      const freePrice = planStripePriceId(freePlan);
      if (stripe && freePrice) {
        try {
          const customer = await stripe.customers.create({
            email: owner?.email,
            name: owner?.name,
            metadata: { spaceId },
          });
          rec.stripeCustomerId = customer.id;
          const sub = await stripe.subscriptions.create({
            customer: customer.id,
            items: [{ price: freePrice }],
            metadata: { spaceId },
          });
          applySubscription(rec, sub);
        } catch {
          // fall back to local free record if Stripe provisioning fails
        }
      }
      return save(rec);
    },

    async getSubscription(spaceId, owner) {
      const rec = await this.getOrInit(spaceId, owner);
      const plan = getPlan(rec.planSlug);
      return {
        plan_slug: plan.slug,
        plan_name: plan.name,
        plan_description: plan.description,
        price_monthly: plan.priceMonthly,
        currency: plan.currency,
        status: rec.subscriptionStatus ?? "free",
        current_period_end: rec.currentPeriodEnd ?? null,
        cancel_at_period_end: rec.cancelAtPeriodEnd ?? false,
        limits: {
          chats_limit: plan.limits.chats,
          ai_tokens_limit: plan.limits.aiTokens,
        },
      };
    },

    async createPortalSession(spaceId, returnUrl) {
      if (!stripe) throw new Error("billing not configured");
      const rec = await this.getOrInit(spaceId);
      if (!rec.stripeCustomerId)
        throw new Error("no stripe customer for this space");
      const session = await stripe.billingPortal.sessions.create({
        customer: rec.stripeCustomerId,
        return_url: returnUrl,
      });
      return session.url;
    },

    async getInvoices(spaceId) {
      if (!stripe) return [];
      const rec = await get(spaceId);
      if (!rec?.stripeCustomerId) return [];
      const list = await stripe.invoices.list({
        customer: rec.stripeCustomerId,
        limit: 24,
      });
      return list.data.map((inv) => ({
        id: inv.id ?? "",
        number: inv.number ?? null,
        status: inv.status ?? null,
        // the invoice total (what it's for), not amount_paid — proration can put
        // the charge on the account balance so amount_paid is 0 until next cycle
        amount: inv.total ?? inv.amount_due ?? 0,
        currency: inv.currency ?? "usd",
        period_start: inv.period_start ?? 0,
        period_end: inv.period_end ?? 0,
        paid_at: inv.status_transitions?.paid_at ?? null,
        invoice_pdf: inv.invoice_pdf ?? null,
        hosted_url: inv.hosted_invoice_url ?? null,
      }));
    },

    async handleWebhook(payload, signature) {
      if (!stripe || !webhookSecret) return;
      const event = stripe.webhooks.constructEvent(
        payload,
        signature,
        webhookSecret,
      );
      switch (event.type) {
        case "customer.subscription.updated":
        case "customer.subscription.created": {
          const sub = event.data.object as Stripe.Subscription;
          const rec = await findByCustomer(
            typeof sub.customer === "string" ? sub.customer : sub.customer.id,
          );
          if (rec) {
            applySubscription(rec, sub);
            await save(rec);
          }
          break;
        }
        case "customer.subscription.deleted": {
          const sub = event.data.object as Stripe.Subscription;
          const rec = await findByCustomer(
            typeof sub.customer === "string" ? sub.customer : sub.customer.id,
          );
          if (rec) {
            rec.planSlug = DEFAULT_PLAN_SLUG;
            rec.subscriptionStatus = "free";
            rec.stripeSubscriptionId = undefined;
            rec.cancelAtPeriodEnd = false;
            await save(rec);
          }
          break;
        }
        case "invoice.payment_failed": {
          const inv = event.data.object as Stripe.Invoice;
          const customerId =
            typeof inv.customer === "string"
              ? inv.customer
              : inv.customer?.id;
          if (customerId) {
            const rec = await findByCustomer(customerId);
            if (rec) {
              rec.subscriptionStatus = "past_due";
              await save(rec);
            }
          }
          break;
        }
        case "invoice.paid":
        case "invoice.payment_succeeded": {
          const inv = event.data.object as Stripe.Invoice;
          const customerId =
            typeof inv.customer === "string" ? inv.customer : inv.customer?.id;
          if (customerId) {
            const rec = await findByCustomer(customerId);
            if (rec) {
              rec.subscriptionStatus = "active";
              await save(rec);
              // Reset usage when the period rolls over (renewal). New subs and
              // upgrades start fresh too — billing_reason covers all three.
              if (
                deps.onRenewal &&
                (inv.billing_reason === "subscription_cycle" ||
                  inv.billing_reason === "subscription_create" ||
                  inv.billing_reason === "subscription_update")
              )
                await deps.onRenewal(rec.spaceId);
            }
          }
          break;
        }
        default:
          break;
      }
    },

    async planOf(spaceId) {
      const rec = await this.getOrInit(spaceId);
      return getPlan(rec.planSlug);
    },
  };
}

export { PLANS };
