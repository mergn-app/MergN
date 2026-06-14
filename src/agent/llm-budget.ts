// Per-space LLM budget hooks. Every internal authoring call funnels through
// genObject (src/agent/generate.ts); this lets the SERVER enforce + count those
// calls without the agent layer importing the usage/billing stores (which would
// be a layering violation). The server registers the hooks at startup.
//
// - guard(spaceId): throws BEFORE a call when the space is over its token limit
//   or the deployment global cap is reached — so a runaway fan-out (a single
//   design_workflow authoring N steps + providers) stops at the quota instead of
//   spending unbounded.
// - record(spaceId, tokens): adds an internal call's tokens to the per-space
//   counter AFTER the call, so the quota reflects REAL spend (not just the outer
//   chat loop).

type Guard = (spaceId: string) => Promise<void>;
type Recorder = (spaceId: string, tokens: number) => void;

let guard: Guard | null = null;
let recorder: Recorder | null = null;

export function setLlmBudgetHooks(hooks: {
  guard: Guard;
  record: Recorder;
}): void {
  guard = hooks.guard;
  recorder = hooks.record;
}

// Throws if the space is over budget. No-op when no spaceId (e.g. a probe with
// no space context) or no hooks registered (self-host without enforcement).
export async function assertLlmBudget(spaceId?: string): Promise<void> {
  if (guard && spaceId) await guard(spaceId);
}

export function recordSpaceTokens(
  spaceId: string | undefined,
  tokens: number,
): void {
  if (recorder && spaceId && tokens > 0) recorder(spaceId, tokens);
}
