import { useEffect, useRef, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { ArrowUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ModelPicker } from "./ModelPicker";

export function ChatComposer({
  value,
  onChange,
  onSubmit,
  disabled = false,
  submitDisabled,
  inputRef: externalRef,
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  disabled?: boolean;
  submitDisabled?: boolean;
  inputRef?: RefObject<HTMLTextAreaElement | null>;
}) {
  const { t } = useTranslation();
  const internalRef = useRef<HTMLTextAreaElement>(null);
  const taRef = externalRef ?? internalRef;

  useEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 208)}px`;
  }, [value, taRef]);

  const blocked = submitDisabled ?? (!value.trim() || disabled);

  return (
    <>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (blocked) return;
          onSubmit();
        }}
        className="p-2"
      >
        <div className="flex items-end gap-2 rounded-2xl border border-border/40 bg-background-subtle p-2 transition-colors focus-within:border-foreground/20">
          <textarea
            ref={taRef}
            value={value}
            rows={1}
            disabled={disabled}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                if (blocked) return;
                onSubmit();
              }
            }}
            placeholder={t("chat.placeholder")}
            className="max-h-52 min-h-20 flex-1 resize-none self-stretch border-none bg-transparent px-1 py-1 text-sm leading-relaxed text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-0"
          />
          <Button
            type="submit"
            size="icon"
            disabled={blocked}
            className="h-8 w-8 shrink-0 rounded-xl"
          >
            <ArrowUp className="size-4" />
          </Button>
        </div>
      </form>
      <ModelPicker />
    </>
  );
}
