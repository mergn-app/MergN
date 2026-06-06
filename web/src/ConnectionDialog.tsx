import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useQueryClient } from "@tanstack/react-query";
import { Check, Copy, ExternalLink } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  useCreateConnection,
  useDeleteConnection,
  useProviderAuth,
  useOAuthStatus,
  useSaveOAuthApp,
  useDeleteOAuthApp,
  type ConnectionMeta,
  type SetupGuide,
} from "./queries";
import { getSpace } from "./space";

function CopyChip({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        navigator.clipboard?.writeText(value);
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      }}
      className="mt-1 flex w-full items-center gap-2 rounded-lg border border-border/60 bg-background-subtle px-2.5 py-1.5 text-left font-mono text-[11px] text-foreground/80 transition-colors hover:border-border"
    >
      <span className="min-w-0 flex-1 truncate">{value}</span>
      {copied ? (
        <Check className="h-3.5 w-3.5 shrink-0 text-emerald-400" />
      ) : (
        <Copy className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      )}
    </button>
  );
}

function Guide({ guide }: { guide: SetupGuide }) {
  const redirectUrl = `${window.location.origin}/api/oauth/callback`;
  return (
    <div className="space-y-2.5">
      {guide.intro && (
        <p className="text-xs leading-relaxed text-muted-foreground">
          {guide.intro}
        </p>
      )}
      <ol className="space-y-2.5">
        {guide.steps.map((s, i) => (
          <li key={i} className="flex gap-2.5">
            <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-secondary text-[11px] font-medium text-foreground/80">
              {i + 1}
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-medium text-foreground">
                {s.title}
              </div>
              {s.detail && (
                <div className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                  {s.detail}
                </div>
              )}
              {s.link && (
                <a
                  href={s.link.href}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-1 inline-flex items-center gap-1 text-xs text-[#8fb3ff] hover:text-[#a9c4ff]"
                >
                  {s.link.label}
                  <ExternalLink className="h-3 w-3" />
                </a>
              )}
              {s.copyRedirectUrl && <CopyChip value={redirectUrl} />}
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

function Divider({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-3 pt-1">
      <div className="h-px flex-1 bg-border/60" />
      <span className="text-[10px] font-medium uppercase tracking-widest text-muted-foreground/70">
        {label}
      </span>
      <div className="h-px flex-1 bg-border/60" />
    </div>
  );
}

export function ConnectionDialog({
  provider,
  connection,
  onClose,
}: {
  provider: string;
  connection?: ConnectionMeta;
  onClose: () => void;
}) {
  const auth = useProviderAuth(provider);
  const isOAuth = auth.data?.type === "oauth2";
  const oauthStatus = useOAuthStatus(provider, !!isOAuth && !connection);
  const saveApp = useSaveOAuthApp(provider);
  const deleteApp = useDeleteOAuthApp(provider);
  const create = useCreateConnection();
  const del = useDeleteConnection();
  const qc = useQueryClient();

  const [key, setKey] = useState("");
  const [account, setAccount] = useState("");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [authUrl, setAuthUrl] = useState("");
  const [tokenUrl, setTokenUrl] = useState("");
  const [oauthBusy, setOauthBusy] = useState(false);
  const [oauthError, setOauthError] = useState<string | null>(null);
  const listenerRef = useRef<((e: MessageEvent) => void) | null>(null);

  useEffect(() => {
    return () => {
      if (listenerRef.current)
        window.removeEventListener("message", listenerRef.current);
    };
  }, []);

  const connectApiKey = () => {
    create.mutate(
      { provider, key: key.trim(), account: account.trim() || undefined },
      { onSuccess: onClose },
    );
  };

  const connectOAuth = () => {
    setOauthError(null);
    setOauthBusy(true);
    const popup = window.open(
      `/api/oauth/${provider}/start?space=${encodeURIComponent(getSpace())}`,
      "oauth-connect",
      "width=620,height=760",
    );
    const onMsg = (e: MessageEvent) => {
      const d = e.data as { type?: string; ok?: boolean; detail?: string };
      if (!d || d.type !== "oauth-result") return;
      window.removeEventListener("message", onMsg);
      listenerRef.current = null;
      setOauthBusy(false);
      if (d.ok) {
        qc.invalidateQueries({ queryKey: ["connections"] });
        onClose();
      } else {
        setOauthError(d.detail || "connection failed");
      }
    };
    listenerRef.current = onMsg;
    window.addEventListener("message", onMsg);
    const timer = setInterval(() => {
      if (popup && popup.closed) {
        clearInterval(timer);
        window.removeEventListener("message", onMsg);
        listenerRef.current = null;
        setOauthBusy(false);
      }
    }, 700);
  };

  const disconnect = () => {
    if (connection) del.mutate(connection.id, { onSuccess: onClose });
  };

  const field = auth.data?.fields?.[0];
  const configured = oauthStatus.data?.configured ?? false;
  const needsEndpoints = oauthStatus.data?.needsEndpoints ?? false;

  const saveAndConnect = () => {
    saveApp.mutate(
      {
        clientId: clientId.trim(),
        clientSecret: clientSecret.trim(),
        authUrl: needsEndpoints ? authUrl.trim() || undefined : undefined,
        tokenUrl: needsEndpoints ? tokenUrl.trim() || undefined : undefined,
      },
      { onSuccess: connectOAuth },
    );
  };

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6"
      onClick={onClose}
    >
      <div
        className="w-full max-w-sm rounded-2xl border bg-card p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center gap-2">
          <span className="text-sm font-semibold">
            {auth.data?.name ?? provider}
          </span>
          {connection ? (
            <Badge variant="secondary" className="gap-1">
              <span className="size-1.5 rounded-full bg-emerald-500" />
              connected
            </Badge>
          ) : (
            <Badge variant="outline">not connected</Badge>
          )}
          <button
            onClick={onClose}
            className="ml-auto text-muted-foreground hover:text-foreground"
          >
            ✕
          </button>
        </div>

        {connection ? (
          <div className="space-y-3 text-sm">
            {connection.account && (
              <div className="text-muted-foreground">
                Account: <span className="text-foreground">{connection.account}</span>
              </div>
            )}
            <div className="text-xs text-muted-foreground">
              Connected {new Date(connection.createdAt).toLocaleDateString()}
            </div>
            <Button
              variant="outline"
              className="w-full"
              disabled={del.isPending}
              onClick={disconnect}
            >
              Disconnect
            </Button>
          </div>
        ) : auth.isLoading ? (
          <div className="py-6 text-center text-xs text-muted-foreground">
            loading…
          </div>
        ) : isOAuth ? (
          oauthStatus.isLoading ? (
            <div className="py-6 text-center text-xs text-muted-foreground">
              loading…
            </div>
          ) : configured ? (
            <div className="space-y-3">
              <p className="text-xs leading-relaxed text-muted-foreground">
                You'll be redirected to {auth.data?.name} to authorize access
                {auth.data?.scopes?.length ? (
                  <>
                    {" "}
                    with scope{" "}
                    <span className="font-mono text-foreground/80">
                      {auth.data.scopes.join(", ")}
                    </span>
                  </>
                ) : null}
                .
              </p>
              {oauthError && (
                <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">
                  {oauthError}
                </div>
              )}
              <Button className="w-full" disabled={oauthBusy} onClick={connectOAuth}>
                {oauthBusy
                  ? "waiting for authorization…"
                  : `Connect with ${auth.data?.name}`}
              </Button>
              <button
                type="button"
                disabled={deleteApp.isPending}
                onClick={() => deleteApp.mutate()}
                className="w-full text-center text-[11px] text-muted-foreground/70 hover:text-muted-foreground"
              >
                Use a different OAuth app
              </button>
            </div>
          ) : (
            <div className="space-y-3">
              {auth.data?.setupGuide ? (
                <>
                  <Guide guide={auth.data.setupGuide} />
                  <Divider label="Credentials" />
                </>
              ) : (
                <p className="text-xs leading-relaxed text-muted-foreground">
                  No OAuth app is configured for {auth.data?.name}. Register one
                  (redirect URL{" "}
                  <span className="font-mono text-foreground/70">
                    {window.location.origin}/api/oauth/callback
                  </span>
                  ), then paste its credentials.
                </p>
              )}
              <Input
                value={clientId}
                onChange={(e) => setClientId(e.target.value)}
                placeholder="Client ID"
                autoFocus
              />
              <Input
                value={clientSecret}
                onChange={(e) => setClientSecret(e.target.value)}
                type="password"
                placeholder="Client secret"
              />
              {needsEndpoints && (
                <>
                  <Input
                    value={authUrl}
                    onChange={(e) => setAuthUrl(e.target.value)}
                    placeholder="Authorize URL"
                  />
                  <Input
                    value={tokenUrl}
                    onChange={(e) => setTokenUrl(e.target.value)}
                    placeholder="Token URL"
                  />
                </>
              )}
              {oauthError && (
                <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">
                  {oauthError}
                </div>
              )}
              <Button
                className="w-full"
                disabled={
                  !clientId.trim() ||
                  !clientSecret.trim() ||
                  (needsEndpoints && (!authUrl.trim() || !tokenUrl.trim())) ||
                  saveApp.isPending ||
                  oauthBusy
                }
                onClick={saveAndConnect}
              >
                {saveApp.isPending
                  ? "saving…"
                  : oauthBusy
                    ? "waiting for authorization…"
                    : `Save & connect with ${auth.data?.name}`}
              </Button>
            </div>
          )
        ) : (
          <div className="space-y-3">
            {auth.data?.setupGuide && (
              <>
                <Guide guide={auth.data.setupGuide} />
                <Divider label="Credentials" />
              </>
            )}
            <Input
              value={key}
              onChange={(e) => setKey(e.target.value)}
              type={field?.type === "text" ? "text" : "password"}
              placeholder={field?.label ?? field?.placeholder ?? "API key"}
              autoFocus
            />
            <Input
              value={account}
              onChange={(e) => setAccount(e.target.value)}
              placeholder="account label (optional)"
            />
            <Button
              className="w-full"
              disabled={!key.trim() || create.isPending}
              onClick={connectApiKey}
            >
              {create.isPending ? "connecting…" : "Connect"}
            </Button>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
