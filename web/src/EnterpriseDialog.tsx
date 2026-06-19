import { createPortal } from "react-dom";
import { Mail, MessageCircle, X } from "lucide-react";

// Contact targets for the Enterprise "Contact us" CTA. Edit these to your real
// addresses.
const ENTERPRISE_EMAIL = "mergn@quollhq.com";
const ENTERPRISE_DISCORD = "https://discord.gg/wDxHFkcbhD";

export function EnterpriseDialog({
  onClose,
  title = "Talk to us — Enterprise",
  description = "Custom limits, SSO, on-prem and a support SLA. Reach out and we'll set you up.",
}: {
  onClose: () => void;
  title?: string;
  description?: string;
}) {
  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-sm rounded-2xl border border-border/50 bg-card p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center gap-2">
          <span className="text-sm font-semibold">{title}</span>
          <button
            onClick={onClose}
            className="ml-auto text-muted-foreground hover:text-foreground"
          >
            <X className="size-4" />
          </button>
        </div>
        <p className="mb-4 text-sm text-muted-foreground">{description}</p>
        <div className="space-y-2">
          <a
            href={`mailto:${ENTERPRISE_EMAIL}`}
            className="flex items-center gap-2 rounded-lg border border-border/50 px-3 py-2 text-sm transition-colors hover:border-border"
          >
            <Mail className="size-4 text-muted-foreground" />
            <span>{ENTERPRISE_EMAIL}</span>
          </a>
          <a
            href={ENTERPRISE_DISCORD}
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-2 rounded-lg border border-border/50 px-3 py-2 text-sm transition-colors hover:border-border"
          >
            <MessageCircle className="size-4 text-muted-foreground" />
            <span>Join our Discord</span>
          </a>
        </div>
      </div>
    </div>,
    document.body,
  );
}
