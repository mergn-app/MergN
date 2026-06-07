import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Plus } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useConnections } from "./queries";
import { ConnectionDialog } from "./ConnectionDialog";

const FIRST = "__first__";

export function NodeConnection({
  provider,
  requirementName,
  selectedId,
  onSelect,
}: {
  provider: string;
  requirementName: string;
  selectedId?: string;
  onSelect: (requirementName: string, connectionId: string) => void;
}) {
  const { t } = useTranslation();
  const { data: conns = [] } = useConnections();
  const [adding, setAdding] = useState(false);
  const options = conns.filter((c) => c.provider === provider);
  const connected = options.length > 0;

  return (
    <div className="space-y-1.5 rounded-lg border border-border/40 bg-card px-2.5 py-2">
      <div className="flex items-center gap-2">
        <span
          className={cn(
            "size-2 shrink-0 rounded-full",
            connected ? "bg-emerald-500" : "bg-amber-500",
          )}
        />
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-foreground/90">
          {provider}
        </span>
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="flex shrink-0 items-center gap-1 rounded-md border border-border/50 px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:text-foreground"
        >
          <Plus className="h-3 w-3" />
          {t("connections.addAccount")}
        </button>
      </div>

      {connected ? (
        <Select
          value={selectedId || FIRST}
          onValueChange={(v) => onSelect(requirementName, v === FIRST ? "" : v)}
        >
          <SelectTrigger size="sm" className="w-full bg-background text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={FIRST}>{t("connections.useFirst")}</SelectItem>
            {options.map((c) => (
              <SelectItem key={c.id} value={c.id}>
                {c.account || `${provider} · ${c.id.slice(0, 8)}`}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : (
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="w-full rounded-lg border border-dashed border-border/60 px-2 py-1.5 text-xs text-amber-300/80 transition-colors hover:text-foreground"
        >
          {t("connections.connect")}
        </button>
      )}

      {adding && (
        <ConnectionDialog provider={provider} onClose={() => setAdding(false)} />
      )}
    </div>
  );
}
