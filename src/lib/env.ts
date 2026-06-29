/**
 * Startup environment validation.
 *
 * Call validateEnv() once before anything else reads process.env.
 * On failure it prints all collected errors and exits with code 1.
 *
 * Schema reference:
 *
 * Required vars (no default):
 *   ADMIN_SECRET_KEY          – Stellar secret key (S…) for signing transactions
 *   PROJECT_REGISTRY_CONTRACT_ID – Soroban contract address
 *
 * Optional vars with typed defaults:
 *   STELLAR_NETWORK           – "testnet" | "mainnet"           (default: "testnet")
 *   RPC_URL                   – URL string                      (default: https://soroban-testnet.stellar.org)
 *   STELLAR_RPC_URL           – URL string                      (default: RPC_URL)
 *   PORT                      – positive integer                (default: 3001)
 *   FRONTEND_URL              – URL string                      (default: http://localhost:3000)
 *   ADMIN_API_KEY             – string                          (optional, warn if absent in prod)
 *   WS_AUTH_TOKEN             – string                          (optional)
 *   SENDGRID_API_KEY          – string                          (optional, warn if absent)
 *   EMAIL_FROM                – string                          (default: no-reply@heliobond.dev)
 *   LOG_LEVEL                 – "error"|"warn"|"info"|"debug"   (default: "info")
 *   ETH_RPC_URL               – URL string                      (optional)
 *   ETH_CONTRACT_ADDRESS      – string                          (optional)
 *   POLYGON_RPC_URL           – URL string                      (optional)
 *   POLYGON_CONTRACT_ADDRESS  – string                          (optional)
 *   DB_POOL_MIN               – positive integer                (default: 2)
 *   DB_POOL_MAX               – positive integer                (default: 10)
 *   DB_POOL_ACQUIRE_TIMEOUT_MS– positive integer                (default: 5000)
 *   DB_POOL_HEALTH_CHECK_INTERVAL_MS – positive integer         (default: 30000)
 *   RATE_LIMIT_WINDOW_MS      – positive integer                (default: 60000)
 *   RATE_LIMIT_MAX            – positive integer                (default: 100)
 *   RATE_LIMIT_ADMIN_WINDOW_MS– positive integer                (default: RATE_LIMIT_WINDOW_MS)
 *   RATE_LIMIT_ADMIN_MAX      – positive integer                (default: 20)
 */

export interface Env {
  // Stellar / Soroban
  STELLAR_NETWORK: "testnet" | "mainnet";
  ADMIN_SECRET_KEY: string;
  PROJECT_REGISTRY_CONTRACT_ID: string;
  RPC_URL: string;
  STELLAR_RPC_URL: string;

  // HTTP server
  PORT: number;
  FRONTEND_URL: string;
  ADMIN_API_KEY: string | undefined;
  WS_AUTH_TOKEN: string | undefined;
  LOG_LEVEL: "error" | "warn" | "info" | "debug";

  // Email
  SENDGRID_API_KEY: string | undefined;
  EMAIL_FROM: string;

  // Multichain (optional integrations)
  ETH_RPC_URL: string | undefined;
  ETH_CONTRACT_ADDRESS: string | undefined;
  POLYGON_RPC_URL: string | undefined;
  POLYGON_CONTRACT_ADDRESS: string | undefined;

  // Connection pool
  DB_POOL_MIN: number;
  DB_POOL_MAX: number;
  DB_POOL_ACQUIRE_TIMEOUT_MS: number;
  DB_POOL_HEALTH_CHECK_INTERVAL_MS: number;

  // Rate limiting
  RATE_LIMIT_WINDOW_MS: number;
  RATE_LIMIT_MAX: number;
  RATE_LIMIT_ADMIN_WINDOW_MS: number;
  RATE_LIMIT_ADMIN_MAX: number;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function str(name: string, fallback?: string): string | undefined {
  const val = process.env[name];
  return val !== undefined && val !== "" ? val : fallback;
}

function requireStr(name: string, errors: string[]): string {
  const val = process.env[name];
  if (!val) {
    errors.push(`${name} is required but not set`);
    return "";
  }
  return val;
}

function posInt(name: string, fallback: number, errors: string[]): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    errors.push(`${name} must be a positive integer, got: "${raw}"`);
    return fallback;
  }
  return n;
}

function oneOf<T extends string>(
  name: string,
  allowed: readonly T[],
  fallback: T,
  errors: string[]
): T {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  if ((allowed as readonly string[]).includes(raw)) return raw as T;
  errors.push(`${name} must be one of [${allowed.join(", ")}], got: "${raw}"`);
  return fallback;
}

function url(name: string, fallback: string, errors: string[]): string {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  try {
    new URL(raw);
    return raw;
  } catch {
    errors.push(`${name} must be a valid URL, got: "${raw}"`);
    return fallback;
  }
}

function optionalUrl(name: string, errors: string[]): string | undefined {
  const raw = process.env[name];
  if (!raw) return undefined;
  try {
    new URL(raw);
    return raw;
  } catch {
    errors.push(`${name} must be a valid URL, got: "${raw}"`);
    return undefined;
  }
}

// ── Validation ───────────────────────────────────────────────────────────────

export function validateEnv(): Env {
  const errors: string[] = [];
  const warnings: string[] = [];

  const STELLAR_NETWORK = oneOf(
    "STELLAR_NETWORK",
    ["testnet", "mainnet"] as const,
    "testnet",
    errors
  );

  const ADMIN_SECRET_KEY = requireStr("ADMIN_SECRET_KEY", errors);
  const PROJECT_REGISTRY_CONTRACT_ID = requireStr("PROJECT_REGISTRY_CONTRACT_ID", errors);

  const RPC_URL = url("RPC_URL", "https://soroban-testnet.stellar.org", errors);
  const STELLAR_RPC_URL = url("STELLAR_RPC_URL", RPC_URL, errors);

  const PORT = posInt("PORT", 3001, errors);
  const FRONTEND_URL = url("FRONTEND_URL", "http://localhost:3000", errors);

  const ADMIN_API_KEY = str("ADMIN_API_KEY");
  if (!ADMIN_API_KEY && STELLAR_NETWORK === "mainnet") {
    warnings.push("ADMIN_API_KEY is not set — admin auth is disabled (unsafe in production)");
  }

  const WS_AUTH_TOKEN = str("WS_AUTH_TOKEN");

  const LOG_LEVEL = oneOf(
    "LOG_LEVEL",
    ["error", "warn", "info", "debug"] as const,
    "info",
    errors
  );

  const SENDGRID_API_KEY = str("SENDGRID_API_KEY");
  if (!SENDGRID_API_KEY) {
    warnings.push("SENDGRID_API_KEY is not set — email alerts will be disabled");
  }

  const EMAIL_FROM = str("EMAIL_FROM", "no-reply@heliobond.dev")!;

  const ETH_RPC_URL = optionalUrl("ETH_RPC_URL", errors);
  const ETH_CONTRACT_ADDRESS = str("ETH_CONTRACT_ADDRESS");
  if (ETH_RPC_URL && !ETH_CONTRACT_ADDRESS) {
    warnings.push("ETH_RPC_URL is set but ETH_CONTRACT_ADDRESS is missing");
  }

  const POLYGON_RPC_URL = optionalUrl("POLYGON_RPC_URL", errors);
  const POLYGON_CONTRACT_ADDRESS = str("POLYGON_CONTRACT_ADDRESS");
  if (POLYGON_RPC_URL && !POLYGON_CONTRACT_ADDRESS) {
    warnings.push("POLYGON_RPC_URL is set but POLYGON_CONTRACT_ADDRESS is missing");
  }

  const DB_POOL_MIN = posInt("DB_POOL_MIN", 2, errors);
  const DB_POOL_MAX = posInt("DB_POOL_MAX", 10, errors);
  if (DB_POOL_MIN > DB_POOL_MAX) {
    errors.push(`DB_POOL_MIN (${DB_POOL_MIN}) must be ≤ DB_POOL_MAX (${DB_POOL_MAX})`);
  }
  const DB_POOL_ACQUIRE_TIMEOUT_MS = posInt("DB_POOL_ACQUIRE_TIMEOUT_MS", 5000, errors);
  const DB_POOL_HEALTH_CHECK_INTERVAL_MS = posInt("DB_POOL_HEALTH_CHECK_INTERVAL_MS", 30000, errors);

  const RATE_LIMIT_WINDOW_MS = posInt("RATE_LIMIT_WINDOW_MS", 60_000, errors);
  const RATE_LIMIT_MAX = posInt("RATE_LIMIT_MAX", 100, errors);
  const RATE_LIMIT_ADMIN_WINDOW_MS = posInt("RATE_LIMIT_ADMIN_WINDOW_MS", RATE_LIMIT_WINDOW_MS, errors);
  const RATE_LIMIT_ADMIN_MAX = posInt("RATE_LIMIT_ADMIN_MAX", 20, errors);

  for (const warning of warnings) {
    console.warn(`[env] WARNING: ${warning}`);
  }

  if (errors.length > 0) {
    console.error("[env] Environment validation failed:");
    for (const err of errors) {
      console.error(`  ✗ ${err}`);
    }
    process.exit(1);
  }

  return {
    STELLAR_NETWORK,
    ADMIN_SECRET_KEY,
    PROJECT_REGISTRY_CONTRACT_ID,
    RPC_URL,
    STELLAR_RPC_URL,
    PORT,
    FRONTEND_URL,
    ADMIN_API_KEY,
    WS_AUTH_TOKEN,
    LOG_LEVEL,
    SENDGRID_API_KEY,
    EMAIL_FROM,
    ETH_RPC_URL,
    ETH_CONTRACT_ADDRESS,
    POLYGON_RPC_URL,
    POLYGON_CONTRACT_ADDRESS,
    DB_POOL_MIN,
    DB_POOL_MAX,
    DB_POOL_ACQUIRE_TIMEOUT_MS,
    DB_POOL_HEALTH_CHECK_INTERVAL_MS,
    RATE_LIMIT_WINDOW_MS,
    RATE_LIMIT_MAX,
    RATE_LIMIT_ADMIN_WINDOW_MS,
    RATE_LIMIT_ADMIN_MAX,
  };
}

/** Validated, typed env singleton — populated by validateEnv() at startup. */
export let env: Env;

export function initEnv(): Env {
  env = validateEnv();
  return env;
}
