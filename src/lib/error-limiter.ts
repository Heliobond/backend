/**
 * Simple rate-limiter for error log messages (#57).
 * Prevents log spam when the same error fires repeatedly.
 */

const WINDOW_MS = parseInt(process.env.ERROR_RATE_LIMIT_WINDOW_MS ?? "60000", 10);

const seen = new Map<string, number>();

/**
 * Returns true if the key has been seen within the current window,
 * meaning the caller should suppress the log.
 * Returns false (and records the key) on first occurrence within the window.
 */
export function isErrorRateLimited(key: string): boolean {
  const now = Date.now();
  const last = seen.get(key);
  if (last !== undefined && now - last < WINDOW_MS) return true;
  seen.set(key, now);
  return false;
}

export function resetErrorRateLimit(key: string): void {
  seen.delete(key);
}
