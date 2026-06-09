import type { DocStore } from "./docstore";
import type { ScheduledJob } from "../atoms/index";

const COLLECTION = "schedules";

export interface ScheduleStore {
  upsert(job: ScheduledJob): Promise<void>;
  get(spaceId: string, jobId: string): Promise<ScheduledJob | null>;
  findByWorkflow(spaceId: string, workflowId: string): Promise<ScheduledJob[]>;
  listBySpace(spaceId: string): Promise<ScheduledJob[]>;
  updateCursor(spaceId: string, jobId: string, cursor: string): Promise<void>;
  setActive(spaceId: string, jobId: string, active: boolean): Promise<void>;
  remove(spaceId: string, jobId: string): Promise<void>;
}

export function createScheduleStore(store: DocStore): ScheduleStore {
  async function get(spaceId: string, jobId: string): Promise<ScheduledJob | null> {
    return (await store.get(spaceId, COLLECTION, jobId)) as ScheduledJob | null;
  }

  async function put(job: ScheduledJob): Promise<void> {
    await store.put(
      job.spaceId,
      COLLECTION,
      job.jobId,
      { ...job, updatedAt: new Date().toISOString() } as unknown as Record<string, unknown>,
    );
  }

  return {
    get,

    async upsert(job) {
      await put(job);
    },

    async findByWorkflow(spaceId, workflowId) {
      const docs = (await store.list(spaceId, COLLECTION)) as unknown as ScheduledJob[];
      return docs.filter((j) => j.workflowId === workflowId);
    },

    async listBySpace(spaceId) {
      return (await store.list(spaceId, COLLECTION)) as unknown as ScheduledJob[];
    },

    async updateCursor(spaceId, jobId, cursor) {
      const job = await get(spaceId, jobId);
      if (!job) return;
      await put({ ...job, cursor });
    },

    async setActive(spaceId, jobId, active) {
      const job = await get(spaceId, jobId);
      if (!job) return;
      await put({ ...job, active });
    },

    async remove(spaceId, jobId) {
      await store.remove(spaceId, COLLECTION, jobId);
    },
  };
}
