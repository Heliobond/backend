import { rpcPool, rpcBreaker, getRpcStatus } from "./stellar";
import type { PoolMetrics } from "./db-pool";
import type { BreakerMetrics } from "./circuit-breaker";
import { getSourceHealth, getOutageState, getCacheStats } from "./satellite-sources";
import { getMigrationHealth } from "./migrations";
import { listFlags } from "./feature-flags";
import { pool as dbPool } from "./db";

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
  rpc_pool: PoolMetrics;
  circuit_breaker: BreakerMetrics;
  rpc_status: ReturnType<typeof getRpcStatus>;
  satellite_data: SatelliteHealthReport;
  migrations: Awaited<ReturnType<typeof getMigrationHealth>>;
  feature_flags: { loaded_count: number };
  database: { connected: boolean };
}

export async function getHealth(): Promise<HealthReport> {
  // Check PostgreSQL connectivity (#699)
  let dbConnected = false;
  try {
    await dbPool.query("SELECT 1");
    dbConnected = true;
  } catch {
    // health check should report status, not fail
  }

  return {
    status: "ok",
    uptime_seconds: Math.floor((Date.now() - startedAt) / 1000),
    started_at: new Date(startedAt).toISOString(),
    last_cron_run: lastCronRun,
    rpc_pool: rpcPool.getMetrics(),
    circuit_breaker: rpcBreaker.getMetrics(),
    rpc_status: getRpcStatus(),
    satellite_data: {
      sources: getSourceHealth(),
      cache: getCacheStats(),
      outage: getOutageState(),
    },
    migrations: await getMigrationHealth(),
    feature_flags: { loaded_count: Object.keys(listFlags()).length },
    database: { connected: dbConnected },
  };
}

export interface ReadinessReport {
  status: "ready" | "not_ready";
  checks: Record<string, boolean>;
}

export function getReadiness(): ReadinessReport {
  const rpcMetrics = rpcPool.getMetrics();
  // The pool is ready only if it currently holds at least one connection that
  // passed its last health check. `active`/`idle`/`total` are all non-negative
  // counts that stay populated even when every connection is failing, so they
  // cannot express an unhealthy pool; `healthy` drops to 0 when the RPC
  // endpoint is unreachable and the periodic health check marks connections bad.
  const rpcReady = rpcMetrics.healthy > 0;
  const outage = getOutageState();
  const satelliteReady = outage.consecutiveFailures < 3;
  const rpcCircuitReady = rpcBreaker.getState() !== "OPEN";

  // Check PostgreSQL connectivity for readiness (#699)
  // Synchronous check not possible, so we rely on pool state
  let dbReady = false;
  try {
    dbReady = dbPool.totalCount > 0;
  } catch {
    // leave false
  }

  return {
    status: dbReady && rpcReady && satelliteReady && rpcCircuitReady ? "ready" : "not_ready",
    checks: {
      database: dbReady,
      rpc_pool: rpcReady,
      satellite: satelliteReady,
      rpc_circuit: rpcCircuitReady,
    },
  };
}
