// ─────────────────────────────────────────────────────────────────────────────
// SINGLE SOURCE OF TRUTH for every operational limit: plan quotas, request rate
// limits, token/cost ceilings, structural caps, file storage. Every consumer
// reads `LIMITS` — nothing else in the codebase references a limit value.
//
// VALUES LIVE IN THE DEPLOYMENT, NOT IN SOURCE. This file contains no business
// numbers: each limit comes from the env var named below (set them in the
// deployment's compose). An unset var — or self-host (ENFORCE_LIMITS off) —
// means "no cap". So the public source reveals which knobs exist, never the
// actual policy a given deployment runs.
//
// Enforcement is OFF by default: self-host runs uncapped. The managed/hosted
// deployment sets ENFORCE_LIMITS=1 and supplies the numbers via env.
// ─────────────────────────────────────────────────────────────────────────────

/** Master switch. Set ENFORCE_LIMITS=1 on the managed deployment; self-host
 *  leaves it unset and runs without any caps. */
export const ENFORCE_LIMITS = /^(1|true|yes)$/i.test(
  process.env.ENFORCE_LIMITS ?? "",
);

const UNLIMITED = -1; // quota convention: a value < 0 means "no cap"
const NO_RATE = Number.MAX_SAFE_INTEGER; // bucket so large it never trips
const NO_CAP = Number.MAX_SAFE_INTEGER; // tokens / steps / spaces / bytes: no ceiling

function envNum(name: string): number | undefined {
  const v = Number(process.env[name]);
  return Number.isFinite(v) ? v : undefined;
}

// Resolves a limit: the env value when enforcing and set, otherwise the
// "unlimited" sentinel. No hardcoded fallbacks → no policy numbers in source.
const lim = (envVar: string, unlimited: number): number => {
  if (!ENFORCE_LIMITS) return unlimited;
  return envNum(envVar) ?? unlimited;
};

export const LIMITS = {
  // ── Plan quotas, per billing month (env, -1 = unlimited) ──
  freeChats: lim("FREE_CHAT_LIMIT", UNLIMITED),
  freeTokens: lim("FREE_TOKEN_LIMIT", UNLIMITED),
  proTokens: lim("PRO_TOKEN_LIMIT", UNLIMITED),

  // ── Request rate limits (requests per minute) ──
  chatPerUserPerMin: lim("CHAT_USER_LIMIT_PER_MIN", NO_RATE),
  chatGlobalPerMin: lim("CHAT_GLOBAL_LIMIT_PER_MIN", NO_RATE),
  llmDirectPerUserPerMin: lim("LLM_DIRECT_LIMIT_PER_MIN", NO_RATE),
  hookPerMin: lim("HOOK_LIMIT_PER_MIN", NO_RATE),

  // ── Token / cost ceilings ──
  promptTokenCap: lim("PROMPT_TOKEN_CAP", NO_CAP), // one chat prompt, whole loop
  // Max output tokens PER model call (chat + every internal authoring call).
  // Output is the expensive side, so this is the biggest cost lever. `undefined`
  // = let the model use its default (no app cap) when unset / self-host.
  maxOutputTokens: ENFORCE_LIMITS ? envNum("MAX_OUTPUT_TOKENS") : undefined,
  // Deployment-wide cumulative kill-switch (0 = disabled, the safe default):
  globalTokenCap: ENFORCE_LIMITS ? (envNum("GLOBAL_TOKEN_CAP") ?? 0) : 0,

  // ── Structural caps ──
  maxPlanSteps: lim("MAX_PLAN_STEPS", NO_CAP),
  maxSpacesPerUser: lim("MAX_SPACES_PER_USER", NO_CAP),
  // Workflow version-history retention (max kept versions per workflow before
  // the oldest UNLABELED editor/chat versions are pruned; healing/restore/pinned
  // are always kept). NO_CAP / self-host = keep everything.
  versionRetentionMax: lim("VERSION_RETENTION_MAX", NO_CAP),

  // ── File storage (per-space total upload quota) ──
  maxStorageBytes: lim("MAX_STORAGE_BYTES", NO_CAP),
} as const;
