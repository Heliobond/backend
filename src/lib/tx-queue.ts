/**
 * In-memory queue for deferred Stellar transactions (#55 / #57).
 * Used when the RPC is temporarily unavailable; cron retries periodically.
 */

export interface QueueItem {
  projectId: number;
  creditQuality: number;
  greenImpact: number;
  reason: string;
  retryCount: number;
  lastError?: string;
  enqueuedAt: number;
}

const MAX_RETRIES = parseInt(process.env.TX_QUEUE_MAX_RETRIES ?? "10", 10);

const queue = new Map<number, QueueItem>();

export function enqueue(
  projectId: number,
  creditQuality: number,
  greenImpact: number,
  reason: string,
): void {
  // Upsert: if already queued, refresh scores & reason but keep retry count
  const existing = queue.get(projectId);
  queue.set(projectId, {
    projectId,
    creditQuality,
    greenImpact,
    reason,
    retryCount: existing?.retryCount ?? 0,
    lastError: existing?.lastError,
    enqueuedAt: existing?.enqueuedAt ?? Date.now(),
  });
}

/** Remove and return the oldest queued item. */
export function dequeue(): QueueItem | undefined {
  const first = queue.values().next().value as QueueItem | undefined;
  if (first) queue.delete(first.projectId);
  return first;
}

export function remove(projectId: number): void {
  queue.delete(projectId);
}

export function incrementRetry(projectId: number, error?: string): void {
  const item = queue.get(projectId);
  if (item) {
    item.retryCount++;
    if (error) item.lastError = error;
  }
}

export function hasExceededMaxRetries(projectId: number): boolean {
  const item = queue.get(projectId);
  return item ? item.retryCount >= MAX_RETRIES : false;
}

export function getQueueSize(): number {
  return queue.size;
}

export function getQueueSnapshot(): QueueItem[] {
  return Array.from(queue.values());
}
