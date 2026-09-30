import client from "prom-client";

const register = new client.Registry();

register.setDefaultLabels({ app: "heliobond-backend" });
client.collectDefaultMetrics({ register });

// ── HTTP metrics ────────────────────────────────────────────────────────────
export const httpRequestDuration = new client.Histogram({
  name: "http_request_duration_seconds",
  help: "Duration of HTTP requests in seconds",
  labelNames: ["method", "route", "status_code"] as const,
  buckets: [0.01, 0.05, 0.1, 0.3, 0.5, 1, 2, 5],
  registers: [register],
});

export const httpRequestsTotal = new client.Counter({
  name: "http_requests_total",
  help: "Total number of HTTP requests",
  labelNames: ["method", "route", "status_code"] as const,
  registers: [register],
});

// ── Legacy API usage (#660) ─────────────────────────────────────────────────
export const legacyApiRequestsTotal = new client.Counter({
  name: "legacy_api_requests_total",
  help: "Requests to the deprecated unversioned /api/* routes",
  labelNames: ["path"] as const,
  registers: [register],
});

// ── Stellar RPC metrics ─────────────────────────────────────────────────────
export const stellarRpcDuration = new client.Histogram({
  name: "stellar_rpc_call_duration_seconds",
  help: "Duration of Stellar RPC calls in seconds",
  labelNames: ["operation"] as const,
  buckets: [0.1, 0.5, 1, 2, 5, 10, 30],
  registers: [register],
});

export const stellarRpcTotal = new client.Counter({
  name: "stellar_rpc_calls_total",
  help: "Total Stellar RPC calls",
  labelNames: ["operation", "result"] as const,
  registers: [register],
});

// ── Cron job metrics ────────────────────────────────────────────────────────
export const cronJobDuration = new client.Histogram({
  name: "cron_job_duration_seconds",
  help: "Duration of cron job executions in seconds",
  labelNames: ["job"] as const,
  buckets: [0.5, 1, 5, 10, 30, 60, 300],
  registers: [register],
});

export const cronJobTotal = new client.Counter({
  name: "cron_job_runs_total",
  help: "Total cron job executions",
  labelNames: ["job", "result"] as const,
  registers: [register],
});

// ── Transaction metrics ─────────────────────────────────────────────────────
export const txSubmissionTotal = new client.Counter({
  name: "stellar_tx_submissions_total",
  help: "Total Stellar transaction submissions",
  labelNames: ["result"] as const,
  registers: [register],
});

// ── Circuit breaker metrics ─────────────────────────────────────────────────
export const circuitBreakerState = new client.Gauge({
  name: "circuit_breaker_state",
  help: "Circuit breaker state (0=CLOSED, 1=HALF_OPEN, 2=OPEN)",
  labelNames: ["name"] as const,
  registers: [register],
});

// ── Oracle SLO metrics ──────────────────────────────────────────────────────
export const oracleScoreAge = new client.Gauge({
  name: "oracle_score_age_seconds",
  help: "Age of the last score update for a project (seconds since last_update_timestamp)",
  labelNames: ["project_id"] as const,
  registers: [register],
});

export const oracleSignerBalance = new client.Gauge({
  name: "oracle_signer_balance_xlm",
  help: "Oracle signer account balance in XLM",
  registers: [register],
});

export const registryPaused = new client.Gauge({
  name: "registry_paused",
  help: "Registry paused state (0=active, 1=paused)",
  registers: [register],
});

export const oracleSubmitLatency = new client.Histogram({
  name: "oracle_submit_to_confirm_latency_seconds",
  help: "Time from transaction submission to confirmation",
  labelNames: ["result"] as const,
  buckets: [0.5, 1, 2, 5, 10, 15, 30, 60],
  registers: [register],
});

// ── Frontend telemetry (#770) ───────────────────────────────────────────────
// Ingested by `POST /v1/telemetry`. Labels are restricted to the validated
// schema fields so a report can never smuggle PII (or unbounded cardinality)
// into the time series.
export const frontendErrorsTotal = new client.Counter({
  name: "frontend_errors_total",
  help: "Frontend error reports by kind and decoded Soroban contract error name",
  labelNames: ["kind", "contract_error_name"] as const,
  registers: [register],
});

export const frontendWebVital = new client.Histogram({
  name: "frontend_web_vital",
  help: "Frontend Web Vitals measurements by metric name and rating",
  labelNames: ["name", "rating"] as const,
  buckets: [50, 100, 200, 500, 1000, 2000, 3000, 5000, 10000, 30000],
  registers: [register],
});

export { register };
