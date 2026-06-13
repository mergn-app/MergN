import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { createPortal } from "react-dom";
import { useQueryClient } from "@tanstack/react-query";
import { Check, Copy, ExternalLink } from "lucide-react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  useConnections,
  useCreateConnection,
  useDeleteConnection,
  useUpdateConnection,
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
  const { t, i18n } = useTranslation();
  const auth = useProviderAuth(provider);
  const isOAuth = auth.data?.type === "oauth2";
  const [adding, setAdding] = useState(false);
  // Callers that open this dialog from a "connect X" prompt (chat, node picker)
  // don't pass the existing connection — without this lookup the dialog would
  // always render in create mode and show an already-connected provider as
  // "not connected". Fall back to the current space's connection for this
  // provider so it opens in manage mode when one already exists.
  const { data: conns = [] } = useConnections();
  const resolved = connection ?? conns.find((c) => c.provider === provider);
  const creating = !resolved || adding;
  const oauthStatus = useOAuthStatus(provider, !!isOAuth && creating);
  const saveApp = useSaveOAuthApp(provider);
  const deleteApp = useDeleteOAuthApp(provider);
  const create = useCreateConnection();
  const del = useDeleteConnection();
  const update = useUpdateConnection();
  const qc = useQueryClient();

  const [cred, setCred] = useState<Record<string, string>>({});
  const [account, setAccount] = useState("");
  const [nameDraft, setNameDraft] = useState(resolved?.account ?? "");
  const [savedName, setSavedName] = useState(resolved?.account ?? "");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [authUrl, setAuthUrl] = useState("");
  const [tokenUrl, setTokenUrl] = useState("");
  const [oauthBusy, setOauthBusy] = useState(false);
  const [oauthError, setOauthError] = useState<string | null>(null);
  const [closing, setClosing] = useState(false);
  const listenerRef = useRef<((e: MessageEvent) => void) | null>(null);

  const requestClose = () => setClosing(true);
  const onOverlayAnimEnd = (e: React.AnimationEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget || !closing) return;
    onClose();
  };

  useEffect(() => {
    return () => {
      if (listenerRef.current)
        window.removeEventListener("message", listenerRef.current);
    };
  }, []);

  const fields = auth.data?.fields ?? [];
  const missingRequired = fields.some(
    (f) => f.required && !(cred[f.name] ?? "").trim(),
  );

  const connectApiKey = () => {
    const trimmed: Record<string, string> = {};
    for (const f of fields) {
      const v = (cred[f.name] ?? "").trim();
      if (v) trimmed[f.name] = v;
    }
    create.mutate(
      { provider, cred: trimmed, account: account.trim() || undefined },
      { onSuccess: requestClose },
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
        requestClose();
      } else {
        setOauthError(d.detail || t("connectionDialog.connectionFailed"));
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
    if (resolved) del.mutate(resolved.id, { onSuccess: requestClose });
  };

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
      className={cn(
        "fixed inset-0 z-50 flex items-center justify-center bg-background/70 p-6 backdrop-blur-xs duration-200",
        closing ? "animate-out fade-out fill-mode-forwards" : "animate-in fade-in",
      )}
      onClick={requestClose}
      onAnimationEnd={onOverlayAnimEnd}
    >
      <div
        className={cn(
          "w-full max-w-sm rounded-2xl border border-border/50 bg-card p-5 duration-200 ease-out",
          closing
            ? "animate-out fade-out zoom-out-95 slide-out-to-bottom-2 fill-mode-forwards"
            : "animate-in fade-in zoom-in-95 slide-in-from-bottom-2",
        )}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center gap-2">
          <span className="text-sm font-semibold">
            {auth.data?.name ?? provider}
          </span>
          {!creating ? (
            <Badge variant="secondary" className="gap-1">
              <span className="size-1.5 rounded-full bg-emerald-500" />
              {t("connections.connected")}
            </Badge>
          ) : (
            <Badge variant="outline">{t("connectionDialog.notConnected")}</Badge>
          )}
          <button
            onClick={requestClose}
            className="ml-auto text-muted-foreground hover:text-foreground"
          >
            ✕
          </button>
        </div>

        {!creating ? (
          <div className="space-y-3 text-sm">
            <div className="space-y-1">
              <label className="text-xs font-medium">
                {t("connectionDialog.name")}
              </label>
              <div className="flex gap-2">
                <Input
                  value={nameDraft}
                  onChange={(e) => setNameDraft(e.target.value)}
                  placeholder={t("connectionDialog.nameThis")}
                />
                <Button
                  variant="outline"
                  disabled={
                    update.isPending || nameDraft.trim() === savedName.trim()
                  }
                  onClick={() =>
                    update.mutate(
                      {
                        id: resolved.id,
                        account: nameDraft.trim() || undefined,
                      },
                      { onSuccess: (m) => setSavedName(m.account ?? "") },
                    )
                  }
                >
                  {update.isPending ? "…" : t("common.save")}
                </Button>
              </div>
            </div>
            <div className="text-xs text-muted-foreground">
              {t("connectionDialog.connectedOn", {
                date: new Date(resolved.createdAt).toLocaleDateString(
                  i18n.language,
                ),
              })}
            </div>
            <Button
              variant="outline"
              className="w-full"
              disabled={del.isPending}
              onClick={disconnect}
            >
              {t("connectionDialog.disconnect")}
            </Button>
            <button
              type="button"
              onClick={() => setAdding(true)}
              className="w-full text-center text-[11px] text-muted-foreground/70 hover:text-muted-foreground"
            >
              {t("connectionDialog.addAnother")}
            </button>
          </div>
        ) : auth.isLoading ? (
          <div className="py-6 text-center text-xs text-muted-foreground">
            {t("common.loading")}
          </div>
        ) : isOAuth ? (
          oauthStatus.isLoading ? (
            <div className="py-6 text-center text-xs text-muted-foreground">
              loading…
            </div>
          ) : configured ? (
            <div className="space-y-3">
              <p className="text-xs leading-relaxed text-muted-foreground">
                {auth.data?.scopes?.length
                  ? t("connectionDialog.redirectInfoScope", {
                      name: auth.data?.name,
                      scopes: auth.data.scopes.join(", "),
                    })
                  : t("connectionDialog.redirectInfo", {
                      name: auth.data?.name,
                    })}
              </p>
              {oauthError && (
                <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">
                  {oauthError}
                </div>
              )}
              <Button className="w-full" disabled={oauthBusy} onClick={connectOAuth}>
                {oauthBusy
                  ? t("connectionDialog.waitingAuth")
                  : t("connectionDialog.connectWith", { name: auth.data?.name })}
              </Button>
              <button
                type="button"
                disabled={deleteApp.isPending}
                onClick={() => deleteApp.mutate()}
                className="w-full text-center text-[11px] text-muted-foreground/70 hover:text-muted-foreground"
              >
                {t("connectionDialog.useDifferentApp")}
              </button>
            </div>
          ) : (
            <div className="space-y-3">
              {auth.data?.setupGuide ? (
                <>
                  <Guide guide={auth.data.setupGuide} />
                  <Divider label={t("connectionDialog.credentials")} />
                </>
              ) : (
                <p className="text-xs leading-relaxed text-muted-foreground">
                  {t("connectionDialog.noOAuthApp", {
                    name: auth.data?.name,
                    url: `${window.location.origin}/api/oauth/callback`,
                  })}
                </p>
              )}
              <Input
                value={clientId}
                onChange={(e) => setClientId(e.target.value)}
                placeholder={t("connectionDialog.clientId")}
                autoFocus
              />
              <Input
                value={clientSecret}
                onChange={(e) => setClientSecret(e.target.value)}
                type="password"
                placeholder={t("connectionDialog.clientSecret")}
              />
              {needsEndpoints && (
                <>
                  <Input
                    value={authUrl}
                    onChange={(e) => setAuthUrl(e.target.value)}
                    placeholder={t("connectionDialog.authorizeUrl")}
                  />
                  <Input
                    value={tokenUrl}
                    onChange={(e) => setTokenUrl(e.target.value)}
                    placeholder={t("connectionDialog.tokenUrl")}
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
                  ? t("common.saving")
                  : oauthBusy
                    ? t("connectionDialog.waitingAuth")
                    : t("connectionDialog.saveConnect", {
                        name: auth.data?.name,
                      })}
              </Button>
            </div>
          )
        ) : (
          <div className="space-y-3">
            {auth.data?.setupGuide && (
              <>
                <Guide guide={auth.data.setupGuide} />
                <Divider label={t("connectionDialog.credentials")} />
              </>
            )}
            {fields.map((f, i) => (
              <div key={f.name} className="space-y-1">
                <label className="flex items-center gap-2 text-xs">
                  <span className="font-medium">{f.label}</span>
                  {f.required && (
                    <span className="text-[10px] text-rose-300/70">
                      {t("connectionDialog.required")}
                    </span>
                  )}
                </label>
                <Input
                  value={cred[f.name] ?? ""}
                  onChange={(e) =>
                    setCred((c) => ({ ...c, [f.name]: e.target.value }))
                  }
                  type={
                    f.type === "number"
                      ? "number"
                      : f.type === "text"
                        ? "text"
                        : "password"
                  }
                  placeholder={f.placeholder ?? f.label}
                  autoFocus={i === 0}
                />
                {f.help && (
                  <p className="text-[11px] leading-snug text-muted-foreground/70">
                    {f.help}
                  </p>
                )}
              </div>
            ))}
            <div className="space-y-1">
              <Input
                value={account}
                onChange={(e) => setAccount(e.target.value)}
                placeholder={t("connectionDialog.nameThis")}
              />
              <p className="text-[11px] leading-snug text-muted-foreground/70">
                {t("connectionDialog.nameHelp")}
              </p>
            </div>
            <Button
              className="w-full"
              disabled={missingRequired || create.isPending}
              onClick={connectApiKey}
            >
              {create.isPending
                ? t("connectionDialog.connecting")
                : t("connectionDialog.connect")}
            </Button>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
