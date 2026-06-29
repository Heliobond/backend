import { rpcPool, getRpcStatus } from "./stellar";
import { getQueueSize } from "./tx-queue";
import type { PoolMetrics } from "./db-pool";

const startedAt = Date.now();

export type CronStatus = "success" | "error";

export interface CronRun {
  name: string;
  status: CronStatus;
  at: string; // ISO 8601
}

let lastCronRun: CronRun | null = null;

export function recordCronRun(name: string, status: CronStatus): void {
  lastCronRun = { name, status, at: new Date().toISOString() };
}

export interface HealthReport {
  status: "ok";
  uptime_seconds: number;
  started_at: string;
  last_cron_run: CronRun | null;
  db_pool: PoolMetrics;
  rpc: {
    available: boolean;
    consecutiveFailures: number;
    outageDurationMs: number | null;
    lastSuccessAgoMs: number;
  };
  txQueueSize: number;
}

export function getHealth(): HealthReport {
  return {
    status: "ok",
    uptime_seconds: Math.floor((Date.now() - startedAt) / 1000),
    started_at: new Date(startedAt).toISOString(),
    last_cron_run: lastCronRun,
    db_pool: rpcPool.getMetrics(),
    rpc: getRpcStatus(),
    txQueueSize: getQueueSize(),
  };
}
