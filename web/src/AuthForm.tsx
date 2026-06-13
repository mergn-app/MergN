import { useState } from "react";
import { useTranslation } from "react-i18next";
import { signIn, signUp } from "./auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { LegalLinks } from "./LegalLinks";

type Mode = "signin" | "signup";

export function AuthForm({ showLegalLinks = true }: { showLegalLinks?: boolean }) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<Mode>("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res =
        mode === "signin"
          ? await signIn.email({ email, password })
          : await signUp.email({ email, password, name: name || email });
      if (res.error) setError(res.error.message || t("auth.failed"));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("auth.failed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="w-full">
      <div className="mb-5">
        <h1 className="text-xl font-semibold">
          {mode === "signin" ? t("auth.welcomeBack") : t("auth.getSetUp")}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {mode === "signin"
            ? t("auth.signinSubtitle")
            : t("auth.signupSubtitle")}
        </p>
      </div>

      <form onSubmit={submit} className="flex flex-col gap-3">
        {mode === "signup" && (
          <Input
            placeholder={t("auth.name")}
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoComplete="name"
            className="h-11 rounded-xl"
          />
        )}
        <Input
          type="email"
          placeholder={t("auth.email")}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoComplete="email"
          required
          className="h-11 rounded-xl"
        />
        <Input
          type="password"
          placeholder={t("auth.password")}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete={mode === "signin" ? "current-password" : "new-password"}
          required
          className="h-11 rounded-xl"
        />
        {error && <p className="text-sm text-destructive">{error}</p>}
        <Button type="submit" className="h-11 w-full rounded-xl" disabled={busy}>
          {busy
            ? t("common.pleaseWait")
            : mode === "signin"
              ? t("auth.signIn")
              : t("auth.createAccount")}
        </Button>
      </form>

      <button
        type="button"
        onClick={() => {
          setMode((m) => (m === "signin" ? "signup" : "signin"));
          setError(null);
        }}
        className="mt-4 w-full text-center text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        {mode === "signin" ? t("auth.toSignup") : t("auth.toSignin")}
      </button>

      {showLegalLinks && (
        <div className="mt-4 flex justify-center">
          <LegalLinks />
        </div>
      )}
    </div>
  );
}
