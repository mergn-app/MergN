import { useTranslation } from "react-i18next";
import { Code2, FileCode, ShieldCheck, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

const PILLARS: { id: "generated" | "visible" | "resilient"; icon: LucideIcon; tone: string }[] = [
  { id: "generated", icon: Code2, tone: "bg-tone-blue/12 text-tone-blue-fg" },
  { id: "visible", icon: FileCode, tone: "bg-tone-emerald/12 text-tone-emerald-fg" },
  { id: "resilient", icon: ShieldCheck, tone: "bg-tone-amber/12 text-tone-amber-fg" },
];

export function LandingDifferentiators() {
  const { t } = useTranslation();

  return (
    <section className="mx-auto w-full max-w-6xl">
      <div className="text-center">
        <h2 className="text-xl font-semibold tracking-tight">
          {t("landing.differentiators.title")}
        </h2>
        <p className="mx-auto mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">
          {t("landing.differentiators.subtitle")}
        </p>
      </div>
      <div className="mt-6 grid gap-4 md:grid-cols-3">
        {PILLARS.map(({ id, icon: Icon, tone }) => (
          <div
            key={id}
            className="rounded-2xl border border-border/50 bg-card p-5"
          >
            <div
              className={cn(
                "flex h-9 w-9 items-center justify-center rounded-xl",
                tone,
              )}
            >
              <Icon className="h-4 w-4" />
            </div>
            <h3 className="mt-4 text-sm font-medium text-foreground">
              {t(`landing.differentiators.${id}.title`)}
            </h3>
            <p className="mt-1.5 text-[13px] leading-relaxed text-muted-foreground">
              {t(`landing.differentiators.${id}.desc`)}
            </p>
          </div>
        ))}
      </div>
    </section>
  );
}
