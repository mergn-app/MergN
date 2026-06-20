// PII shape-masking for persisted run data. Applied BEFORE writing a step's
// resolvedInput/output/error to storage — raw PII never hits disk unless the
// deployment opts into "full". The default is deployment-aware (set by the
// caller): managed = "shape" (multi-tenant privacy), self-host = "full" (the
// operator's own data, best diagnosis). "shape" preserves structure + types so
// failure diagnosis can still see null / double-wrap / wrong-type.
export type MaskLevel = "shape" | "keys" | "full";

const MASK_LEVELS: readonly MaskLevel[] = ["shape", "keys", "full"];

// Validate a (possibly user-supplied, per-flow) mask level, falling back to the
// deployment default when absent or invalid.
export function resolveMaskLevel(value: unknown, fallback: MaskLevel): MaskLevel {
  return MASK_LEVELS.includes(value as MaskLevel) ? (value as MaskLevel) : fallback;
}

const TYPE_TAG = (v: unknown): string => {
  if (typeof v === "string") return `«string:${v.length}»`;
  if (typeof v === "number") return Number.isInteger(v) ? "«int»" : "«number»";
  if (typeof v === "boolean") return "«boolean»";
  return "«value»";
};

// "shape": recurse fully; leaf values → type tag (string keeps length); null
// preserved (distinguishable from missing); arrays recursed (length preserved).
function maskShape(v: unknown, depth = 0): unknown {
  if (v === null) return null;
  if (depth > 12) return "«…»"; // runaway-nesting guard
  if (Array.isArray(v)) return v.map((x) => maskShape(x, depth + 1));
  if (typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>))
      if (val !== undefined) out[k] = maskShape(val, depth + 1);
    return out;
  }
  return TYPE_TAG(v);
}

// "keys": object keys + types only; arrays collapsed to a length tag (not
// recursed); leaves → bare type (no string length). Maximum privacy.
function maskKeys(v: unknown, depth = 0): unknown {
  if (v === null) return null;
  if (Array.isArray(v)) return `«array:${v.length}»`;
  if (depth > 8) return "«…»";
  if (typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>))
      if (val !== undefined) out[k] = maskKeys(val, depth + 1);
    return out;
  }
  if (typeof v === "string") return "«string»";
  if (typeof v === "number") return "«number»";
  if (typeof v === "boolean") return "«boolean»";
  return "«value»";
}

export function maskValue(data: unknown, level: MaskLevel): unknown {
  if (level === "full") return data;
  if (level === "keys") return maskKeys(data);
  return maskShape(data);
}

// Error strings can embed PII (e.g. "invalid email: ahmet@x.com"). At shape/keys
// we keep the message but redact long alnum/email/number runs; full = as-is.
export function maskErrorString(err: string | undefined, level: MaskLevel): string | undefined {
  if (!err || level === "full") return err;
  return err
    .replace(/[\w.+-]+@[\w.-]+/g, "«email»")
    .replace(/\b\d[\d.,-]{3,}\b/g, "«num»");
}
