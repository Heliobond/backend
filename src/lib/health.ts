/**
 * Lightweight process/health state. Tracks server start time and the most
 * recent cron execution so `/health` can report basic operational visibility.
 */

const startedAt = Date.now();

export type CronStatus = "success" | "error";

export interface CronRun {
  name: string;
  status: CronStatus;
  at: string; // ISO 8601
}

let lastCronRun: CronRun | null = null;

/** Record the outcome of a cron tick. Called by the schedulers in index.ts. */
export function recordCronRun(name: string, status: CronStatus): void {
  lastCronRun = { name, status, at: new Date().toISOString() };
}

export interface HealthReport {
  status: "ok";
  uptime_seconds: number;
  started_at: string;
  last_cron_run: CronRun | null;
}

export function getHealth(): HealthReport {
  return {
    status: "ok",
    uptime_seconds: Math.floor((Date.now() - startedAt) / 1000),
    started_at: new Date(startedAt).toISOString(),
    last_cron_run: lastCronRun,
  };
}
