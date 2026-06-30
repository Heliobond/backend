/**
 * Batch transaction support (#54).
 *
 * Soroban native batch transactions are not yet available on mainnet.
 * This module defines the batch interface and falls back to sequential
 * processing until the capability is detected. Once Soroban exposes
 * batch support, `isSorobanBatchAvailable()` should return true and
 * `runBatchNative()` can be wired in.
 */

export type BatchStatus = "queued" | "running" | "completed" | "failed";

export interface BatchResult {
  project_id: number;
  tx_hash?: string;
  credit_quality?: number;
  green_impact?: number;
  error?: string;
  /** Wall-clock ms taken to process this item. */
  duration_ms?: number;
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
  /** Whether native Soroban batch was used (false = sequential fallback). */
  used_native_batch: boolean;
  /** Performance summary populated after completion. */
  benchmark?: BatchBenchmark;
}

export interface BatchBenchmark {
  total_ms: number;
  avg_ms_per_item: number;
  throughput_per_second: number;
}

const jobs = new Map<string, BatchJob>();

/**
 * Detect whether the connected Soroban RPC exposes native batch transaction
 * support. Currently always returns false – update this check once Soroban
 * ships the capability (monitor: https://github.com/stellar/stellar-core).
 */
export function isSorobanBatchAvailable(): boolean {
  // TODO: replace with an actual capability-detection call against the RPC
  // e.g. check server info flags or protocol version >= BATCH_PROTOCOL_VERSION
  return false;
}

export function createJob(projectIds: number[], concurrency: number): BatchJob {
  const job: BatchJob = {
    id: `batch_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    status: "queued",
    project_ids: projectIds,
    concurrency,
    created_at: new Date().toISOString(),
    progress: { done: 0, total: projectIds.length },
    results: [],
    errors: [],
    used_native_batch: false,
  };
  jobs.set(job.id, job);
  return job;
}

export function getJob(id: string): BatchJob | undefined {
  return jobs.get(id);
}

/**
 * Run a batch job.
 * Routes to `runBatchNative()` when Soroban batch is available,
 * otherwise falls back to concurrent sequential processing.
 */
export async function runJob(
  job: BatchJob,
  processor: (projectId: number) => Promise<BatchResult>,
): Promise<void> {
  if (isSorobanBatchAvailable()) {
    await runBatchNative(job, processor);
  } else {
    await runBatchSequential(job, processor);
  }
}

/**
 * Placeholder for future native Soroban batch execution.
 * Implement once the RPC exposes batch transaction support.
 */
async function runBatchNative(
  job: BatchJob,
  processor: (projectId: number) => Promise<BatchResult>,
): Promise<void> {
  // Native batch: submit all ops in a single transaction envelope.
  // Not yet available — fall back to sequential until implemented.
  console.warn("[batch] native Soroban batch detected but not yet implemented; falling back");
  await runBatchSequential(job, processor);
}

/** Sequential (concurrent-limited) fallback processing. */
async function runBatchSequential(
  job: BatchJob,
  processor: (projectId: number) => Promise<BatchResult>,
): Promise<void> {
  job.status = "running";
  job.started_at = new Date().toISOString();
  job.used_native_batch = false;

  const jobStart = Date.now();
  const queue = [...job.project_ids];
  let active = 0;

  await new Promise<void>((resolve) => {
    function next(): void {
      while (active < job.concurrency && queue.length > 0) {
        const id = queue.shift()!;
        active++;
        const itemStart = Date.now();
        processor(id).then((result) => {
          result.duration_ms = Date.now() - itemStart;
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

  const totalMs = Date.now() - jobStart;
  job.status = job.errors.length === job.project_ids.length ? "failed" : "completed";
  job.completed_at = new Date().toISOString();
  job.benchmark = {
    total_ms: totalMs,
    avg_ms_per_item: job.project_ids.length > 0 ? totalMs / job.project_ids.length : 0,
    throughput_per_second:
      job.project_ids.length > 0 ? (job.project_ids.length / totalMs) * 1000 : 0,
  };
}
