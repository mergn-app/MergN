import { connect, type NatsConnection } from "@nats-io/transport-node";
import {
  jetstream,
  jetstreamManager,
  type JetStreamClient,
  type JetStreamManager,
} from "@nats-io/jetstream";

export interface NatsCtx {
  nc: NatsConnection;
  js: JetStreamClient;
  jsm: JetStreamManager;
}

export async function connectNats(url: string): Promise<NatsCtx | null> {
  if (!url) return null;
  const nc = await connect({ servers: url });
  const jsm = await jetstreamManager(nc);
  const js = jetstream(nc);
  return { nc, js, jsm };
}

export async function initSchedulerStream(
  ctx: NatsCtx,
  name: string,
  subjectPrefix: string,
  replicas: number,
): Promise<void> {
  const cfg = {
    name,
    subjects: [`${subjectPrefix}.>`],
    retention: "limits" as const,
    storage: "file" as const,
    num_replicas: replicas,
    allow_msg_schedules: true,
    allow_msg_ttl: true,
  };
  try {
    await ctx.jsm.streams.add(cfg);
  } catch {
    await ctx.jsm.streams.update(name, cfg);
  }
}

// Run-event stream: live run.started/step/done/failed events for the SSE tail
// and cross-instance delivery. Events are ephemeral (durable history lives in
// run_steps), so a short max_age bounds storage. No scheduling.
export async function initRunEventsStream(
  ctx: NatsCtx,
  name: string,
  subjectPrefix: string,
  replicas: number,
): Promise<void> {
  const cfg = {
    name,
    subjects: [`${subjectPrefix}.>`],
    retention: "limits" as const,
    storage: "file" as const,
    num_replicas: replicas,
    max_age: 300_000_000_000, // 5 min in ns — events are ephemeral
  };
  try {
    await ctx.jsm.streams.add(cfg);
  } catch {
    await ctx.jsm.streams.update(name, cfg);
  }
}
