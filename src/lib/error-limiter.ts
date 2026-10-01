const WINDOW_MS = 60_000;
const CLEANUP_INTERVAL_MS = 5 * 60_000;

const seen = new Map<string, number>();
let lastCleanup = Date.now();

function cleanup(): void {
  const now = Date.now();
  if (now - lastCleanup < CLEANUP_INTERVAL_MS) return;
  lastCleanup = now;
  for (const [key, timestamp] of seen) {
    if (now - timestamp >= WINDOW_MS) {
      seen.delete(key);
    }
  }
}

export function isErrorRateLimited(key: string): boolean {
  cleanup();
  const now = Date.now();
  const last = seen.get(key);
  if (last !== undefined && now - last < WINDOW_MS) return true;
  seen.set(key, now);
  return false;
}

export function resetErrorRateLimit(key: string): void {
  seen.delete(key);
}
