import { useEffect, useState } from "react";
import { ShieldCheck, Loader2, Check, X } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  getWebhookAuth,
  setWebhookAuth,
  testWebhookAuth,
  type WebhookAuthType,
} from "./queries";

const METHODS: { value: WebhookAuthType; label: string }[] = [
  { value: "none", label: "No auth (insecure)" },
  { value: "hmac", label: "HMAC signature (GitHub, Stripe, generic)" },
  { value: "basic", label: "Basic auth" },
  { value: "bearer", label: "Bearer token" },
  { value: "jwt", label: "JWT (HS256)" },
];

const field =
  "w-full rounded-lg border border-border/60 bg-background-subtle px-2.5 py-1.5 text-xs text-foreground outline-none focus:border-foreground/30";

export function WebhookSecurity({ workflowId }: { workflowId: string }) {
  const [type, setType] = useState<WebhookAuthType>("none");
  const [savedType, setSavedType] = useState<WebhookAuthType>("none");
  const [header, setHeader] = useState("");
  const [secret, setSecret] = useState("");
  const [user, setUser] = useState("");
  const [pass, setPass] = useState("");
  const [saving, setSaving] = useState(false);
  const [test, setTest] = useState<null | "loading" | "ok" | "fail">(null);

  useEffect(() => {
    getWebhookAuth(workflowId)
      .then((c) => {
        setType(c.type);
        setSavedType(c.type);
        setHeader(c.header ?? "");
      })
      .catch(() => {});
  }, [workflowId]);

  const save = async () => {
    setSaving(true);
    setTest(null);
    const sec =
      type === "basic"
        ? user && pass
          ? `${user}:${pass}`
          : undefined
        : secret || undefined;
    try {
      await setWebhookAuth(workflowId, {
        type,
        header: header.trim() || undefined,
        secret: sec,
      });
      setSavedType(type);
      setSecret("");
      setUser("");
      setPass("");
    } finally {
      setSaving(false);
    }
  };

  const runTest = async () => {
    setTest("loading");
    try {
      const { ok } = await testWebhookAuth(workflowId);
      setTest(ok ? "ok" : "fail");
    } catch {
      setTest("fail");
    }
  };

  const secured = savedType !== "none";

  return (
    <div className="mt-4 space-y-2 border-t border-border/50 pt-4">
      <div className="flex items-center gap-2">
        <span className="text-[10px] font-semibold tracking-widest text-muted-foreground/70">
          SECURITY
        </span>
        {secured && (
          <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-medium text-emerald-500">
            <ShieldCheck className="size-3" /> Secured
          </span>
        )}
      </div>
      <p className="text-xs leading-relaxed text-muted-foreground">
        Require callers to authenticate. Unverified requests are rejected (401).
      </p>

      <Select
        value={type}
        onValueChange={(v) => {
          setType(v as WebhookAuthType);
          setTest(null);
        }}
      >
        <SelectTrigger
          size="sm"
          className="w-full bg-background-subtle text-xs"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent position="popper">
          {METHODS.map((m) => (
            <SelectItem key={m.value} value={m.value} className="text-xs">
              {m.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {type === "basic" && (
        <div className="flex gap-2">
          <input
            className={field}
            placeholder="username"
            value={user}
            onChange={(e) => setUser(e.target.value)}
          />
          <input
            className={field}
            type="password"
            placeholder={savedType === "basic" ? "password (unchanged)" : "password"}
            value={pass}
            onChange={(e) => setPass(e.target.value)}
          />
        </div>
      )}

      {(type === "hmac" || type === "bearer" || type === "jwt") && (
        <input
          className={field}
          type="password"
          placeholder={
            savedType === type
              ? "secret (leave blank to keep current)"
              : type === "bearer"
                ? "token"
                : "signing secret (e.g. Stripe whsec_…)"
          }
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
        />
      )}

      {(type === "hmac" || type === "jwt") && (
        <input
          className={field}
          placeholder={
            type === "hmac"
              ? "signature header (default: x-signature)"
              : "token header (default: authorization)"
          }
          value={header}
          onChange={(e) => setHeader(e.target.value)}
        />
      )}

      <div className="flex items-center gap-2 pt-1">
        <button
          onClick={save}
          disabled={saving}
          className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {saving && <Loader2 className="size-3.5 animate-spin" />}
          Save
        </button>
        {secured && (
          <button
            onClick={runTest}
            disabled={test === "loading"}
            className="flex items-center gap-1.5 rounded-lg border border-border/60 px-3 py-1.5 text-xs font-medium text-foreground/80 transition-colors hover:border-border disabled:opacity-50"
          >
            {test === "loading" ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : test === "ok" ? (
              <Check className="size-3.5 text-emerald-500" />
            ) : test === "fail" ? (
              <X className="size-3.5 text-rose-500" />
            ) : null}
            {test === "ok"
              ? "Works"
              : test === "fail"
                ? "Failed"
                : "Test"}
          </button>
        )}
      </div>
    </div>
  );
}
