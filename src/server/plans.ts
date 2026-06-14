// Pricing plans. Kept in code (not a DB table) — they change rarely and the
// Stripe price ids come from env so the same code runs in test and prod.
// Limit convention: -1 = unlimited. The numeric quotas come from the single
// limits config (src/limits.ts) — edit them there or via env, not here.

import { LIMITS } from "../limits";

export interface PlanLimits {
  chats: number; // chat conversations / month (-1 = unlimited)
  aiTokens: number; // AI tokens / month (-1 = unlimited)
}

export interface Plan {
  slug: string;
  name: string;
  description: string;
  priceMonthly: number | null; // null = "contact us"
  currency: string;
  limits: PlanLimits;
  features: string[];
  // env var holding the Stripe price id for this plan (empty = no Stripe price)
  stripePriceEnv: string;
}

export const PLANS: Plan[] = [
  {
    slug: "free",
    name: "Free",
    description: "Get started building workflows with AI.",
    priceMonthly: 0,
    currency: "usd",
    // Free is bounded by 10 chats AND 1M tokens — whichever is hit first blocks.
    limits: {
      chats: LIMITS.freeChats,
      aiTokens: LIMITS.freeTokens,
    },
    features: [
      "10 AI chats / month",
      "1M AI tokens / month",
      "Run workflows",
      "Community support",
    ],
    stripePriceEnv: "STRIPE_PRICE_FREE",
  },
  {
    slug: "pro",
    name: "Pro",
    description: "For builders who ship workflows every day.",
    priceMonthly: 19,
    currency: "usd",
    limits: {
      chats: -1,
      aiTokens: LIMITS.proTokens,
    },
    features: [
      "Unlimited AI chats",
      "5M AI tokens / month",
      "Run workflows",
      "Priority support",
    ],
    stripePriceEnv: "STRIPE_PRICE_PRO",
  },
  {
    // Internal test plan — maps to a cheap test Stripe price. Not advertised; it
    // only exists so the upgrade flow can be exercised with a $0.10 product and
    // shows "Test" (not "Pro") when active.
    slug: "test",
    name: "Test",
    description: "Internal test plan.",
    priceMonthly: 0.1,
    currency: "usd",
    limits: {
      chats: -1,
      aiTokens: LIMITS.proTokens,
    },
    features: ["Test plan"],
    stripePriceEnv: "STRIPE_PRICE_PRO_TEST",
  },
  {
    slug: "enterprise",
    name: "Enterprise",
    description: "Custom limits, SSO, on-prem and a support SLA.",
    priceMonthly: null, // contact us
    currency: "usd",
    limits: { chats: -1, aiTokens: -1 },
    features: ["Everything in Pro", "SSO & on-prem", "Dedicated support / SLA"],
    stripePriceEnv: "",
  },
];

export const DEFAULT_PLAN_SLUG = "free";

export function getPlan(slug: string | undefined): Plan {
  return PLANS.find((p) => p.slug === slug) ?? PLANS[0];
}

export function planStripePriceId(plan: Plan): string | undefined {
  if (!plan.stripePriceEnv) return undefined;
  return process.env[plan.stripePriceEnv] || undefined;
}

export function planForStripePriceId(priceId: string): Plan | undefined {
  return PLANS.find((p) => planStripePriceId(p) === priceId);
}
