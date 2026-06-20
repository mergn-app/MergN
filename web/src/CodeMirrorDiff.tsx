import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { MergeView } from "@codemirror/merge";
import { EditorView, lineNumbers } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { javascript } from "@codemirror/lang-javascript";
import { oneDark } from "@codemirror/theme-one-dark";
import { cn } from "@/lib/utils";

// IDE-style code view for a single node's change:
//  • both sides present → side-by-side MergeView (old left / new right), changed
//    lines highlighted with surrounding context lines kept (GitHub-style, styled
//    in index.css), unchanged stretches ≥6 lines collapsed to 3 context lines.
//  • only one side present (node added or removed) → plain syntax-highlighted
//    source — a 100%-insertion isn't a meaningful diff, so we don't fake one.
export function CodeMirrorDiff({ oldCode, newCode }: { oldCode: string; newCode: string }) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);
  const mode = !oldCode.trim() && newCode.trim() ? "add" : oldCode.trim() && !newCode.trim() ? "del" : "diff";

  useEffect(() => {
    const host = ref.current;
    if (!host) return;
    const dark = document.documentElement.classList.contains("dark");
    const base = EditorView.theme({
      "&": { height: "100%", backgroundColor: "transparent" },
      ".cm-scroller": { overflow: "auto", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: "11px", lineHeight: "1.55" },
      ".cm-gutters": { backgroundColor: "transparent", border: "none" },
      ".cm-content": { padding: "6px 0" },
    });
    const exts = [
      EditorView.editable.of(false),
      EditorState.readOnly.of(true),
      EditorView.lineWrapping,
      lineNumbers(),
      javascript(),
      base,
      ...(dark ? [oneDark] : []),
    ];
    const view: { destroy(): void } =
      mode === "diff"
        ? new MergeView({
            a: { doc: oldCode, extensions: exts },
            b: { doc: newCode, extensions: exts },
            parent: host,
            collapseUnchanged: { margin: 3, minSize: 6 }, // keep 3 context lines, fold runs ≥6
            highlightChanges: true,
            gutter: true,
          })
        : new EditorView({ doc: mode === "add" ? newCode : oldCode, extensions: exts, parent: host });
    return () => view.destroy();
  }, [oldCode, newCode, mode]);

  return (
    <div className="flex h-full flex-col">
      {mode !== "diff" && (
        <div className={cn("flex shrink-0 items-center gap-1.5 px-3 py-1.5 text-[10px] font-medium", mode === "add" ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400")}>
          <span className={cn("size-1.5 rounded-full", mode === "add" ? "bg-emerald-500" : "bg-rose-500")} />
          {mode === "add" ? t("review.added") : t("review.removed")}
        </div>
      )}
      <div ref={ref} className="min-h-0 flex-1 [&_.cm-mergeView]:h-full [&_.cm-mergeViewEditors]:h-full" />
    </div>
  );
}
