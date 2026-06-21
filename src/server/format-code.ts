import * as prettier from "prettier";

// Beautify AI-generated step code (a func's bodySource) right after it is
// generated — so the stored/applied code, and the diff that shows it, is always
// cleanly formatted instead of whatever single-line shape the model emitted.
// Best-effort: invalid/unparseable code is returned unchanged (never throws).
export async function formatBodySource(code: string | undefined): Promise<string | undefined> {
  if (!code || !code.trim()) return code;
  try {
    const out = await prettier.format(code, {
      parser: "babel",
      semi: true,
      singleQuote: false,
      printWidth: 80,
    });
    return out.replace(/\n$/, ""); // drop prettier's trailing newline
  } catch {
    return code; // mid-edit / non-JS → leave as-is
  }
}

// Format every func's bodySource in a list (used at the persist + propose
// chokepoints). Funcs are opaque (`unknown`) at these layers; items without a
// string bodySource pass through untouched.
export async function formatFuncsCode(funcs: readonly unknown[]): Promise<unknown[]> {
  return Promise.all(
    funcs.map(async (f) => {
      const fn = f as { bodySource?: unknown };
      return fn && typeof fn.bodySource === "string"
        ? { ...fn, bodySource: await formatBodySource(fn.bodySource) }
        : f;
    }),
  );
}
