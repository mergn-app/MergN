export type TriggerType = "schedule" | "poll";

export interface ScheduledJob {
  jobId: string;
  spaceId: string;
  workflowId: string;
  triggerId: string;
  triggerType: TriggerType;
  scheduleSubject: string;
  spec: string;
  timezone?: string;
  pollProvider?: string;
  pollConnection?: string;
  cursor: string;
  active: boolean;
  lastFiredAt?: string; // last time NATS fired this job (liveness signal; NOT a config change)
  recentFires?: string[]; // last few fire times (oldest→newest) — cron cadence learning
  createdAt: string;
  updatedAt: string;
}
