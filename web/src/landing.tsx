import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Sun, Moon } from "lucide-react";
import * as Dialog from "@radix-ui/react-dialog";
import { Button } from "@/components/ui/button";
import { LegalLinks } from "./LegalLinks";
import { LanguageSwitcher } from "./LanguageSwitcher";
import { BuilderMockShowcase } from "./BuilderMockShowcase";
import { AuthForm } from "./AuthForm";

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

  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
    try {
      localStorage.setItem("theme", theme);
    } catch {
      void 0;
    }
  }, [theme]);

  const openAuth = (mode: "signin" | "signup") => {
    setAuthMode(mode);
    setAuthOpen(true);
  };

  return (
    <div className="flex h-screen w-screen flex-col bg-background text-foreground">
      <div className="p-2 pb-0">
        <header className="flex items-center gap-3 rounded-2xl border border-border/40 bg-muted/40 px-4 py-2">
          <div className="text-sm font-semibold">MergN</div>
          <div className="ml-auto flex items-center gap-3">
            <LegalLinks />
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
      <div className="flex flex-1 flex-col items-center gap-4 p-6">
        <div className="w-full max-w-4xl text-center">
          <h1 className="text-3xl font-semibold tracking-tight">
            {t("landing.heroTitle")}
          </h1>
          <p className="mx-auto mt-3 max-w-2xl text-sm leading-relaxed text-muted-foreground">
            {t("landing.heroSubtitle")}
          </p>
          <div className="mt-5 flex items-center justify-center gap-3">
            <Button onClick={() => openAuth("signin")}>{t("auth.signIn")}</Button>
            <Button
              variant="outline"
              onClick={() =>
                window.open(
                  "https://quollhq.com/",
                  "_blank",
                  "noopener,noreferrer",
                )
              }
            >
              {t("landing.learnMore")}
            </Button>
          </div>
        </div>
        <BuilderMockShowcase />
      </div>

      <Dialog.Root open={authOpen} onOpenChange={setAuthOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-background/70 backdrop-blur-xs data-[state=open]:animate-in data-[state=open]:fade-in data-[state=closed]:animate-out data-[state=closed]:fade-out" />
          <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[92vw] max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-border/50 bg-card p-6 shadow-xl focus:outline-none">
            <Dialog.Title className="sr-only">Authentication</Dialog.Title>
            <AuthForm
              key={authMode}
              showLegalLinks={false}
              initialMode={authMode}
            />
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}
