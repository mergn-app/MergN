import { useTranslation } from "react-i18next";
import { useNavigate } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useAuth } from "./authContext";

export function LegalLinks({ className }: { className?: string }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { managed } = useAuth();

  if (managed !== true) return null;

  return (
    <div className={cn("flex items-center gap-0.5", className)}>
      <Button
        size="sm"
        variant="ghost"
        className="h-8 px-2 text-xs text-muted-foreground"
        onClick={() => void navigate({ to: "/terms" })}
      >
        {t("header.termsOfService")}
      </Button>
      <Button
        size="sm"
        variant="ghost"
        className="h-8 px-2 text-xs text-muted-foreground"
        onClick={() => void navigate({ to: "/privacy" })}
      >
        {t("header.privacyPolicy")}
      </Button>
    </div>
  );
}
