import { NodeSDK } from "@opentelemetry/sdk-node";
import { LangfuseSpanProcessor } from "@langfuse/otel";

const enabled =
  !!process.env.LANGFUSE_PUBLIC_KEY && !!process.env.LANGFUSE_SECRET_KEY;

export const langfuseSpanProcessor = enabled
  ? new LangfuseSpanProcessor()
  : null;

if (langfuseSpanProcessor) {
  const sdk = new NodeSDK({ spanProcessors: [langfuseSpanProcessor] });
  sdk.start();
  console.log("[observability] Langfuse tracing enabled");
}

export interface AgentMeta {
  spaceId?: string;
  sessionId?: string;
  tags?: string[];
  [key: string]: unknown;
}

export function trace(functionId: string, meta?: AgentMeta) {
  if (!langfuseSpanProcessor) return { isEnabled: false as const };
  const { spaceId, sessionId, tags, ...rest } = meta ?? {};
  return {
    isEnabled: true as const,
    functionId,
    metadata: {
      ...(spaceId ? { userId: spaceId } : {}),
      ...(sessionId ? { sessionId } : {}),
      ...(tags ? { tags } : {}),
      ...rest,
    },
  };
}

export async function flushTraces(): Promise<void> {
  if (langfuseSpanProcessor) await langfuseSpanProcessor.forceFlush();
}
