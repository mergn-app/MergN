// Pure, LLM-free helpers that derive a step's input/output ports from its body
// source. Kept in their own module (no LLM/provider imports) so the MCP server
// can reuse them without pulling in the whole designer/LLM stack.

export function splitTopLevel(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of s) {
    if (ch === "{" || ch === "[" || ch === "(") depth++;
    else if (ch === "}" || ch === "]" || ch === ")") depth--;
    if (ch === "," && depth === 0) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

// Output field names a step actually returns — top-level keys of its
// `return { ... }` object(s).
export function extractOutputs(src: string): string[] {
  const keys = new Set<string>();
  const parseAt = (braceIdx: number) => {
    let depth = 0;
    let k = braceIdx;
    for (; k < src.length; k++) {
      if (src[k] === "{") depth++;
      else if (src[k] === "}") {
        depth--;
        if (depth === 0) {
          k++;
          break;
        }
      }
    }
    const inner = src.slice(braceIdx + 1, k - 1);
    for (const part of splitTopLevel(inner)) {
      const raw = part.split(":")[0].trim().replace(/^\.\.\./, "").trim();
      const km = raw.match(/^["'`]?([A-Za-z_$][\w$]*)["'`]?$/);
      if (km) keys.add(km[1]);
    }
  };
  // block-body returns: `return { ... }` (safe — does not match nested map
  // callbacks like `rows.map(r => ({...}))`).
  const reRet = /\breturn\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = reRet.exec(src))) parseAt(reRet.lastIndex - 1);
  // the single implicit object return of the exported default arrow:
  // `export default async (ctx, input) => ({ ... })` — targeted so a nested
  // `=> ({...})` inside the body is NOT mistaken for the step's output.
  const imp = /export\s+default\s+(?:async\s+)?(?:function\b[^(]*)?\([^)]*\)\s*=>\s*\(\s*\{/.exec(src);
  if (imp) parseAt(imp.index + imp[0].length - 1);
  return [...keys];
}

// Input field names that are an UPLOADED FILE, by how the body reads them
// (input.x.base64 / .mime / .content_type — the injected file shape).
export function extractFileInputs(src: string): string[] {
  const set = new Set<string>();
  for (const m of src.matchAll(
    /\binput\.([A-Za-z_$][\w$]*)\.(?:base64|mime|content_type|contentType)\b/g,
  ))
    set.add(m[1]);
  return [...set];
}

// All input field names the body reads: input.x, input["x"], const {x} = input.
export function extractInputs(src: string): string[] {
  const set = new Set<string>();
  for (const m of src.matchAll(/\binput\.([A-Za-z_$][\w$]*)/g)) set.add(m[1]);
  for (const m of src.matchAll(/\binput\s*\[\s*["'`]([^"'`]+)["'`]\s*\]/g))
    set.add(m[1]);
  for (const m of src.matchAll(
    /(?:const|let|var)\s*\{([^}]*)\}\s*=\s*input\b/g,
  ))
    addDestructured(set, m[1]);
  // signature destructuring of the 2nd parameter: `(ctx, { a, b }) => ...` —
  // a very natural way to write a step that otherwise derived ZERO ports (the
  // body never says `input.x`). First param must be a plain identifier (ctx).
  const sig =
    /export\s+default\s+(?:async\s+)?(?:function\b[^(]*)?\(\s*[A-Za-z_$][\w$]*\s*,\s*\{([^}]*)\}/.exec(
      src,
    );
  if (sig) addDestructured(set, sig[1]);
  return [...set];
}

function addDestructured(set: Set<string>, inner: string): void {
  for (const part of inner.split(",")) {
    const key = part.trim().split(":")[0].split("=")[0].trim();
    if (key && !key.startsWith("...") && /^[A-Za-z_$][\w$]*$/.test(key))
      set.add(key);
  }
}
