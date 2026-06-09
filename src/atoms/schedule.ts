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
  createdAt: string;
  updatedAt: string;
}
