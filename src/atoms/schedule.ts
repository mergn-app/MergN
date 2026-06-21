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
  // Pause-stamp: when the flow was paused (= SavedWorkflow.pausedAt). Paused
  // cancels the recurring schedule, so no tick is delivered or counted — the UI
  // shows "stopped since" and (if asked) derives missed-tick count from this
  // against `spec`. Cleared on resume.
  missedSince?: string;
  lastFiredAt?: string; // last time NATS fired this job (liveness signal; NOT a config change)
  recentFires?: string[]; // last few fire times (oldest→newest) — cron cadence learning
  createdAt: string;
  updatedAt: string;
}
