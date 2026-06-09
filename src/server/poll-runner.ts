import type { FuncContext, FuncDefinition } from "../atoms/index";
import type { Registry } from "../providers/registry";
import type { Connections } from "./connections";
import { createRuntime, buildProviderCarrier } from "./run";

export interface PollSource {
  source: string;
  dependencies?: string[];
  provider?: string;
  connection?: string;
  params?: Record<string, unknown>;
}

export interface PollOutput {
  items: Record<string, unknown>[];
  cursor: string;
}

export interface PollRunner {
  run(spaceId: string, poll: PollSource, cursor: string): Promise<PollOutput>;
}

export interface PollRunnerDeps {
  registry: Registry;
  connections: Connections;
}

export function createPollRunner(deps: PollRunnerDeps): PollRunner {
  return {
    async run(spaceId, poll, cursor) {
      const connections: Record<string, unknown> = {};
      if (poll.provider) {
        const carrier = await buildProviderCarrier(
          { spaceId, registry: deps.registry, connections: deps.connections },
          poll.provider,
          poll.connection,
        );
        if (carrier) connections[poll.provider] = carrier;
      }

      const def = {
        body: { source: poll.source, dependencies: poll.dependencies ?? [] },
      } as unknown as FuncDefinition;
      const ctx: FuncContext = {
        idempotencyKey: `poll:${spaceId}:${cursor}`,
        connections,
      };

      const value = await createRuntime().run(def, ctx, {
        cursor,
        ...(poll.params ?? {}),
      });
      const out = (value ?? {}) as { items?: unknown; cursor?: unknown };
      const items = Array.isArray(out.items)
        ? (out.items as Record<string, unknown>[])
        : [];
      const newCursor = typeof out.cursor === "string" ? out.cursor : cursor;
      return { items, cursor: newCursor };
    },
  };
}
