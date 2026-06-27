import { useEffect, useMemo, useState } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { javascript } from "@codemirror/lang-javascript";
import { oneDark } from "@codemirror/theme-one-dark";
import { Decoration, EditorView } from "@codemirror/view";
import { EditorState, type Extension } from "@codemirror/state";
import { cn } from "@/lib/utils";
import { format } from "prettier/standalone";
import babel from "prettier/plugins/babel";
import estree from "prettier/plugins/estree";

function extractFunctionBody(text: string): string | null {
  const trimmed = text.trim();
  const open = trimmed.indexOf("{");
  const close = trimmed.lastIndexOf("}");
  if (open === -1 || close === -1 || close <= open) return null;
  const head = trimmed.slice(0, open + 1);
  if (
    !/\bfunction\b/.test(head) &&
    !/=>\s*\{/.test(trimmed) &&
    !/export\s+default/.test(head)
  ) {
    return null;
  }
  return trimmed.slice(open + 1, close).replace(/^\n/, "").replace(/\n$/, "");
}

export function CodeBlock({
  source,
  name,
  theme = "dark",
  wrap = true,
  fill = false,
  editable = false,
  lockedPrefix = "",
  lockedSuffix = "",
  value,
  onChange,
  completion,
}: {
  source: string;
  name: string;
  theme?: "dark" | "light";
  wrap?: boolean;
  fill?: boolean;
  editable?: boolean;
  lockedPrefix?: string;
  lockedSuffix?: string;
  value?: string;
  onChange?: (next: string) => void;
  completion?: Extension;
}) {
  const [code, setCode] = useState("");
  const displayCode = value ?? code;

  useEffect(() => {
    if (value !== undefined) return;
    let cancelled = false;
    const wrapped = `async function ${name}(ctx, input) {\n${source}\n}`;
    format(wrapped, {
      parser: "babel",
      plugins: [babel, estree],
      semi: true,
      singleQuote: false,
    })
      .then((out) => {
        if (!cancelled) setCode(out.trim());
      })
      .catch(() => {
        if (!cancelled) setCode(wrapped);
      });
    return () => {
      cancelled = true;
    };
  }, [source, name, value]);

  const guardedExtensions = useMemo(() => {
    if (!editable) return [];
    if (!lockedPrefix && !lockedSuffix) return [];

    const start = lockedPrefix.length;
    const end = Math.max(start, displayCode.length - lockedSuffix.length);
    const inLockedZone = (from: number, to: number) => from < start || to > end;
    const lockMark = Decoration.mark({ class: "cm-lockedZone" });

    return [
      EditorState.transactionFilter.of((tr) => {
        if (!tr.docChanged) return tr;
        let blocked = false;
        tr.changes.iterChangedRanges((fromA, toA) => {
          if (inLockedZone(fromA, toA)) blocked = true;
        });
        return blocked ? [] : tr;
      }),
      EditorView.inputHandler.of((view, from, to, text) => {
        if (from < start || to > end) return true;
        const body = extractFunctionBody(text);
        if (!body) return false;
        view.dispatch({ changes: { from, to, insert: body } });
        return true;
      }),
      EditorView.decorations.of(
        Decoration.set(
          [
            ...(start > 0 ? [lockMark.range(0, start)] : []),
            ...(end < displayCode.length
              ? [lockMark.range(end, displayCode.length)]
              : []),
          ],
          true,
        ),
      ),
    ];
  }, [displayCode, editable, lockedPrefix, lockedSuffix]);

  return (
    <div
      className={cn(
        "max-w-full overflow-hidden rounded-2xl border",
        fill && "h-full",
      )}
    >
      <CodeMirror
        value={displayCode}
        onChange={(next) => {
          if (value !== undefined) onChange?.(next);
          else setCode(next);
        }}
        theme={theme === "dark" ? oneDark : "light"}
        extensions={[
          javascript(),
          ...(completion ? [completion] : []),
          ...(wrap ? [EditorView.lineWrapping] : []),
          ...guardedExtensions,
          EditorView.theme({
            "&": { fontSize: "12px" },
            ".cm-gutters": { fontSize: "11px" },
            ".cm-lockedZone": {
              backgroundColor: "rgba(148, 163, 184, 0.1)",
              textDecoration: "underline dotted rgba(148, 163, 184, 0.45)",
            },
          }),
        ]}
        editable={editable}
        width="100%"
        height={fill ? "100%" : undefined}
        maxHeight={fill ? undefined : "360px"}
        style={fill ? { height: "100%" } : undefined}
        basicSetup={{
          lineNumbers: true,
          foldGutter: false,
          highlightActiveLine: false,
          highlightActiveLineGutter: false,
        }}
      />
    </div>
  );
}
