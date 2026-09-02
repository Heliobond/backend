import dotent from "dotenv";

dotenv.config();

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing required environment variable: ${name}. See .env.example for reference.`,
    );
  }
  return value;
}

function optionalEnv(name: string, fallback: string): string {
  return process.env[name] || fallback;
}

function numEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = parseInt(raw, 10);
  if (isNaN(parsed)) {
    throw new Error(`Environment variable ${name} must be a number, got: "${raw}"`);
  }
  return parsed;
}

function floatEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = parseFloat(raw);
  if (isNaN(parsed)) {
    throw new Error(`Environment variable ${name} must be a number, got: "${raw}"`);
  }
  return parsed;
}

function validateEnvValue(name: string, value: string, allowedValues?: readonly string[]): void {
  if (!allowedValues || !value) return;
  if (!allowedValues.includes(value)) {
    throw new Error(
      `Environment variable ${name} must be one of: ${allowedValues.join(", ")}, got "${value}".`,
    );
  }
}

/** The Stellar networks this service knows how to talk to. */
export type StellarNetwork = "testnet" | "mainnet";

export const STELLAR_NETWORKS: readonly StellarNetwork[] = ["testnet", "mainnet"];

/**
 * Narrowing guard for STELLAR_NETWORK. Written as explicit comparisons so the
 * check is a real runtime validation and TypeScript can derive the narrowed
 * type without an assertion.
 */
export function isStellarNetwork(value: string): value is StellarNetwork {
  return value === "testnet" || value === "mainnet";
}

/**
 * Read a network-valued env var. An unset or unrecognised value falls back to
 * `fallback` so importing this module never throws. `validateRequiredEnv` is
 * what turns a misconfigured value into a startup error.
 */
function networkEnv(name: string, fallback: StellarNetwork): StellarNetwork {
  const raw = process.env[name];
  if (!raw) return fallback;
  return isStellarNetwork(raw) ? raw : fallback;
}

export const config = {
  /** Stellar / Soroban */
  STELLAR_NETWORK: networkEnv("STELLAR_NETWORK", "testnet"),
  ADMIN_SECRET_KEY: process.env.ADMIN_SECRET_KEY || "",
  PROJECT_REGISTRY_CONTRACT_ID: process.env.PROJECT_REGISTRY_CONTRACT_ID || "",
  RPC_URL: optionalEnv("RPC_URL", "https://soroban-testnet.stellar.org"),

  /** HTTP server */
  PORT: numEnv("PORT", 3001),
  FRONTEND_URL: optionalEnv("FRONTEND_URL", "http://localhost:3000"),
  ADMIN_API_KEY: process.env.ADMIN_API_KEY || "",
  WS_AUTH_TOKEN: process.env.WS_AUTH_TOKEN || "",

  /** Database connection */
  DB_HOST: optionalEnv("DB_HOST", "localhost"),
  DB_PORT: numEnv("DB_PORT", 5432),
  DB_NAME: optionalEnv("DB_NAME", ""),
  DB_USER: optionalEnv("DB_USER", "postgres"),
  DB_PASSWORD: optionalEnv("DB_PASSWORD", ""),

  /** Connection pool */
  DB_POOL_MIN: numEnv("DB_POOL_MIN", 2),
  DB_POOL_MAX: numEnv("DB_POOL_MAX", 10),
  DB_POOL_ACQUIRE_TIMEOUT_MS: numEnv("DB_POOL_ACQUIRE_TIMEOUT_MS", 5000),
  DB_POOL_HEALTH_CHECK_INTERVAL_MS: numEnv("DB_POOL_HEALTH_CHECK_INTERVAL_MS", 30000),

  /** Circuit breaker */
  RPC_BREAKER_FAILURE_THRESHOLD: numEnv(
    "CIRCUIT_BREAKER_THRESHOLD",
    numEnv("RPC_BREAKER_FAILURE_THRESHOLD", 5),
  ),
  RPC_BREAKER_RECOVERY_TIMEOUT_MS: numEnv(
    "CIRCUIT_BREAKER_COOLDOWN_MS",
    numEnv("RPC_BREAKER_RECOVERY_TIMEOUT_MS", 30000),
  ),

  /** Transaction retries */
  TX_MAX_RETRIES: numEnv("TX_MAX_RETRIES", 4),
  TX_RETRY_BASE_DELAY_MS: numEnv("TX_RETRY_BASE_DELAY_MS", 200),
  TX_RETRY_MAX_DELAY_MS: numEnv("TX_RETRY_MAX_DELAY_MS", 10000),

  /** Stellar transaction polling */
  POLL_INTERVAL_MS: numEnv("POLL_INTERVAL_MS", 1500),
  POLL_MAX_ATTEMPT_PS: numEnv("POLL_MAX_ATTEMPTS_PS", 20),

  /** Stellar transaction timeout (seconds) */
  TX_TIMEOUT_SECONDS: numEnv("TX_TIMEOUT_SECONDS", 30),

  /** IoT max power output (kW) */
  MAX_POWER_KW: numEnv("MAX_POWER_KW", 1000),

  /** Idempotency */
  IDEMPOTENCY_TTL_MS: numEnv("IDEMPOTENCY_TTL_MS", 3_600_000),

  /** Cron */
  CRON_TIMEZONE: optionalEnv("CRON_TIMEZONE, "UTC"),
  CRON_FAILURE_THRESHOLD: floatEnv("CRON_FAILURE_THRESHOLD", 0.5),

  /** Graceful shutdown */
  SHUTDOWN_TIMEOUT_MS: numEnv("SHUTDOWN_TIMEOUT_MS", 30000),

  /** Logging */
  LOG_LEVEL: optionalEnv("LOG_LEVEL", ""),
  NODE_ENV: optionalEnv("NODE_ENV", "development"),

  /** Rate limiting */
  RATE_LIMIT_WINDOW_MS: numEnv("RATE_LIMIT_WINDOW_MS", 60000),
  RATE_LIMIT_MAX: numEnv("RATE_LIMIT_MAX", 100),
  RATE_LIMIT_ADMIN_WINDOW_MS: numEnv("RATE_LIMIT_ADMIN_WINDOW_MS", 60000),
  RATE_LIMIT_ADMIN_MAX: numEnv("RATE_LIMIT_ADMIN_MAX", 20),

  /** IP Whitelist */
  ADMIN_IP_WHITELIST: optionalEnv("ADMIN_IP_WHITELIST", ""),
  ADMIN_IP_WHITELIST_BYPASS_PRIVATE: optionalEnv("ADMIN_IP_WHITELIST_BYPASS_PRIVATE", "true"),

  /** Request Signing */
  REQUEST_SIGNING_SECRET: optionalEnv("REQUEST_SIGNING_SECRET", ""),

  /** APM */
  APM_PROVIDER: optionalEnv("APM_PROVIDER", "none"),

  /** CSRF */
  CORS_ORIGINS: optionalEnv("CORS_ORIGINS", ""),

  /** Body size limit */
  BODY_SIZE_LIMIT: optionalEnv("BODY_SIZE_LIMIT", "100kb"),

  /** Secrets Management */
  SECRETS_PROVIDER: optionalEnv("SECRETS_PROVIDER", "env"),
} as const;

/**
 * The shape of the resolved application configuration. Exported so consumers
 * and tests can reference the config type without re-deriving it inline.
 */
export type AppConfig = typeof config;

/**
 * Validate required environment variables at startup.
 * Call this once during server bootstrap before any routes or cron jobs.
 * Throws a clear error if any required variable is missing.
 */
export function validateRequiredEnv(): void {
  requireEnv("ADMIN_SECRET_KEY");
  requireEnv("PROJECT_REGISTRY_CONTRACT_ID");
  // Read the raw value rather than config.STELLAR_NETWORK: the config object is
  // built once at import time and coerces unknown values to the default, so
  // validating it would never see a bad value.
  validateEnvValue("STELLAR_NETWORK", process.env.STELLAR_NETWORK || "", STELLAR_NETWORKS);
}

/**
 * Backward-compatible initializer used by src/index.ts.
 * Loads dotenv, validates required vars, and returns the config object.
 */
export function initEnv() {
  validateRequiredEnv();
  // Initialize API key roles from environment variables
  // This must be called before any routes that use role-based auth
  const { loadApiKeysFromEnv } = require("./lib/apiKeyRoles");
  loadApiKeysFromEnv();

  return {
    ...config,
    ADMIN_SECRET_KEY: process.env.ADMIN_SECRET_KEY || config.ADMIN_SECRET_KEY,
    PROJECT_REGISTRY_CONTRACT_ID:
      process.env.PROJECT_REGISTRY_CONTRACT_ID || config.PROJECT_REGISTRY_CONTRACT_ID,
  };
}
