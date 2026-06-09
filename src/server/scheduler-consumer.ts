import { createHash } from "node:crypto";
import type { JsMsg } from "@nats-io/jetstream";
import type { NatsCtx } from "./nats";
import type { ScheduleStore } from "../store/schedules";
import type { PollRunner } from "./poll-runner";
import type { WorkflowStore } from "./store";

export type RunSavedWorkflow = (
  spaceId: string,
  wf: {
    id: string;
    name: string;
    funcs: unknown[];
    wires: unknown[];
    config?: Record<string, Record<string, string>>;
    nodeConnections?: Record<string, Record<string, string>>;
  },
  input: Record<string, unknown>,
  trigger: string,
  runId?: string,
) => Promise<unknown>;

export interface SchedulerConsumer {
  start(): Promise<void>;
  stop(): void;
}

export interface SchedulerConsumerDeps {
  nats: NatsCtx;
  streamName: string;
  filterSubject: string;
  durableName: string;
  scheduleStore: ScheduleStore;
  pollRunner: PollRunner;
  workflows: WorkflowStore;
  runSavedWorkflow: RunSavedWorkflow;
}

interface FiredPayload {
  jobId: string;
  spaceId: string;
  workflowId: string;
  triggerId: string;
}

function formDefaults(inputForm: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const fields = (inputForm as { fields?: unknown })?.fields;
  if (!Array.isArray(fields)) return out;
  for (const field of fields) {
    const name = (field as { name?: unknown })?.name;
    const defaultValue = (field as { defaultValue?: unknown })?.defaultValue;
    if (typeof name === "string" && defaultValue !== undefined) {
      out[name] = defaultValue;
    }
  }
  return out;
}

export function createSchedulerConsumer(deps: SchedulerConsumerDeps): SchedulerConsumer {
  const {
    nats,
    streamName,
    filterSubject,
    durableName,
    scheduleStore,
    pollRunner,
    workflows,
    runSavedWorkflow,
  } = deps;

  let messages: { stop(): void } | null = null;

  async function handle(msg: JsMsg): Promise<void> {
    const payload = JSON.parse(msg.string()) as FiredPayload;
    const job = await scheduleStore.get(payload.spaceId, payload.jobId);
    if (!job || !job.active) {
      msg.ack();
      return;
    }

    const wf = await workflows.getWorkflow(payload.spaceId, job.workflowId);
    if (!wf) {
      msg.ack();
      return;
    }

    if (job.triggerType === "schedule") {
      await runSavedWorkflow(
        payload.spaceId,
        wf,
        { timestamp: new Date().toISOString(), ...formDefaults(wf.inputForm) },
        "schedule",
      );
      msg.ack();
      return;
    }

    const poll = wf.trigger?.poll;
    if (!poll?.source) {
      msg.ack();
      return;
    }

    const result = await pollRunner.run(
      payload.spaceId,
      {
        source: poll.source,
        dependencies: poll.dependencies,
        provider: poll.provider,
        connection: poll.connection,
        params: poll.params,
      },
      job.cursor,
    );

    for (const item of result.items) {
      const itemHash = createHash("sha1")
        .update(JSON.stringify(item))
        .digest("hex")
        .slice(0, 16);
      const runId = `poll-${job.jobId}-${itemHash}`;
      await runSavedWorkflow(payload.spaceId, wf, item, "poll", runId);
    }

    if (result.cursor && result.cursor !== job.cursor) {
      await scheduleStore.updateCursor(payload.spaceId, job.jobId, result.cursor);
    }
    msg.ack();
  }

  return {
    async start() {
      await nats.jsm.consumers.add(streamName, {
        durable_name: durableName,
        filter_subject: filterSubject,
        ack_policy: "explicit",
        deliver_policy: "all",
        max_deliver: 10,
      });
      const consumer = await nats.js.consumers.get(streamName, durableName);
      const iter = await consumer.consume();
      messages = iter;
      void (async () => {
        for await (const msg of iter) {
          try {
            await handle(msg);
          } catch (e) {
            console.error("scheduler fire failed", msg.subject, e);
            msg.nak();
          }
        }
      })();
    },

    stop() {
      if (messages) messages.stop();
    },
  };
}
