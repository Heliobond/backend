import { rpcPool } from "./stellar";
import type { PoolMetrics } from "./db-pool";
import { getSourceHealth, getOutageState, getCacheStats } from "./satellite-sources";

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

export interface SatelliteHealthReport {
  sources: ReturnType<typeof getSourceHealth>;
  cache: ReturnType<typeof getCacheStats>;
  outage: ReturnType<typeof getOutageState>;
}

export interface HealthReport {
  status: "ok";
  uptime_seconds: number;
  started_at: string;
  last_cron_run: CronRun | null;
  db_pool: PoolMetrics;
  satellite_data: SatelliteHealthReport;
}

export function getHealth(): HealthReport {
  return {
    status: "ok",
    uptime_seconds: Math.floor((Date.now() - startedAt) / 1000),
    started_at: new Date(startedAt).toISOString(),
    last_cron_run: lastCronRun,
    db_pool: rpcPool.getMetrics(),
    satellite_data: {
      sources: getSourceHealth(),
      cache: getCacheStats(),
      outage: getOutageState(),
    },
  };
}

export interface ReadinessReport {
  status: "ready" | "not_ready";
  checks: Record<string, boolean>;
}

export function getReadiness(): ReadinessReport {
  const dbMetrics = rpcPool.getMetrics();
  const dbReady = dbMetrics.active >= 0;
  const outage = getOutageState();
  const satelliteReady = outage.consecutiveFailures < 3;

  return {
    status: dbReady && satelliteReady ? "ready" : "not_ready",
    checks: {
      database: dbReady,
      satellite: satelliteReady,
    },
  };
}
