/**
 * Exponential backoff retry utility for Stellar transactions (#55).
 *
 * Only retries on transient errors (network timeouts, sequence conflicts,
 * rate limits). Permanent errors (bad auth, insufficient funds, etc.) are
 * re-thrown immediately without consuming retry budget.
 */

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
  "contract_error",
  "ADMIN_SECRET_KEY not set",
];

export function isTransientError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  if (PERMANENT_ERROR_PATTERNS.some((p) => msg.includes(p))) return false;
  return true;
}

/**
 * Calculate the next delay using exponential backoff + jitter.
 * delay = min(baseDelay * 2^attempt, maxDelay) * (1 ± jitter)
 */
export function backoffDelay(attempt: number, config: Required<RetryConfig>): number {
  const exponential = Math.min(config.baseDelayMs * Math.pow(2, attempt), config.maxDelayMs);
  const jitterFactor = 1 - config.jitter + Math.random() * config.jitter * 2;
  return Math.floor(exponential * jitterFactor);
}

/**
 * Execute fn with automatic exponential-backoff retries.
 * Integrates with an optional CircuitBreaker via the shouldRetry override.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  config: Partial<RetryConfig> = {},
): Promise<T> {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  let lastError: unknown;

  for (let attempt = 0; attempt < cfg.maxAttempts; attempt++) {
    try {
      const result = await fn();
      if (attempt > 0) {
        console.log(`[${cfg.label}] succeeded on attempt ${attempt + 1}`);
      }
      return result;
    } catch (err) {
      lastError = err;

      if (!isTransientError(err)) {
        console.warn(`[${cfg.label}] permanent error, not retrying:`, (err as Error).message);
        throw err;
      }

      if (attempt + 1 >= cfg.maxAttempts) break;

      const delay = backoffDelay(attempt, cfg);
      console.warn(
        `[${cfg.label}] attempt ${attempt + 1}/${cfg.maxAttempts} failed: ${(err as Error).message}. ` +
          `Retrying in ${delay}ms…`,
      );
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  throw lastError;
}
