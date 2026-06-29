export type BatchStatus = "queued" | "running" | "completed" | "failed";

export interface BatchResult {
  project_id: number;
  tx_hash?: string;
  credit_quality?: number;
  green_impact?: number;
  error?: string;
  skipped?: boolean;
  skip_reason?: string;
}

export interface BatchJob {
  id: string;
  status: BatchStatus;
  project_ids: number[];
  concurrency: number;
  created_at: string;
  started_at?: string;
  completed_at?: string;
  progress: { done: number; total: number };
  results: BatchResult[];
  errors: BatchResult[];
}

const jobs = new Map<string, BatchJob>();

const JOB_TTL_MS = 3_600_000;
let lastCleanup = Date.now();

function cleanupExpiredJobs(): void {
  const now = Date.now();
  if (now - lastCleanup < 60_000) return;
  lastCleanup = now;
  for (const [id, job] of jobs) {
    if (job.completed_at) {
      const age = now - new Date(job.completed_at).getTime();
      if (age > JOB_TTL_MS) {
        jobs.delete(id);
      }
    }
  }
}

export function createJob(projectIds: number[], concurrency: number): BatchJob {
  cleanupExpiredJobs();
  const job: BatchJob = {
    id: `batch_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    status: "queued",
    project_ids: projectIds,
    concurrency,
    created_at: new Date().toISOString(),
    progress: { done: 0, total: projectIds.length },
    results: [],
    errors: [],
  };
  jobs.set(job.id, job);
  return job;
}

export function getJob(id: string): BatchJob | undefined {
  return jobs.get(id);
}

export async function runJob(
  job: BatchJob,
  processor: (projectId: number) => Promise<BatchResult>,
): Promise<void> {
  job.status = "running";
  job.started_at = new Date().toISOString();

  const queue = [...job.project_ids];
  let active = 0;

  await new Promise<void>((resolve) => {
    function next(): void {
      while (active < job.concurrency && queue.length > 0) {
        const id = queue.shift()!;
        active++;
        processor(id).then((result) => {
          if (result.error) {
            job.errors.push(result);
          } else {
            job.results.push(result);
          }
          job.progress.done++;
          active--;
          next();
        });
      }
      if (active === 0 && queue.length === 0) resolve();
    }
    next();
  });

  job.status = job.errors.length === job.project_ids.length ? "failed" : "completed";
  job.completed_at = new Date().toISOString();
}
