/**
 * Exponential backoff retry utility for Stellar transactions (#55).
 *
 * Only retries on transient errors (network timeouts, sequence conflicts,
 * rate limits). Permanent errors (bad auth, insufficient funds, etc.) are
 * re-thrown immediately without consuming retry budget.
 */

import { logger } from "./logger";
import { parseContractError } from "./contractErrors";

export interface RetryConfig {
  /** Maximum number of attempts (including the first). Default: 4 */
  maxAttempts: number;
  /** Base delay in ms for the first retry. Default: 200 */
  baseDelayMs: number;
  /** Maximum delay cap in ms. Default: 30_000 */
  maxDelayMs: number;
  /** Jitter factor 0–1 applied to each delay. Default: 0.3 */
  jitter: number;
  /** Optional label used in log messages. */
  label?: string;
  /** Optional AbortSignal to cancel in-flight waits and stop retrying (#1049). */
  signal?: AbortSignal;
}

/** Errors thrown when configuration is invalid (#1052). */
export class RetryConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RetryConfigError";
  }
}

/** Validate RetryConfig fields and throw RetryConfigError if any are invalid (#1052). */
export function validateRetryConfig(config: Required<Omit<RetryConfig, "signal">> & { signal?: AbortSignal }): void {
  if (!Number.isInteger(config.maxAttempts) || config.maxAttempts < 1) {
    throw new RetryConfigError(`maxAttempts must be a positive integer, got ${config.maxAttempts}`);
  }
  if (!Number.isFinite(config.baseDelayMs) || config.baseDelayMs < 0) {
    throw new RetryConfigError(`baseDelayMs must be a non-negative number, got ${config.baseDelayMs}`);
  }
  if (!Number.isFinite(config.maxDelayMs) || config.maxDelayMs < config.baseDelayMs) {
    throw new RetryConfigError(
      `maxDelayMs (${config.maxDelayMs}) must be >= baseDelayMs (${config.baseDelayMs})`,
    );
  }
  if (!Number.isFinite(config.jitter) || config.jitter < 0 || config.jitter > 1) {
    throw new RetryConfigError(`jitter must be in [0, 1], got ${config.jitter}`);
  }
}

const DEFAULT_CONFIG: Required<RetryConfig> = {
  maxAttempts: 4,
  baseDelayMs: 200,
  maxDelayMs: 30_000,
  jitter: 0.3,
  label: "retry",
};

/** Errors that should NOT be retried (permanent failures). */
const PERMANENT_ERROR_PATTERNS = [
  "tx_bad_auth",
  "tx_insufficient_balance",
  "tx_no_account",
  "tx_insufficient_fee",
  "ADMIN_SECRET_KEY not set",
];

/** HTTP status codes that indicate a permanent (client) failure — retrying won't help. */
const PERMANENT_HTTP_STATUSES = new Set([400, 401, 403, 404, 409, 422]);

interface StatusCarryingError {
  status?: number;
  statusCode?: number;
  response?: { status?: number };
}

/** Pulls an HTTP-style status code off an error, strictly from structured fields or numeric values. */
export function extractHttpStatus(err: unknown): number | undefined {
  if (typeof err === "number") {
    return err;
  }
  if (err && typeof err === "object") {
    const { status, statusCode, response } = err as StatusCarryingError;
    const direct = status ?? statusCode ?? response?.status;
    if (typeof direct === "number") return direct;
  }
  return undefined;
}

export function isTransientError(err: unknown): boolean {
  // Contract panics: NOT retried unless their code is explicitly marked retryable.
  const contractErr = parseContractError(err);
  if (contractErr !== null) {
    return contractErr.retryable;
  }

  const msg = err instanceof Error ? err.message : String(err);
  if (PERMANENT_ERROR_PATTERNS.some((p) => msg.includes(p))) return false;

  const status = extractHttpStatus(err);
  if (status !== undefined && PERMANENT_HTTP_STATUSES.has(status)) return false;

  // Anything else — timeouts, network errors, 5xx/429, unknown errors — is retried.
  return true;
}

/**
 * Calculate the next delay using exponential backoff + jitter.
 * delay = min(min(baseDelay * 2^attempt, maxDelay) * (1 ± jitter), maxDelay)
 *
 * The cap is applied both before and after jitter so jitter can never push
 * the delay above maxDelayMs (#1050).
 */
export function backoffDelay(attempt: number, config: Required<Omit<RetryConfig, "signal">> & { signal?: AbortSignal }): number {
  const exponential = Math.min(config.baseDelayMs * Math.pow(2, attempt), config.maxDelayMs);
  const jitterFactor = 1 - config.jitter + Math.random() * config.jitter * 2;
  // Re-apply the cap after jitter so jitter can never exceed maxDelayMs (#1050).
  return Math.min(Math.floor(exponential * jitterFactor), config.maxDelayMs);
}

interface RetryAfterCarryingError {
  headers?: Record<string, string | string[]> | { get?: (name: string) => string | null };
  response?: { headers?: Record<string, string | string[]> | { get?: (name: string) => string | null } };
}

/**
 * Extracts the Retry-After delay in ms from a structured error (#1051).
 * Returns undefined if no Retry-After header is present or cannot be parsed.
 * Handles both seconds (integer) and HTTP-date formats.
 */
export function extractRetryAfterMs(err: unknown): number | undefined {
  if (!err || typeof err !== "object") return undefined;
  const e = err as RetryAfterCarryingError;
  const headers = e.headers ?? e.response?.headers;
  if (!headers) return undefined;

  let raw: string | null | undefined;
  if (typeof (headers as { get?: (name: string) => string | null }).get === "function") {
    raw = (headers as { get: (name: string) => string | null }).get("retry-after");
  } else {
    const h = headers as Record<string, string | string[]>;
    const val = h["retry-after"] ?? h["Retry-After"];
    raw = Array.isArray(val) ? val[0] : val;
  }

  if (!raw) return undefined;

  // Integer seconds
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);

  // HTTP-date format
  const date = Date.parse(raw);
  if (Number.isFinite(date)) {
    const delta = date - Date.now();
    return delta > 0 ? delta : 0;
  }

  return undefined;
}

/**
 * Execute fn with automatic exponential-backoff retries.
 * Integrates with an optional CircuitBreaker via the shouldRetry override.
 *
 * Changes:
 *  - Validates config before the first attempt (#1052).
 *  - Accepts an optional AbortSignal; aborts during backoff sleeps and before
 *    each attempt re-throw the last captured error (#1049).
 *  - Respects structured Retry-After headers on 429/503 errors (#1051).
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  config: Partial<RetryConfig> = {},
): Promise<T> {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  // Validate before consuming any retry budget (#1052).
  validateRetryConfig(cfg);

  const { signal } = cfg;
  let lastError: unknown;

  for (let attempt = 0; attempt < cfg.maxAttempts; attempt++) {
    // Honor pre-attempt abort (#1049).
    if (signal?.aborted) throw lastError ?? signal.reason;

    try {
      const result = await fn();
      if (attempt > 0) {
        logger.info(`[${cfg.label}] succeeded on attempt ${attempt + 1}`, {
          attempt: attempt + 1,
          label: cfg.label,
          maxAttempts: cfg.maxAttempts,
        });
      }
      return result;
    } catch (err) {
      lastError = err;

      if (!isTransientError(err)) {
        logger.warn(`[${cfg.label}] permanent error, not retrying`, {
          ...logger.formatError(err),
          attempt: attempt + 1,
          label: cfg.label,
          maxAttempts: cfg.maxAttempts,
        });
        throw err;
      }

      if (attempt + 1 >= cfg.maxAttempts) break;

      // Use Retry-After if the server provided one (#1051); fall back to backoff.
      const retryAfter = extractRetryAfterMs(err);
      const delay = retryAfter !== undefined
        ? Math.min(retryAfter, cfg.maxDelayMs)
        : backoffDelay(attempt, cfg);

      logger.warn(`[${cfg.label}] attempt ${attempt + 1}/${cfg.maxAttempts} failed; retrying`, {
        ...logger.formatError(err),
        attempt: attempt + 1,
        delayMs: delay,
        label: cfg.label,
        maxAttempts: cfg.maxAttempts,
      });

      // Cancellable sleep: abort during backoff clears the timer and re-throws
      // the original error (not the AbortError) so the caller sees what failed (#1049).
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, delay);
        signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            reject(lastError);
          },
          { once: true },
        );
      });
    }
  }

  throw lastError;
}
