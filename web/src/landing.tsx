import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "@tanstack/react-router";
import { Sun, Moon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { LegalLinks } from "./LegalLinks";
import { LanguageSwitcher } from "./LanguageSwitcher";
import { BuilderMockShowcase } from "./BuilderMockShowcase";

export function Landing() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [theme, setTheme] = useState<"dark" | "light">(() =>
    typeof document !== "undefined" &&
    document.documentElement.classList.contains("dark")
      ? "dark"
      : "light",
  );

  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
    try {
      localStorage.setItem("theme", theme);
    } catch {
      void 0;
    }
  }, [theme]);

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
        </header>
      </div>
      <div className="flex flex-1 flex-col items-center gap-4 p-6">
        <div className="w-full max-w-4xl text-center">
          <h1 className="text-3xl font-semibold tracking-tight">
            Build automations with AI
          </h1>
          <p className="mx-auto mt-3 max-w-2xl text-sm leading-relaxed text-muted-foreground">
            Describe your workflow, connect providers, and run it with full
            visibility. Sign in to access your spaces and workflows.
          </p>
          <div className="mt-5 flex items-center justify-center gap-3">
            <Button onClick={() => void navigate({ to: "/login" })}>
              {t("auth.signIn")}
            </Button>
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
              Learn more
            </Button>
          </div>
        </div>
        <BuilderMockShowcase />
      </div>
    </div>
  );
}
