import type { NatsCtx } from "./nats";
import type { ScheduleStore } from "../store/schedules";
import type { TriggerType, ScheduledJob } from "../atoms/index";
import type {
  SavedWorkflow,
  IntervalUnit,
  TriggerConfig,
  PollTriggerConfig,
} from "./store";

const TRIGGER_ID = "trigger";

export function missingRequiredParams(poll: PollTriggerConfig | undefined): boolean {
  if (!poll) return false;
  const params = poll.params ?? {};
  return (poll.paramNames ?? []).some((name) => {
    const value = params[name];
    return value === undefined || value === null || value === "";
  });
}
const MIN_INTERVAL_SECONDS = 10;

interface RegisterParams {
  spaceId: string;
  workflowId: string;
  triggerId: string;
  triggerType: TriggerType;
  spec: string;
  timezone?: string;
  pollProvider?: string;
  pollConnection?: string;
}

export interface Scheduler {
  reconcile(
    spaceId: string,
    wf: SavedWorkflow,
    opts?: { force?: boolean },
  ): Promise<void>;
  cancelByWorkflow(spaceId: string, workflowId: string): Promise<void>;
  pause(spaceId: string, workflowId: string): Promise<void>;
  resume(spaceId: string, workflowId: string): Promise<void>;
  status(
    spaceId: string,
    workflowId: string,
  ): Promise<{ state: "active" | "paused" | "none" }>;
}

export interface SchedulerDeps {
  nats: NatsCtx;
  scheduleStore: ScheduleStore;
  subjectPrefix: string;
}

function intervalToSeconds(value: number, unit: IntervalUnit): number {
  const base =
    unit === "minute"
      ? value * 60
      : unit === "hour"
        ? value * 3600
        : unit === "day"
          ? value * 86400
          : value;
  return base < MIN_INTERVAL_SECONDS ? MIN_INTERVAL_SECONDS : base;
}

function normalizeCron(cron: string): string {
  const trimmed = cron.trim();
  return trimmed.split(/\s+/).length === 5 ? `0 ${trimmed}` : trimmed;
}

function paramsFromTrigger(
  spaceId: string,
  workflowId: string,
  trigger: TriggerConfig,
): RegisterParams {
  if (trigger.kind === "schedule") {
    const cfg = trigger.schedule;
    if (!cfg) throw new Error("schedule trigger missing config");
    if (cfg.mode === "cron") {
      if (!cfg.cron) throw new Error("schedule cron trigger missing cron expression");
      return {
        spaceId,
        workflowId,
        triggerId: TRIGGER_ID,
        triggerType: "schedule",
        spec: normalizeCron(cfg.cron),
        timezone: cfg.timezone,
      };
    }
    if (cfg.intervalValue === undefined) {
      throw new Error("schedule interval trigger missing interval value");
    }
    return {
      spaceId,
      workflowId,
      triggerId: TRIGGER_ID,
      triggerType: "schedule",
      spec: `@every ${intervalToSeconds(cfg.intervalValue, cfg.intervalUnit ?? "second")}s`,
    };
  }

  const cfg = trigger.poll;
  if (!cfg) throw new Error("poll trigger missing config");
  if (!cfg.provider) throw new Error("poll trigger missing provider");
  return {
    spaceId,
    workflowId,
    triggerId: TRIGGER_ID,
    triggerType: "poll",
    spec: `@every ${intervalToSeconds(cfg.intervalValue, cfg.intervalUnit)}s`,
    pollProvider: cfg.provider,
    pollConnection: cfg.connection,
  };
}

export function createScheduler(deps: SchedulerDeps): Scheduler {
  const { nats, scheduleStore, subjectPrefix } = deps;

  function jobId(workflowId: string, triggerId: string): string {
    return `${workflowId}_${triggerId}`;
  }

  function scheduleSubjectFor(id: string): string {
    return `${subjectPrefix}.job.${id}`;
  }

  function targetSubjectFor(id: string): string {
    return `${subjectPrefix}.fired.${id}`;
  }

  async function cancelSchedule(scheduleSubject: string): Promise<void> {
    await nats.js.publish(`${subjectPrefix}.stop`, new Uint8Array(0), {
      cancelSchedule: { scheduleSubject },
      ttl: "5s",
    });
  }

  async function cancelJob(spaceId: string, job: ScheduledJob): Promise<void> {
    await cancelSchedule(job.scheduleSubject);
    await scheduleStore.remove(spaceId, job.jobId);
  }

  async function pauseJob(spaceId: string, job: ScheduledJob): Promise<void> {
    await cancelSchedule(job.scheduleSubject);
    await scheduleStore.setActive(spaceId, job.jobId, false);
  }

  async function publishSchedule(job: ScheduledJob): Promise<void> {
    await cancelSchedule(job.scheduleSubject);
    const payload = new TextEncoder().encode(
      JSON.stringify({
        jobId: job.jobId,
        spaceId: job.spaceId,
        workflowId: job.workflowId,
        triggerId: job.triggerId,
      }),
    );
    await nats.js.publish(job.scheduleSubject, payload, {
      schedule: {
        specification: job.spec,
        target: targetSubjectFor(job.jobId),
        ttl: "5s",
        timezone: job.timezone,
      },
    });
  }

  async function register(
    params: RegisterParams,
    opts?: { force?: boolean; initialActive?: boolean; needsSetup?: boolean },
  ): Promise<void> {
    const id = jobId(params.workflowId, params.triggerId);
    const existing = await scheduleStore.get(params.spaceId, id);

    const reset =
      !existing ||
      existing.triggerType !== params.triggerType ||
      existing.pollProvider !== params.pollProvider ||
      existing.pollConnection !== params.pollConnection;

    if (
      !opts?.force &&
      existing &&
      existing.active &&
      !reset &&
      existing.spec === params.spec &&
      existing.timezone === params.timezone
    ) {
      return;
    }

    const now = new Date().toISOString();
    const active = opts?.needsSetup
      ? false
      : existing
        ? existing.active
        : opts?.initialActive ?? true;
    const job: ScheduledJob = {
      jobId: id,
      spaceId: params.spaceId,
      workflowId: params.workflowId,
      triggerId: params.triggerId,
      triggerType: params.triggerType,
      scheduleSubject: scheduleSubjectFor(id),
      spec: params.spec,
      timezone: params.timezone,
      pollProvider: params.pollProvider,
      pollConnection: params.pollConnection,
      cursor: reset ? "" : existing!.cursor,
      active,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };

    if (active) await publishSchedule(job);
    else await cancelSchedule(job.scheduleSubject);
    await scheduleStore.upsert(job);
  }

  async function cancelByWorkflow(spaceId: string, workflowId: string): Promise<void> {
    const jobs = await scheduleStore.findByWorkflow(spaceId, workflowId);
    for (const job of jobs) await cancelJob(spaceId, job);
  }

  async function pause(spaceId: string, workflowId: string): Promise<void> {
    const jobs = await scheduleStore.findByWorkflow(spaceId, workflowId);
    const now = new Date().toISOString();
    // pauseJob cancels the recurring schedule (no tick delivered while paused), so
    // there's nothing to count — just stamp `missedSince` for the UI's "stopped
    // since" (missed-tick count, if wanted, is derived from this against `spec`).
    for (const job of jobs) {
      await pauseJob(spaceId, job);
      await scheduleStore.upsert({ ...job, active: false, missedSince: now, updatedAt: now });
    }
  }

  async function resume(spaceId: string, workflowId: string): Promise<void> {
    const jobs = await scheduleStore.findByWorkflow(spaceId, workflowId);
    const now = new Date().toISOString();
    for (const job of jobs) {
      await publishSchedule({ ...job, active: true });
      const { missedSince: _missed, ...rest } = job;
      await scheduleStore.upsert({ ...rest, active: true, updatedAt: now });
    }
  }

  async function status(
    spaceId: string,
    workflowId: string,
  ): Promise<{ state: "active" | "paused" | "none" }> {
    const jobs = await scheduleStore.findByWorkflow(spaceId, workflowId);
    if (!jobs.length) return { state: "none" };
    return { state: jobs[0].active ? "active" : "paused" };
  }

  async function reconcile(
    spaceId: string,
    wf: SavedWorkflow,
    opts?: { force?: boolean },
  ): Promise<void> {
    const trigger = wf.trigger;
    const scheduling = trigger?.kind === "schedule" || trigger?.kind === "poll";
    const id = jobId(wf.id, TRIGGER_ID);

    const existing = await scheduleStore.findByWorkflow(spaceId, wf.id);
    for (const job of existing) {
      if (job.jobId !== id || !scheduling) await cancelJob(spaceId, job);
    }

    if (scheduling && trigger) {
      const needsSetup =
        trigger.kind === "poll" && missingRequiredParams(trigger.poll);
      await register(paramsFromTrigger(spaceId, wf.id, trigger), {
        force: opts?.force,
        initialActive: trigger.enabled !== false,
        needsSetup,
      });
    }
  }

  return { reconcile, cancelByWorkflow, pause, resume, status };
}
