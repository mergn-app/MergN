import { useTranslation } from "react-i18next";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "@/components/ui/select";

const LANGS = [
  { code: "en", label: "English" },
  { code: "tr", label: "Türkçe" },
  { code: "de", label: "Deutsch" },
  { code: "fr", label: "Français" },
  { code: "es", label: "Español" },
];

export function LanguageSwitcher() {
  const { i18n } = useTranslation();
  const current =
    LANGS.find((l) => i18n.language?.startsWith(l.code))?.code ?? "en";

  return (
    <Select value={current} onValueChange={(v) => void i18n.changeLanguage(v)}>
      <SelectTrigger
        size="sm"
        className="h-8 w-auto gap-1 px-2 text-[11px] font-semibold uppercase"
      >
        {current}
      </SelectTrigger>
      <SelectContent position="popper" sideOffset={4} align="end">
        {LANGS.map((l) => (
          <SelectItem key={l.code} value={l.code}>
            {l.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
