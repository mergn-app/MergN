import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Sun, Moon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { MergNLogo } from "@/components/MergNLogo";
import { LanguageSwitcher } from "./LanguageSwitcher";
import { BuilderMockShowcase } from "./BuilderMockShowcase";
import { LandingDifferentiators } from "./LandingDifferentiators";
import { LandingUseCases } from "./LandingUseCases";
import { SelfHealShowcase } from "./SelfHealShowcase";
import { AuthForm } from "./AuthForm";
import { EnterpriseDialog } from "./EnterpriseDialog";

export function Landing() {
  const { t } = useTranslation();
  const [theme, setTheme] = useState<"dark" | "light">(() =>
    typeof document !== "undefined" &&
    document.documentElement.classList.contains("dark")
      ? "dark"
      : "light",
  );
  const [authOpen, setAuthOpen] = useState(false);
  const [authMode, setAuthMode] = useState<"signin" | "signup">("signin");
  const [contactOpen, setContactOpen] = useState(false);
  const glowMoveRaf = useRef<number | null>(null);
  const [communityGlow, setCommunityGlow] = useState({
    x: 50,
    y: 50,
    active: false,
  });

  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
    try {
      localStorage.setItem("theme", theme);
    } catch {
      void 0;
    }
  }, [theme]);

  useEffect(
    () => () => {
      if (glowMoveRaf.current != null) cancelAnimationFrame(glowMoveRaf.current);
    },
    [],
  );

  const openAuth = (mode: "signin" | "signup") => {
    setAuthMode(mode);
    setAuthOpen(true);
  };

  return (
    <div className="flex min-h-screen w-full flex-col overflow-x-hidden overflow-y-auto bg-background text-foreground">
      <section className="flex flex-col lg:h-screen lg:min-h-screen">
        <div className="p-2 pb-0">
          <header className="flex items-center gap-3 rounded-2xl border border-border/40 bg-muted/40 px-2 py-2">
          <div className="flex items-center gap-2">
            <MergNLogo className="h-5  w-auto text-foreground" />
            <div className="text-sm font-semibold">MergN</div>
          </div>
          <div className="ml-auto flex items-center gap-3">
            <LanguageSwitcher />
            <Button
              size="icon"
              variant="ghost"
              className="h-8 w-8"
              title={
                theme === "dark"
                  ? t("header.switchToLight")
                  : t("header.switchToDark")
              }
              onClick={() =>
                setTheme((prev) => (prev === "dark" ? "light" : "dark"))
              }
            >
              {theme === "dark" ? (
                <Sun className="h-4 w-4" />
              ) : (
                <Moon className="h-4 w-4" />
              )}
            </Button>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => openAuth("signin")}
            >
              {t("auth.signIn")}
            </Button>
            <Button size="sm" onClick={() => openAuth("signup")}>
              {t("auth.createAccount")}
            </Button>
          </div>
          </header>
        </div>
        <div className="flex min-h-0 flex-1 flex-col items-center gap-6 p-6 pb-6">
          <div className="w-full max-w-4xl text-center mt-1">
            <h1 className="text-3xl font-semibold tracking-tight">
              {t("landing.heroTitle")}
            </h1>
            <p className="mx-auto mt-3 max-w-2xl text-sm leading-relaxed text-muted-foreground">
              {t("landing.heroSubtitle")}
            </p>
            <div className="mt-5 flex items-center justify-center gap-3">
              <Button onClick={() => openAuth("signin")}>{t("auth.signIn")}</Button>
              <Button asChild variant="outline">
                <a
                  href="https://discord.gg/wDxHFkcbhD"
                  target="_blank"
                  rel="noreferrer"
                >
                  {t("landing.joinDiscord")}
                </a>
              </Button>
              <Button asChild variant="outline">
                <a
                  href="https://github.com/mergn-app/mergn"
                  target="_blank"
                  rel="noreferrer"
                >
                  {t("landing.starGithub")}
                </a>
              </Button>
            </div>
          </div>
          <div className="w-full max-w-6xl min-h-0 flex-1">
            <BuilderMockShowcase />
          </div>
        </div>
      </section>

      <div className="px-10 pb-16 pt-4">
        <LandingDifferentiators />

        <div className="mx-auto mt-14 w-full max-w-6xl">
          <div className="text-center">
            <h2 className="text-xl font-semibold tracking-tight">
              {t("landing.selfHeal.title")}
            </h2>
            <p className="mx-auto mt-2 max-w-xl text-sm leading-relaxed text-muted-foreground">
              {t("landing.selfHeal.subtitle")}
            </p>
          </div>
          <div className="mt-6">
            <SelfHealShowcase />
          </div>
        </div>

        <div className="mt-14">
          <LandingUseCases onUseCaseClick={() => openAuth("signup")} />
        </div>

        <div
          className="relative mx-auto mt-8 w-full max-w-6xl overflow-hidden rounded-3xl bg-[#f6efe3] px-8 py-10 text-center transition-colors duration-300 dark:bg-zinc-800/90"
          onMouseEnter={() =>
            setCommunityGlow((prev) => ({
              ...prev,
              active: true,
            }))
          }
          onMouseLeave={() => {
            if (glowMoveRaf.current != null) {
              cancelAnimationFrame(glowMoveRaf.current);
              glowMoveRaf.current = null;
            }
            setCommunityGlow((prev) => ({
              ...prev,
              active: false,
            }));
          }}
          onMouseMove={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            const x = ((e.clientX - rect.left) / rect.width) * 100;
            const y = ((e.clientY - rect.top) / rect.height) * 100;
            const nx = Math.min(100, Math.max(0, x));
            const ny = Math.min(100, Math.max(0, y));
            if (glowMoveRaf.current != null) return;
            glowMoveRaf.current = requestAnimationFrame(() => {
              setCommunityGlow({
                x: nx,
                y: ny,
                active: true,
              });
              glowMoveRaf.current = null;
            });
          }}
        >
          <div
            className="pointer-events-none absolute inset-0 transition-opacity duration-150"
            style={{
              opacity: communityGlow.active ? 1 : 0,
              background:
                theme === "dark"
                  ? `radial-gradient(220px circle at ${communityGlow.x}% ${communityGlow.y}%, rgba(113,113,122,0.2), rgba(113,113,122,0) 64%), radial-gradient(120px circle at calc(${communityGlow.x}% + 5%) calc(${communityGlow.y}% - 4%), rgba(82,82,91,0.12), rgba(82,82,91,0) 72%)`
                  : `radial-gradient(220px circle at ${communityGlow.x}% ${communityGlow.y}%, rgba(255,243,212,0.9), rgba(255,243,212,0) 64%), radial-gradient(120px circle at calc(${communityGlow.x}% + 5%) calc(${communityGlow.y}% - 4%), rgba(255,255,255,0.5), rgba(255,255,255,0) 72%)`,
            }}
          />
          <div
            className="pointer-events-none absolute inset-0 blur-md transition-opacity duration-200"
            style={{
              opacity: communityGlow.active ? 0.4 : 0,
              background: `radial-gradient(260px circle at ${communityGlow.x}% ${communityGlow.y}%, ${
                theme === "dark" ? "rgba(63,63,70,0.26)" : "rgba(255,246,224,0.58)"
              }, rgba(255,255,255,0) 70%)`,
            }}
          />
          <div className="relative z-10">
          <p className="text-xs font-medium uppercase tracking-[0.2em] text-foreground/60">
            {t("landing.community.badge")}
          </p>
          <h3 className="mt-3 text-3xl font-semibold tracking-tight text-foreground md:text-4xl">
            {t("landing.community.title")}
          </h3>
          <p className="mx-auto mt-3 max-w-2xl text-sm leading-relaxed text-foreground/75">
            {t("landing.community.desc")}
          </p>
          <div className="mt-6 flex items-center justify-center gap-3">
            <Button size="sm" onClick={() => openAuth("signup")}>
              {t("landing.community.joinNow")}
            </Button>
            <Button asChild size="sm" variant="ghost">
              <a
                href="https://discord.gg/wDxHFkcbhD"
                target="_blank"
                rel="noreferrer"
              >
                {t("landing.community.joinDiscord")}
              </a>
            </Button>
            <Button asChild size="sm" variant="ghost">
              <a
                href="https://github.com/mergn-app/mergn"
                target="_blank"
                rel="noreferrer"
              >
                {t("landing.community.starGithub")}
              </a>
            </Button>
          </div>
          </div>
        </div>
      </div>

      <footer className="border-t border-border/40 px-4 py-3">
        <div className="mx-auto flex w-full max-w-6xl items-center">
          <div className="flex items-center gap-2">
            <MergNLogo className="h-4 w-auto text-foreground" />
            <span className="text-xs font-medium text-foreground/80">MergN</span>
          </div>
          <div className="ml-auto flex items-center gap-1">
            <Button
              asChild
              size="sm"
              variant="ghost"
              className="h-8 px-2 text-xs text-muted-foreground"
            >
              <a href="/terms" target="_blank" rel="noreferrer">
                {t("header.termsOfService")}
              </a>
            </Button>
            <Button
              asChild
              size="sm"
              variant="ghost"
              className="h-8 px-2 text-xs text-muted-foreground"
            >
              <a href="/privacy" target="_blank" rel="noreferrer">
                {t("header.privacyPolicy")}
              </a>
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-8 px-2 text-xs text-muted-foreground"
              onClick={() => setContactOpen(true)}
            >
              {t("landing.contactUs")}
            </Button>
          </div>
        </div>
      </footer>

      {contactOpen && (
        <EnterpriseDialog
          title="Talk to us"
          description="Found a bug or have an idea to make the product better? Send it our way — we read every message."
          onClose={() => setContactOpen(false)}
        />
      )}

      <Dialog open={authOpen} onOpenChange={setAuthOpen}>
          <DialogContent>
            <DialogTitle className="sr-only">Authentication</DialogTitle>
            <AuthForm
              key={authMode}
              showLegalLinks={false}
              initialMode={authMode}
            />
          </DialogContent>
      </Dialog>
    </div>
  );
}
