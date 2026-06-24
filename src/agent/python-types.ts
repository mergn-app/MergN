type Primitive = "string" | "number" | "boolean" | "object" | "array" | "file";

export interface PythonField {
  name: string;
  type: Primitive;
  required?: boolean;
}

function toPyType(t: Primitive): string {
  switch (t) {
    case "string":
      return "str";
    case "number":
      return "float";
    case "boolean":
      return "bool";
    case "array":
      return "list[Any]";
    case "file":
    case "object":
    default:
      return "dict[str, Any]";
  }
}

function renderTypedDict(name: string, fields: PythonField[]): string {
  const lines = fields.map((f) => {
    const py = toPyType(f.type);
    if (f.required === false) return `    ${f.name}: NotRequired[${py}]`;
    return `    ${f.name}: ${py}`;
  });
  if (lines.length === 0) lines.push("    pass");
  return `class ${name}(TypedDict):\n${lines.join("\n")}`;
}

export function ensureTypedPythonSource(
  source: string,
  inputFields: PythonField[],
  outputFields: PythonField[],
): string {
  const trimmed = source.trim();
  const hasTypedDict = /class\s+\w+\s*\(\s*TypedDict\s*\)\s*:/.test(trimmed);
  const hasTypedRun = /def\s+run\s*\([^)]*input\s*:\s*\w+[^)]*\)\s*->\s*\w+\s*:/.test(trimmed);
  if (hasTypedDict && hasTypedRun) return trimmed;

  const importLine = "from typing import Any, NotRequired, TypedDict";
  const header = [
    importLine,
    "",
    renderTypedDict("StepInput", inputFields),
    "",
    renderTypedDict("StepOutput", outputFields),
    "",
  ].join("\n");

  let body = trimmed;
  if (/def\s+run\s*\(/.test(body)) {
    body = body.replace(
      /def\s+run\s*\([^)]*\)\s*(?:->\s*[^:]+)?\s*:/,
      "def run(ctx: Any, input: StepInput) -> StepOutput:",
    );
  } else {
    body += "\n\n" + "def run(ctx: Any, input: StepInput) -> StepOutput:\n    return StepOutput()";
  }

  return `${header}${body}`.trim();
}

