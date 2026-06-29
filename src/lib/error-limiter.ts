interface ErrorBucket {
  count: number;
  windowStart: number;
}

const buckets = new Map<string, ErrorBucket>();

const BUCKET_CLEANUP_INTERVAL_MS = 60_000;
let lastCleanup = Date.now();

function cleanup(): void {
  const now = Date.now();
  if (now - lastCleanup < BUCKET_CLEANUP_INTERVAL_MS) return;
  lastCleanup = now;
  for (const [key, bucket] of buckets) {
    if (now - bucket.windowStart > 3_600_000) {
      buckets.delete(key);
    }
  }
}

export function isErrorRateLimited(
  key: string,
  maxErrors: number = 5,
  windowMs: number = 60_000,
): boolean {
  cleanup();

  const now = Date.now();
  const bucket = buckets.get(key);

  if (!bucket || now - bucket.windowStart > windowMs) {
    buckets.set(key, { count: 1, windowStart: now });
    return false;
  }

  bucket.count++;
  if (bucket.count > maxErrors) {
    return true;
  }

  return false;
}

export function resetErrorRateLimit(key: string): void {
  buckets.delete(key);
}

export function clearAllRateLimits(): void {
  buckets.clear();
}
