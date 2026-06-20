import { createHash } from "node:crypto";
import type { JsMsg } from "@nats-io/jetstream";
import type { NatsCtx } from "./nats";
import type { ScheduleStore } from "../store/schedules";
import type { PollRunner } from "./poll-runner";
import type { SavedWorkflow, WorkflowStore } from "./store";

export type RunSavedWorkflow = (
  spaceId: string,
  wf: {
    id: string;
    name: string;
    funcs: unknown[];
    wires: unknown[];
    config?: Record<string, Record<string, string>>;
    nodeConnections?: Record<string, Record<string, string>>;
    variables?: Record<string, unknown>;
  },
  input: Record<string, unknown>,
  trigger: string,
  runId?: string,
) => Promise<unknown>;

export interface SchedulerConsumer {
  start(): Promise<void>;
  stop(): void;
}

export type RecordFailure = (
  spaceId: string,
  wf: SavedWorkflow,
  trigger: string,
  error: unknown,
) => Promise<void>;

export interface SchedulerConsumerDeps {
  nats: NatsCtx;
  streamName: string;
  filterSubject: string;
  durableName: string;
  scheduleStore: ScheduleStore;
  pollRunner: PollRunner;
  workflows: WorkflowStore;
  runSavedWorkflow: RunSavedWorkflow;
  recordFailure: RecordFailure;
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

export interface FireDeps {
  pollRunner: PollRunner;
  scheduleStore: ScheduleStore;
  runSavedWorkflow: RunSavedWorkflow;
}

export async function fireWorkflow(
  deps: FireDeps,
  spaceId: string,
  wf: SavedWorkflow,
  jobId: string,
  triggerType: "schedule" | "poll",
  cursor: string,
): Promise<void> {
  if (triggerType === "schedule") {
    await deps.runSavedWorkflow(
      spaceId,
      wf,
      { timestamp: new Date().toISOString(), ...formDefaults(wf.inputForm) },
      "schedule",
    );
    return;
  }

  const poll = wf.trigger?.poll;
  if (!poll?.source) return;

  const result = await deps.pollRunner.run(
    spaceId,
    {
      source: poll.source,
      dependencies: poll.dependencies,
      provider: poll.provider,
      connection: poll.connection,
      params: poll.params,
    },
    cursor,
  );

  for (const item of result.items) {
    const itemHash = createHash("sha1")
      .update(JSON.stringify(item))
      .digest("hex")
      .slice(0, 16);
    await deps.runSavedWorkflow(spaceId, wf, item, "poll", `poll-${jobId}-${itemHash}`);
  }

  if (result.cursor && result.cursor !== cursor) {
    await deps.scheduleStore.updateCursor(spaceId, jobId, result.cursor);
  }
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
    recordFailure,
  } = deps;

  let messages: { stop(): void } | null = null;

  async function handle(msg: JsMsg): Promise<void> {
    const payload = JSON.parse(msg.string()) as FiredPayload;
    const job = await scheduleStore.get(payload.spaceId, payload.jobId);
    if (!job || !job.active) {
      msg.ack();
      return;
    }
    // Record the fire for liveness — the schedule DID fire (observed here), even
    // if the run below fails or, for polls, finds no new data. Fire-and-forget.
    void scheduleStore
      .setLastFired(payload.spaceId, payload.jobId, new Date().toISOString())
      .catch(() => {});

    const wf = await workflows.getWorkflow(payload.spaceId, job.workflowId);
    if (!wf) {
      msg.ack();
      return;
    }

    try {
      await fireWorkflow(
        { pollRunner, scheduleStore, runSavedWorkflow },
        payload.spaceId,
        wf,
        job.jobId,
        job.triggerType,
        job.cursor,
      );
    } catch (e) {
      // surface background poll/schedule failures (e.g. a bad credential) as a
      // failed run so the UI shows them; ack so the next interval tick retries
      // instead of a redelivery storm.
      await recordFailure(payload.spaceId, wf, job.triggerType, e);
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
