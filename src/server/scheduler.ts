import type { NatsCtx } from "./nats";
import type { ScheduleStore } from "../store/schedules";
import type { TriggerType, ScheduledJob } from "../atoms/index";
import type { SavedWorkflow, IntervalUnit, TriggerConfig } from "./store";

const TRIGGER_ID = "trigger";
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
    if (cfg.intervalValue === undefined || !cfg.intervalUnit) {
      throw new Error("schedule interval trigger missing interval");
    }
    return {
      spaceId,
      workflowId,
      triggerId: TRIGGER_ID,
      triggerType: "schedule",
      spec: `@every ${intervalToSeconds(cfg.intervalValue, cfg.intervalUnit)}s`,
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

  async function register(params: RegisterParams, force = false): Promise<void> {
    const id = jobId(params.workflowId, params.triggerId);
    const scheduleSubject = scheduleSubjectFor(id);
    const targetSubject = targetSubjectFor(id);
    const existing = await scheduleStore.get(params.spaceId, id);

    const reset =
      !existing ||
      existing.triggerType !== params.triggerType ||
      existing.pollProvider !== params.pollProvider ||
      existing.pollConnection !== params.pollConnection;

    if (
      !force &&
      existing &&
      existing.active &&
      !reset &&
      existing.spec === params.spec &&
      existing.timezone === params.timezone
    ) {
      return;
    }

    const now = new Date().toISOString();
    const cursor = reset ? "" : existing!.cursor;

    if (existing) await cancelSchedule(scheduleSubject);

    const payload = new TextEncoder().encode(
      JSON.stringify({
        jobId: id,
        spaceId: params.spaceId,
        workflowId: params.workflowId,
        triggerId: params.triggerId,
      }),
    );

    await nats.js.publish(scheduleSubject, payload, {
      schedule: {
        specification: params.spec,
        target: targetSubject,
        ttl: "5s",
        timezone: params.timezone,
      },
    });

    await scheduleStore.upsert({
      jobId: id,
      spaceId: params.spaceId,
      workflowId: params.workflowId,
      triggerId: params.triggerId,
      triggerType: params.triggerType,
      scheduleSubject,
      spec: params.spec,
      timezone: params.timezone,
      pollProvider: params.pollProvider,
      pollConnection: params.pollConnection,
      cursor,
      active: true,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
  }

  async function cancelByWorkflow(spaceId: string, workflowId: string): Promise<void> {
    const jobs = await scheduleStore.findByWorkflow(spaceId, workflowId);
    for (const job of jobs) await cancelJob(spaceId, job);
  }

  async function reconcile(
    spaceId: string,
    wf: SavedWorkflow,
    opts?: { force?: boolean },
  ): Promise<void> {
    const trigger = wf.trigger;
    const scheduling = trigger?.kind === "schedule" || trigger?.kind === "poll";
    const desiredActive = scheduling && trigger?.enabled !== false;
    const id = jobId(wf.id, TRIGGER_ID);

    const existing = await scheduleStore.findByWorkflow(spaceId, wf.id);
    for (const job of existing) {
      if (job.jobId !== id || !scheduling) await cancelJob(spaceId, job);
    }

    if (desiredActive && trigger) {
      await register(paramsFromTrigger(spaceId, wf.id, trigger), opts?.force);
    } else if (scheduling) {
      const job = existing.find((j) => j.jobId === id);
      if (job && job.active) await pauseJob(spaceId, job);
    }
  }

  return { reconcile, cancelByWorkflow };
}
