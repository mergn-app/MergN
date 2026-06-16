import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useAuth } from "./authContext";

// Legal links open in a NEW TAB so reading them never unmounts the builder
// (which would drop the open flow, chat stream and run). The /terms and /privacy
// routes stay as standalone, directly-linkable pages for compliance + the login
// screen. asChild renders a real <a> so middle-click / open-in-new-tab work too.
export function LegalLinks({ className }: { className?: string }) {
  const { t } = useTranslation();
  const { managed } = useAuth();

  if (managed !== true) return null;

  return (
    <div className={cn("flex items-center gap-0.5", className)}>
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
    </div>
  );
}
