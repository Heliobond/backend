import { logger } from "./logger";
import { parseContractError } from "./contractErrors";

/**
 * Batch transaction support (#54).
 *
 * This module provides concurrent batch processing for transactions.
 * When Soroban native batch transactions become available, they can be
 * integrated as a replacement for the current concurrent sequential approach.
 */

export type BatchStatus = "queued" | "running" | "completed" | "failed";

export interface BatchResult {
  project_id: number;
  tx_hash?: string;
  credit_quality?: number;
  green_impact?: number;
  error?: string;
  contract_error_name?: string;
  contract_error_code?: number;
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
 * Run a batch job using concurrent sequential processing.
 */
export async function runJob(
  job: BatchJob,
  processor: (projectId: number) => Promise<BatchResult>,
): Promise<void> {
  await runBatchSequential(job, processor);
}

/** Sequential (concurrent-limited) processing. */
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
        processor(id)
          .then((result) => {
            result.duration_ms = Date.now() - itemStart;
            if (result.error) {
              if (!result.contract_error_name) {
                const decoded = parseContractError(result.error);
                if (decoded) {
                  result.contract_error_name = decoded.name;
                  result.contract_error_code = decoded.code;
                }
              }
              job.errors.push(result);
            } else {
              job.results.push(result);
            }
            job.progress.done++;
            active--;
            next();
          })
          .catch((err) => {
            const decoded = parseContractError(err);
            job.errors.push({
              project_id: id,
              error: String(err),
              ...(decoded
                ? { contract_error_name: decoded.name, contract_error_code: decoded.code }
                : {}),
              duration_ms: Date.now() - itemStart,
            });
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
  job.status =
    job.project_ids.length > 0 && job.errors.length === job.project_ids.length
      ? "failed"
      : "completed";
  job.completed_at = new Date().toISOString();
  job.benchmark = {
    total_ms: totalMs,
    avg_ms_per_item: job.project_ids.length > 0 ? totalMs / job.project_ids.length : 0,
    throughput_per_second:
      job.project_ids.length > 0 ? (job.project_ids.length / totalMs) * 1000 : 0,
  };
}
