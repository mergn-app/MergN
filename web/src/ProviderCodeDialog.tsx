import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { X, Loader2 } from "lucide-react";
import { CodeBlock } from "./CodeBlock";
import { fetchProviderSource, type ProviderSource } from "./queries";

export function ProviderCodeDialog({
  provider,
  theme,
  onClose,
}: {
  provider: string;
  theme: "dark" | "light";
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [data, setData] = useState<ProviderSource | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchProviderSource(provider)
      .then((d) => !cancelled && setData(d))
      .catch(
        (e) =>
          !cancelled && setError(e instanceof Error ? e.message : String(e)),
      );
    return () => {
      cancelled = true;
    };
  }, [provider]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        className="flex max-h-[80vh] w-full max-w-2xl flex-col rounded-2xl border border-border/60 bg-background p-4 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center gap-2">
          <h3 className="truncate text-sm font-medium">
            {data?.name ?? provider}
          </h3>
          <span className="font-mono text-[10px] text-muted-foreground/60">
            {provider}
          </span>
          <div className="ml-auto flex shrink-0 items-center gap-1.5">
            {data?.clientSource && (
              <button
                onClick={() =>
                  navigator.clipboard?.writeText(data.clientSource)
                }
                className="rounded-md border border-border/50 px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:text-foreground"
              >
                {t("run.copy")}
              </button>
            )}
            <button
              onClick={onClose}
              className="text-muted-foreground transition-colors hover:text-foreground"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {data?.credentialFields.length ? (
          <div className="mb-2 flex flex-wrap gap-1.5">
            {data.credentialFields.map((f) => (
              <span
                key={f.name}
                title={f.label}
                className="rounded bg-muted/60 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
              >
                cred.{f.name}
              </span>
            ))}
          </div>
        ) : null}

        <div className="min-h-0 flex-1 overflow-auto">
          {error ? (
            <p className="text-xs text-destructive">{error}</p>
          ) : !data ? (
            <div className="flex h-32 items-center justify-center">
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground/70" />
            </div>
          ) : data.clientSource ? (
            <CodeBlock
              source={data.clientSource}
              name={provider}
              theme={theme}
              wrap={false}
            />
          ) : (
            <p className="py-6 text-center text-xs text-muted-foreground">
              {t("connections.noCode")}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
