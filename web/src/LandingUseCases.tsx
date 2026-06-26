import { useTranslation } from "react-i18next";
import {
  ArrowRight,
  BadgeCheck,
  BellRing,
  CalendarClock,
  CreditCard,
  FileText,
  Mail,
  ShoppingCart,
  UserPlus,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";

type UseCase = {
  id: string;
  icon: LucideIcon;
  from: string;
  to: string;
  tone: string;
};

const USE_CASES: UseCase[] = [
  {
    id: "payments",
    icon: CreditCard,
    from: "Stripe",
    to: "Slack",
    tone: "bg-tone-blue/12 text-tone-blue-fg",
  },
  {
    id: "orders",
    icon: ShoppingCart,
    from: "Shopify",
    to: "Discord",
    tone: "bg-tone-emerald/12 text-tone-emerald-fg",
  },
  {
    id: "leads",
    icon: UserPlus,
    from: "Typeform",
    to: "HubSpot",
    tone: "bg-tone-amber/12 text-tone-amber-fg",
  },
  {
    id: "support",
    icon: Mail,
    from: "Gmail",
    to: "Linear",
    tone: "bg-tone-rose/12 text-tone-rose-fg",
  },
  {
    id: "incidents",
    icon: BellRing,
    from: "Datadog",
    to: "Slack",
    tone: "bg-tone-blue/12 text-tone-blue-fg",
  },
  {
    id: "digests",
    icon: CalendarClock,
    from: "Schedule",
    to: "Notion",
    tone: "bg-tone-emerald/12 text-tone-emerald-fg",
  },
  {
    id: "approvals",
    icon: BadgeCheck,
    from: "Airtable",
    to: "Slack",
    tone: "bg-tone-amber/12 text-tone-amber-fg",
  },
  {
    id: "reports",
    icon: FileText,
    from: "Google Sheets",
    to: "Discord",
    tone: "bg-tone-blue/12 text-tone-blue-fg",
  },
];

export function LandingUseCases({
  onUseCaseClick,
}: {
  onUseCaseClick: () => void;
}) {
  const { t } = useTranslation();
  const LOOP = [...USE_CASES, ...USE_CASES];

  return (
    <section className="w-full ">
      <div className="text-center ">
        <h2 className="text-xl font-semibold tracking-tight">
          {t("landing.useCases.title")}
        </h2>
        <p className="mx-auto mt-2 max-w-xl text-sm leading-relaxed text-muted-foreground">
          {t("landing.useCases.subtitle")}
        </p>
      </div>

      <div className="relative mt-6 flex justify-center ">
        <div className="max-w-6xl ">
        <div className="overflow-hidden py-1">
          <div className="landing-use-cases-track flex w-max gap-4">
            {LOOP.map((uc, idx) => {
              const Icon = uc.icon;
              return (
                <button
                  key={`${uc.id}-${idx}`}
                  type="button"
                  onClick={onUseCaseClick}
                  className="w-72 shrink-0 rounded-2xl border border-border/50 bg-card p-4 text-left transition-colors hover:border-border"
                >
                  <div className="flex items-center gap-2">
                    <div
                      className={cn(
                        "flex h-9 w-9 items-center justify-center rounded-xl",
                        uc.tone,
                      )}
                    >
                      <Icon className="h-4 w-4" />
                    </div>
                    <div className="flex items-center gap-1.5 text-[11px] font-medium">
                      <span className="rounded-md bg-muted px-1.5 py-0.5 text-foreground/80">
                        {uc.from}
                      </span>
                      <ArrowRight className="h-3 w-3 text-muted-foreground" />
                      <span className="rounded-md bg-muted px-1.5 py-0.5 text-foreground/80">
                        {uc.to}
                      </span>
                    </div>
                  </div>
                  <h3 className="mt-3 text-sm font-medium text-foreground">
                    {t(`landing.useCases.items.${uc.id}.title`)}
                  </h3>
                  <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
                    {t(`landing.useCases.items.${uc.id}.desc`)}
                  </p>
                </button>
              );
            })}
          </div>
        </div>
        </div>
      </div>
    </section>
  );
}
