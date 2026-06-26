import { useState } from "react";
import { Check, Copy, Mail, MessageCircle, X } from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";

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
  const [copied, setCopied] = useState(false);

  const copyEmail = async () => {
    try {
      await navigator.clipboard.writeText(ENTERPRISE_EMAIL);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      // no-op: keep mailto action available even if clipboard is blocked
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="w-full max-w-sm" showClose={false}>
        <div className="mb-3 flex items-center gap-2">
          <DialogTitle>{title}</DialogTitle>
          <button
            onClick={onClose}
            className="ml-auto text-muted-foreground hover:text-foreground"
          >
            <X className="size-4" />
          </button>
        </div>
        <p className="mb-4 text-sm text-muted-foreground">{description}</p>
        <div className="space-y-2">
          <div className="flex w-full gap-1">
            <a
              href={`mailto:${ENTERPRISE_EMAIL}`}
              className="min-w-0 flex-1 flex items-center gap-2 rounded-lg border border-border/50 px-3 py-2 text-sm transition-colors hover:border-border"
            >
              <Mail className="size-4 shrink-0 text-muted-foreground" />
              <span className="truncate">{ENTERPRISE_EMAIL}</span>
            </a>
            <button
              type="button"
              onClick={copyEmail}
              className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border/50 transition-colors hover:border-border"
              title={copied ? "Copied" : "Copy email"}
            >
              {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
            </button>
          </div>
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
      </DialogContent>
    </Dialog>
  );
}
