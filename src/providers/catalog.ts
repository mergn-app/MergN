import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// The trusted, web-verified service catalog (see catalog.json). It GROUNDS the AI
// workflow planner and provider authoring so the model uses real services with
// correct hosts/auth instead of inventing fake ones. Loaded once at module init.
export interface CatalogEntry {
  id: string;
  name: string;
  keywords: string[];
  auth: string;
  // A single host, OR a list when the service splits API/upload/content/CDN
  // across sibling domains (e.g. ["box.com","boxcloud.com"]). null = per-tenant.
  egressHost: string | string[] | null;
  docsUrl: string;
  confidence: string; // "high" | "needs-verify" | "deprecated"
  note?: string; // human-readable caveat shown in the UI for non-"high" entries
  // Present only for services wired to the platform's central OAuth (managed/prod).
  // Lets the user click "Connect" instead of pasting a token/key. clientId/secret
  // come from env (clientIdEnv/clientSecretEnv) so they live only in prod.
  oauth?: {
    authUrl: string;
    tokenUrl: string;
    scopes: string[];
    clientIdEnv: string;
    clientSecretEnv: string;
    authParams?: Record<string, string>;
    tokenAuthStyle?: "body" | "basic";
  };
}

const __dir = dirname(fileURLToPath(import.meta.url));
const raw = JSON.parse(readFileSync(join(__dir, "catalog.json"), "utf8")) as {
  providers: CatalogEntry[];
};
const ENTRIES: CatalogEntry[] = raw.providers;
const BY_ID = new Map(ENTRIES.map((e) => [e.id, e]));

export function catalogSize(): number {
  return ENTRIES.length;
}

export function allCatalogEntries(): CatalogEntry[] {
  return ENTRIES;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

// Resolve a planner-named provider id to a catalog entry: exact id, then a
// normalized match (google-sheets / googlesheets -> google_sheets), then a
// name/keyword match. Returns undefined when nothing in the catalog fits.
export function resolveCatalog(id: string): CatalogEntry | undefined {
  if (BY_ID.has(id)) return BY_ID.get(id);
  const n = norm(id);
  for (const e of ENTRIES) {
    if (norm(e.id) === n || norm(e.name) === n) return e;
  }
  for (const e of ENTRIES) {
    if (e.keywords.some((k) => norm(k) === n)) return e;
  }
  return undefined;
}

// Relevance-filter the catalog against a free-text goal. Only the matched subset
// is injected into the planner prompt (keeps token cost low); the deterministic
// gate in designWorkflow still checks the FULL catalog via resolveCatalog.
export function catalogCandidates(goal: string, limit = 40): CatalogEntry[] {
  const terms = goal
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 2);
  if (terms.length === 0) return [];
  const scored = ENTRIES.filter((e) => e.confidence !== "deprecated").map((e) => {
    const hay = `${e.id} ${e.name} ${e.keywords.join(" ")}`.toLowerCase();
    let score = 0;
    for (const t of terms) if (hay.includes(t)) score += 1;
    return { e, score };
  });
  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => s.e);
}

// Compact lines for the planner prompt: `id — Name (keywords)`. No auth/host/docs
// here — those are looked up per-id at authoring time, never in the planner call.
export function catalogListForPrompt(entries: CatalogEntry[]): string {
  return entries
    .map((e) => `${e.id} — ${e.name} (${e.keywords.slice(0, 4).join(", ")})`)
    .join("\n");
}

// Grounding hint handed to authorProvider so the generated client targets the
// service's REAL API surface (host/auth/docs) instead of a hallucinated one.
export function catalogAuthorHint(e: CatalogEntry, useOAuth = false): string {
  const hostStr = Array.isArray(e.egressHost)
    ? e.egressHost.join(", ")
    : e.egressHost;
  const host = hostStr
    ? `Fixed public API host(s): ${hostStr} — all requests go to these.`
    : `Host is per-tenant/region: derive it from the user's credential (use sandbox.egressFromField), do not hardcode one.`;
  const authLine = useOAuth
    ? `Auth: OAuth2 handled by the platform — use Authorization: Bearer \${cred.accessToken}; declare NO credential fields.`
    : `Credential method (this system has NO interactive OAuth redirect): ${e.auth}.`;
  return [
    `This is the real, known public service "${e.name}" (id: ${e.id}). Use its ACTUAL documented REST API — correct base URL, endpoints, and method names.`,
    `Official API reference: ${e.docsUrl}`,
    authLine,
    host,
    `Do NOT invent endpoints, hostnames, or methods. If unsure of an endpoint, use the most standard documented one for this service.`,
  ].join("\n");
}
