import { z } from "zod";
import { genObject } from "./generate";
import { trace, type AgentMeta } from "../observability";

export const pollDraftZ = z.object({
  source: z
    .string()
    .describe(
      "An ES module that `export default`s `async (ctx, input) => result`, EXACTLY like a workflow func: it MUST start with `export default async (ctx, input) => {` and end with `};`. Inside it MUST: read the prior cursor from input.cursor (a string, '' on the FIRST poll); read any config from input.<param> (e.g. input.channelId); fetch the latest items via ctx.connections.<provider>.<method>(...); and `return { items: [...], cursor: '<newCursor>' }`. items = ONLY items newer than input.cursor, each a flat object that becomes one workflow run (oldest first). cursor = the newest item id/timestamp seen, as a string. On the FIRST poll (input.cursor === '') do NOT return historical items — set cursor to the newest id and return items: []. Compare ids numerically when they are numeric.",
    ),
  dependencies: z
    .array(z.string())
    .default([])
    .describe("npm packages the source imports directly; empty if none"),
  params: z
    .array(z.string())
    .default([])
    .describe(
      "the input.<param> names (besides cursor) the source needs the user to supply, e.g. ['channelId']. Empty array if none.",
    ),
  itemFields: z
    .array(z.string())
    .default([])
    .describe(
      "the field names present on EACH object in `items` — these become the workflow's trigger input, read by the steps as input.<field>. Use flat, clear names, e.g. ['content','authorUsername','channelId','messageId','timestamp']. The workflow steps will read exactly these names, so keep them stable and descriptive.",
    ),
});

const POLL_SYSTEM = [
  "You write a POLLING source for a workflow trigger: an ES module that `export default`s `async (ctx, input) => result`, EXACTLY like a workflow func. Start with `export default async (ctx, input) => {` and end with `};`. It checks a service for NEW items since the last poll.",
  "Contract: read input.cursor (string, '' on first poll) and any input.<param> you declare; call ctx.connections.<provider>.<method>(...) for the service (never a raw token); return { items, cursor }.",
  "items = ONLY the items newer than input.cursor, each a plain object (each becomes one workflow run, oldest first). cursor = the newest id/timestamp seen, as a string.",
  "FIRST poll (input.cursor === ''): seed cursor to the newest id and return items: [] — never replay history.",
  "Use ONLY the provider's documented methods. Read config such as a channel id from input.<param> and declare those param names.",
  "Each object in `items` MUST be a FLAT object with clear, useful field names (e.g. content, authorUsername, channelId, messageId, timestamp) — NOT the raw nested API response. List those exact field names in `itemFields`; the workflow steps will read input.<field> using them.",
].join("\n");

export async function authorPollSource(
  provider: string,
  apiDoc: string,
  intent: string,
  meta?: AgentMeta,
): Promise<z.infer<typeof pollDraftZ>> {
  return genObject({
    schema: pollDraftZ,
    system: POLL_SYSTEM,
    telemetry: trace("author-poll-source", { ...meta, provider }),
    prompt: [
      `Provider: ${provider}. API: ${apiDoc}`,
      `What to watch and what counts as new: ${intent}`,
    ].join("\n\n"),
  });
}
