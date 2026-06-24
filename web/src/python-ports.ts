import type { AuthoredFunc } from "./types";

export type PortType = "string" | "number" | "boolean" | "array" | "file" | "object";

interface ParsedField {
  name: string;
  type: PortType;
  required: boolean;
}

interface TypedDictDef {
  fields: ParsedField[];
}

function stripComments(line: string): string {
  const i = line.indexOf("#");
  return i >= 0 ? line.slice(0, i) : line;
}

function normalizeOptional(
  raw: string,
): { base: string; optional: boolean } {
  let t = raw.trim();
  let optional = false;
  if (/\bNone\b/.test(t) && (/\bUnion\s*\[/.test(t) || t.includes("|"))) {
    optional = true;
    t = t
      .replace(/\bNone\b\s*\|\s*/g, "")
      .replace(/\|\s*\bNone\b/g, "")
      .replace(/\bUnion\s*\[([^\]]*?)\]/g, (_, inner: string) => {
        const parts = inner
          .split(",")
          .map((p) => p.trim())
          .filter((p) => p && p !== "None");
        return parts[0] ?? "Any";
      });
  }
  if (/^Optional\s*\[/.test(t)) {
    optional = true;
    t = t.replace(/^Optional\s*\[([\s\S]*)\]$/, "$1");
  }
  return { base: t.trim(), optional };
}

function unwrapOne(raw: string): string {
  let t = raw.trim();
  t = t.replace(/^Annotated\s*\[([\s\S]*?),[\s\S]*\]$/, "$1");
  t = t.replace(/^Required\s*\[([\s\S]*)\]$/, "$1");
  t = t.replace(/^NotRequired\s*\[([\s\S]*)\]$/, "$1");
  return t.trim();
}

function mapPythonType(raw: string): PortType {
  let t = unwrapOne(raw);
  const opt = normalizeOptional(t);
  t = unwrapOne(opt.base);
  const lower = t.toLowerCase();

  if (
    lower.startsWith("list[") ||
    lower.startsWith("tuple[") ||
    lower.startsWith("set[") ||
    lower.startsWith("sequence[") ||
    lower.startsWith("iterable[")
  ) {
    return "array";
  }
  if (
    lower.startsWith("dict[") ||
    lower.startsWith("mapping[") ||
    lower === "dict" ||
    lower === "mapping" ||
    lower === "any" ||
    lower === "object"
  ) {
    return "object";
  }
  if (lower === "int" || lower === "float" || lower === "decimal") return "number";
  if (lower === "bool") return "boolean";
  if (lower === "str" || lower.startsWith("literal[")) return "string";
  if (lower.includes("file")) return "file";
  return "object";
}

function parseTypedDicts(source: string): Map<string, TypedDictDef> {
  const out = new Map<string, TypedDictDef>();
  const re =
    /class\s+([A-Za-z_]\w*)\s*\(\s*TypedDict(?:\s*,\s*total\s*=\s*(True|False))?\s*\)\s*:\s*\n([\s\S]*?)(?=\nclass\s+[A-Za-z_]\w*\s*\(|\ndef\s+[A-Za-z_]\w*\s*\(|$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) {
    const name = m[1];
    const total = m[2] !== "False";
    const block = m[3];
    const fields: ParsedField[] = [];
    for (const rawLine of block.split("\n")) {
      const line = stripComments(rawLine);
      const fm = /^\s+([A-Za-z_]\w*)\s*:\s*(.+?)\s*$/.exec(line);
      if (!fm) continue;
      const fieldName = fm[1];
      const declared = fm[2].trim();
      const explicitNotRequired = /^NotRequired\s*\[/.test(declared);
      const explicitRequired = /^Required\s*\[/.test(declared);
      const opt = normalizeOptional(declared);
      const required = explicitRequired || (!explicitNotRequired && total && !opt.optional);
      fields.push({
        name: fieldName,
        type: mapPythonType(declared),
        required,
      });
    }
    out.set(name, { fields });
  }
  return out;
}

function parseRunTypes(source: string): { inputType?: string; outputType?: string } {
  const m =
    /def\s+run\s*\(\s*ctx(?:\s*:\s*[^,)\n]+)?\s*,\s*input\s*:\s*([A-Za-z_]\w*)[^)]*\)\s*->\s*([A-Za-z_]\w*)/.exec(
      source,
    );
  if (!m) return {};
  return { inputType: m[1], outputType: m[2] };
}

function extractInputRefs(source: string): string[] {
  const names = new Set<string>();
  for (const m of source.matchAll(/\binput\.([A-Za-z_]\w*)\b/g)) names.add(m[1]);
  return [...names];
}

function extractReturnDictKeys(source: string): string[] {
  const keys = new Set<string>();
  const re = /\breturn\s*\{([\s\S]*?)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) {
    const body = m[1];
    for (const km of body.matchAll(/["']([A-Za-z_]\w*)["']\s*:/g)) keys.add(km[1]);
  }
  return [...keys];
}

export function deriveFuncFromPythonSource(
  current: AuthoredFunc,
  source: string,
): AuthoredFunc {
  const typedDicts = parseTypedDicts(source);
  const { inputType, outputType } = parseRunTypes(source);
  const inputShape = inputType ? typedDicts.get(inputType) : undefined;
  const outputShape = outputType ? typedDicts.get(outputType) : undefined;

  const inputByName = new Map(current.inputs.map((p) => [p.name, p]));
  const nextInputs = (inputShape?.fields ?? extractInputRefs(source).map((name) => ({
    name,
    type: inputByName.get(name)?.type as PortType | undefined ?? "string",
    required: inputByName.get(name)?.required ?? true,
  }))).map((f) => ({
    name: f.name,
    role: inputByName.get(f.name)?.role ?? "input",
    type: f.type,
    required: f.required,
  }));

  const outputFields = outputShape?.fields ?? extractReturnDictKeys(source).map((name) => ({
    name,
    type: "string" as PortType,
    required: true,
  }));
  const prevProps = (current.outputSchema.properties ?? {}) as Record<
    string,
    { type?: string }
  >;
  const props: Record<string, unknown> = {};
  for (const f of outputFields) {
    props[f.name] = { type: f.type ?? prevProps[f.name]?.type ?? "string" };
  }

  return {
    ...current,
    bodySource: source,
    inputs: nextInputs.length ? nextInputs : current.inputs,
    outputSchema:
      outputFields.length > 0
        ? {
            type: "object",
            properties: props,
            required: outputFields.filter((f) => f.required).map((f) => f.name),
          }
        : current.outputSchema,
  };
}

