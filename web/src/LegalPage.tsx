import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAuth } from "./authContext";
import { getLastSpace } from "./space";
import { LEGAL_CONTENT } from "./legal-content";

type LegalKind = "terms" | "privacy";

export function LegalPage({ kind }: { kind: LegalKind }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { managed } = useAuth();
  const { title, sections } = LEGAL_CONTENT[kind];

  const goHome = () => {
    const last = getLastSpace();
    if (last) {
      void navigate({ to: "/s/$spaceId", params: { spaceId: last } });
    } else {
      void navigate({ to: "/" });
    }
  };

  useEffect(() => {
    if (managed === false) void navigate({ to: "/", replace: true });
  }, [managed, navigate]);

  if (managed !== true) return null;

  return (
    <div className="min-h-screen w-full bg-background px-4 py-8 text-foreground">
      <div className="mx-auto max-w-2xl">
        <Button
          variant="ghost"
          size="sm"
          className="mb-8 -ml-2 gap-1.5 text-muted-foreground"
          onClick={goHome}
        >
          <ArrowLeft className="size-4" />
          {t("legal.backHome")}
        </Button>

        <h1 className="mb-8 text-2xl font-semibold">{title}</h1>

        <div className="space-y-6">
          {sections.map((section) => (
            <section key={section.heading}>
              <h2 className="mb-2 text-base font-medium">{section.heading}</h2>
              <div className="space-y-2">
                {section.paragraphs.map((p) => (
                  <p
                    key={p.slice(0, 40)}
                    className="text-sm leading-relaxed text-muted-foreground"
                  >
                    {p}
                  </p>
                ))}
              </div>
            </section>
          ))}
        </div>

        <footer className="mt-12 border-t border-border/40 pt-6 text-xs leading-relaxed text-muted-foreground">
          <p>© 2026 MergN. All rights reserved.</p>
          <p className="mt-1">
            Quoll LLC · 8 The Green, Ste D, Dover, DE 19901, United States
          </p>
        </footer>
      </div>
    </div>
  );
}
