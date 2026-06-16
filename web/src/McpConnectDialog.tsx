import { createPortal } from "react-dom";
import { useState } from "react";
import { Check, Copy, Plug, Terminal, Trash2, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  useCreateMcpToken,
  useMcpTokens,
  useRevokeMcpToken,
} from "./queries";

// Self-service panel so users know HOW to connect an AI chat app to MergN:
// - the /mcp endpoint URL to paste into claude.ai / ChatGPT custom connectors
//   (OAuth — no token), and
// - a token generator for CLI clients (Claude Code) that take a bearer header.
export function McpConnectDialog({ onClose }: { onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const url = `${window.location.origin}/mcp`;
  const tokens = useMcpTokens(true);
  const create = useCreateMcpToken();
  const revoke = useRevokeMcpToken();
  const [name, setName] = useState("");
  const [fresh, setFresh] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const copy = (text: string, key: string) => {
    void navigator.clipboard?.writeText(text);
    setCopied(key);
    setTimeout(() => setCopied((k) => (k === key ? null : k)), 1500);
  };

  const planLocked = create.isError && /403/.test(String(create.error));
  const cliCmd = `claude mcp add --transport http mergn ${url} \\\n  --header "Authorization: Bearer ${fresh ?? "<token>"}"`;

  const onGenerate = () => {
    setFresh(null);
    create.mutate(name.trim() || "MCP token", {
      onSuccess: (r) => {
        setFresh(r.token);
        setName("");
      },
    });
  };

  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-2xl border border-border/50 bg-card p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-1 flex items-center gap-2">
          <Plug className="size-4 text-muted-foreground" />
          <span className="text-sm font-semibold">{t("mcp.title")}</span>
          <button
            onClick={onClose}
            className="ml-auto text-muted-foreground hover:text-foreground"
          >
            <X className="size-4" />
          </button>
        </div>
        <p className="mb-4 text-sm text-muted-foreground">{t("mcp.subtitle")}</p>

        {/* Endpoint URL */}
        <label className="mb-1 block text-xs font-medium text-muted-foreground">
          {t("mcp.endpoint")}
        </label>
        <div className="mb-4 flex items-center gap-2">
          <code className="flex-1 truncate rounded-lg border border-border/50 bg-muted/40 px-3 py-2 text-xs">
            {url}
          </code>
          <button
            onClick={() => copy(url, "url")}
            className="flex items-center gap-1 rounded-lg border border-border/50 px-2.5 py-2 text-xs hover:border-border"
          >
            {copied === "url" ? (
              <Check className="size-3.5 text-green-500" />
            ) : (
              <Copy className="size-3.5" />
            )}
            {copied === "url" ? t("mcp.copied") : t("mcp.copy")}
          </button>
        </div>

        {/* Chat apps (OAuth) */}
        <div className="mb-4 rounded-xl border border-border/50 p-3">
          <div className="mb-1 text-xs font-semibold">{t("mcp.chatHeading")}</div>
          <p className="text-xs text-muted-foreground">{t("mcp.chatHelp")}</p>
        </div>

        {/* CLI (token) */}
        <div className="rounded-xl border border-border/50 p-3">
          <div className="mb-1 flex items-center gap-1.5 text-xs font-semibold">
            <Terminal className="size-3.5" />
            {t("mcp.cliHeading")}
          </div>
          <p className="mb-2 text-xs text-muted-foreground">{t("mcp.cliHelp")}</p>
          <div className="relative mb-3">
            <pre className="overflow-x-auto rounded-lg border border-border/50 bg-muted/40 p-2.5 text-[11px] leading-relaxed">
              {cliCmd}
            </pre>
            <button
              onClick={() => copy(cliCmd, "cli")}
              className="absolute right-1.5 top-1.5 rounded-md border border-border/50 bg-card px-1.5 py-1 text-[10px] hover:border-border"
            >
              {copied === "cli" ? t("mcp.copied") : t("mcp.copy")}
            </button>
          </div>

          {/* Token generator */}
          <div className="mb-2 text-xs font-semibold">{t("mcp.tokensHeading")}</div>
          <p className="mb-2 text-xs text-muted-foreground">{t("mcp.tokensHelp")}</p>

          {planLocked ? (
            <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-600 dark:text-amber-400">
              {t("mcp.planLocked")}
            </p>
          ) : (
            <>
              <div className="flex items-center gap-2">
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder={t("mcp.namePlaceholder")}
                  className="flex-1 rounded-lg border border-border/50 bg-background px-3 py-2 text-xs outline-none focus:border-border"
                  onKeyDown={(e) => e.key === "Enter" && onGenerate()}
                />
                <button
                  onClick={onGenerate}
                  disabled={create.isPending}
                  className="rounded-lg bg-primary px-3 py-2 text-xs font-medium text-primary-foreground disabled:opacity-50"
                >
                  {t("mcp.generate")}
                </button>
              </div>
              {create.isError && !planLocked && (
                <p className="mt-2 text-xs text-destructive">{t("mcp.error")}</p>
              )}
              {fresh && (
                <div className="mt-2 rounded-lg border border-green-500/30 bg-green-500/10 p-2.5">
                  <p className="mb-1 text-[11px] text-green-600 dark:text-green-400">
                    {t("mcp.tokenOnce")}
                  </p>
                  <div className="flex items-center gap-2">
                    <code className="flex-1 truncate text-[11px]">{fresh}</code>
                    <button
                      onClick={() => copy(fresh, "fresh")}
                      className="rounded-md border border-border/50 bg-card px-1.5 py-1 text-[10px] hover:border-border"
                    >
                      {copied === "fresh" ? t("mcp.copied") : t("mcp.copy")}
                    </button>
                  </div>
                </div>
              )}
            </>
          )}

          {/* Existing tokens */}
          <div className="mt-3 space-y-1.5">
            {tokens.data && tokens.data.length === 0 && (
              <p className="text-xs text-muted-foreground">{t("mcp.empty")}</p>
            )}
            {tokens.data?.map((tk) => (
              <div
                key={tk.id}
                className="flex items-center gap-2 rounded-lg border border-border/50 px-2.5 py-1.5"
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate text-xs">{tk.name}</div>
                  <div className="text-[10px] text-muted-foreground">
                    {t("mcp.created", {
                      date: new Date(tk.createdAt).toLocaleDateString(i18n.language),
                    })}
                  </div>
                </div>
                <button
                  onClick={() => revoke.mutate(tk.id)}
                  className="text-muted-foreground hover:text-destructive"
                  title={t("mcp.revoke")}
                >
                  <Trash2 className="size-3.5" />
                </button>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
