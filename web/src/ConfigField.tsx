import { useEffect, useRef, useState } from "react";
import { Loader2, Check } from "lucide-react";
import { Input } from "@/components/ui/input";

// A config input with an inline save indicator: an amber spinner while the
// workflow is autosaving the edit, then a brief green tick when it's persisted.
// Shared by NodePanel (step Settings) and RunPanel (run-tab config) so both
// places give the same save feedback.
export function ConfigField({
  name,
  type,
  value,
  onChange,
  savePending,
}: {
  name: string;
  type: string;
  value: string;
  onChange: (value: string) => void;
  savePending: boolean;
}) {
  const [dirty, setDirty] = useState(false);
  const [saved, setSaved] = useState(false);
  const prevPending = useRef(savePending);

  // A save settled (pending true → false) while this field was edited → saved.
  useEffect(() => {
    if (prevPending.current && !savePending && dirty) {
      setDirty(false);
      setSaved(true);
    }
    prevPending.current = savePending;
  }, [savePending, dirty]);

  useEffect(() => {
    if (!saved) return;
    const t = setTimeout(() => setSaved(false), 1500);
    return () => clearTimeout(t);
  }, [saved]);

  return (
    <div className="relative">
      <Input
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          setDirty(true);
          setSaved(false);
        }}
        type={type === "number" ? "number" : "text"}
        placeholder={`${name}…`}
        className="h-8 rounded-lg bg-background pr-7 text-sm"
      />
      <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2">
        {dirty && savePending ? (
          <Loader2 className="size-3.5 animate-spin text-amber-500" />
        ) : saved ? (
          <Check className="size-3.5 text-green-500" />
        ) : null}
      </span>
    </div>
  );
}
