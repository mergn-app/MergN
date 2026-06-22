import { createHash } from 'node:crypto'

// Idempotency dedup for effectful steps. The key is (real runId, funcId,
// eventHash). The store guarantees a given side-effect fires at most once per
// key across retries and replays — the same run id replayed reuses the recorded
// output instead of re-firing the effect (e.g. charging a card twice).
//
// The ENGINE only depends on this interface; the concrete DocStore-backed
// implementation lives in the server layer (src/server/idempotency.ts). The
// whole mechanism is dormant until a func declares a non-"none" idempotency
// mechanism — existing flows are unaffected.

export interface IdemKey {
  // The REAL run id, never the engine's internal "run". For cross-run replay
  // dedup the caller must pass the SAME stable id to both runs (the engine does
  // not invent it). Within one run id, eventHash dedups by resolved input.
  runId: string
  funcId: string
  eventHash: string
}

export interface IdempotencyStore {
  // Claims the key. Returns { claimed: true } when the caller should execute the
  // side-effect; { claimed: false, cachedOutput } when it already completed
  // (skip the side-effect and reuse the recorded output).
  claim(
    spaceId: string,
    key: IdemKey,
  ): Promise<{ claimed: boolean; cachedOutput?: unknown }>
  // Seals the key as complete, recording the side-effect's output for reuse.
  complete(spaceId: string, key: IdemKey, output: unknown): Promise<void>
}

// Stable 16-hex hash of a step's resolved input: same input ⇒ same key ⇒
// deduped. Canonical JSON (sorted object keys) so key order never changes the
// hash. Mirrors the poll-runner's itemHash (sha1 → slice(16)).
export function eventHash(resolvedInput: unknown): string {
  return createHash('sha1')
    .update(canonicalize(resolvedInput))
    .digest('hex')
    .slice(0, 16)
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object')
    return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return '[' + value.map(canonicalize).join(',') + ']'
  const obj = value as Record<string, unknown>
  return (
    '{' +
    Object.keys(obj)
      .sort()
      .map((k) => JSON.stringify(k) + ':' + canonicalize(obj[k]))
      .join(',') +
    '}'
  )
}
