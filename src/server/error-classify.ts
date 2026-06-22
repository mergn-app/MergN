// Error classification. Pure, no deps. Turns a raw step/run error into a coarse
// type so downstream layers can route without re-parsing strings:
//   transient → safe to retry (no fix needed); auth → needs a reconnect;
//   logic     → a code/config fault; unknown → no confident signal.
// Pattern-match on message + optional code; deliberately conservative.

export type ErrorType = "transient" | "auth" | "logic" | "unknown";

export interface ErrorInput {
  message?: string;
  code?: string | number;
}

// Pull an HTTP-ish status code out of a message ("HTTP 503", "status: 401",
// "request failed with status code 429"). Only 4xx/5xx are meaningful.
function httpStatus(text: string): number | undefined {
  // Keyworded form is most reliable.
  const kw = text.match(/\b(?:status(?:\s*code)?|http|code)\b[^\d]{0,6}(\d{3})\b/i);
  if (kw) {
    const n = Number(kw[1]);
    if (n >= 400 && n <= 599) return n;
  }
  // A bare 4xx/5xx in an error string is almost always a status (2xx/3xx and
  // numbers with a trailing unit like "500ms" won't match here).
  const bare = text.match(/\b([45]\d\d)\b/);
  if (bare) {
    const n = Number(bare[1]);
    if (n >= 400 && n <= 599) return n;
  }
  return undefined;
}

// A function that crashed inside the (docker) code runtime — a Node stack trace,
// the runtime's "docker run failed" wrapper, or a "X.mjs:line:col" frame. This
// is integration-agnostic (every authored provider runs in the same runtime);
// when nothing more specific matches, a bare code crash is a logic/config fault,
// not "unknown".
const RUNTIME_CRASH_RE =
  /(docker run failed|Node\.js v\d|\n\s*at\s+\S|\.[mc]?js:\d+:\d+|unhandled\s+(?:promise\s+)?rejection)/i;

const AUTH_RE =
  /\b(unauthor\w*|forbidden|invalid[\s_-]*(?:api[\s_-]*key|token|credential|grant)|expired|authenticat\w*|permission[\s_-]*denied|access[\s_-]*denied|not[\s_-]*authenticated|missing[\s_-]*(?:token|credential|api[\s_-]*key)|revoked)\b/i;

const TRANSIENT_RE =
  /\b(timed?[\s_-]*out|timeout|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EPIPE|socket[\s_-]*hang[\s_-]*up|network|rate[\s_-]*limit\w*|too[\s_-]*many[\s_-]*requests|temporarily[\s_-]*unavailable|service[\s_-]*unavailable|try[\s_-]*again|overloaded|connection[\s_-]*(?:reset|closed|refused)|503|502|504)\b/i;

const LOGIC_RE =
  /\b(is[\s_-]*not[\s_-]*a[\s_-]*function|cannot[\s_-]*read[\s_-]*propert\w*|is[\s_-]*not[\s_-]*defined|undefined|null|validation|invalid[\s_-]*(?:input|argument|param\w*|json|payload|body|field|value|format|shape)|schema|unexpected[\s_-]*token|parse|syntaxerror|typeerror|referenceerror|required[\s_-]*(?:field|param\w*|propert\w*)?|missing[\s_-]*(?:field|propert\w*|argument|param\w*)|malformed|out[\s_-]*of[\s_-]*range)\b/i;

export function classifyError(input: ErrorInput | string | undefined): ErrorType {
  const message = typeof input === "string" ? input : (input?.message ?? "");
  const rawCode = typeof input === "object" && input ? input.code : undefined;
  const text = message || "";

  // Prefer an explicit numeric/HTTP code — least ambiguous signal.
  const code =
    typeof rawCode === "number"
      ? rawCode
      : typeof rawCode === "string" && /^\d{3}$/.test(rawCode)
        ? Number(rawCode)
        : httpStatus(text);

  if (code !== undefined) {
    if (code === 401 || code === 403) return "auth";
    if (code === 429 || (code >= 500 && code <= 599)) return "transient";
    if (code === 400 || code === 404 || code === 409 || code === 422)
      return "logic"; // client-side: bad request/shape — fixable
  }

  // String codes like ECONNRESET arrive in `code` too.
  const codeStr = typeof rawCode === "string" ? rawCode : "";
  if (codeStr && TRANSIENT_RE.test(codeStr)) return "transient";

  // Auth before transient: a 401 body may also say "request failed"; auth wins.
  if (AUTH_RE.test(text)) return "auth";
  if (TRANSIENT_RE.test(text)) return "transient";
  if (LOGIC_RE.test(text)) return "logic";
  // Fallback: an opaque code crash (stack trace / runtime wrapper) with no
  // specific signal is a code/config fault, not "unknown".
  if (RUNTIME_CRASH_RE.test(text)) return "logic";
  return "unknown";
}
