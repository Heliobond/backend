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

// ── Dead-letter store (#1055) ─────────────────────────────────────────────────
//
// When a queued item exhausts all retries the cron moves it here instead of
// silently discarding it. Operators can inspect dead-letter items and trigger
// an explicit replay; replays are protected by idempotency so a confirmed
// on-chain submission cannot be duplicated.

/** Maximum number of dead-letter items kept in memory (oldest evicted first). */
const DEAD_LETTER_MAX = parseInt(process.env.TX_QUEUE_DEAD_LETTER_MAX ?? "200", 10);

export interface DeadLetterItem {
  projectId: number;
  creditQuality: number;
  greenImpact: number;
  reason: string;
  attempts: number;
  lastError: string;
  failedAt: number;
}

const deadLetter: DeadLetterItem[] = [];

/**
 * Move an exhausted queue item to the dead-letter list. The item is removed
 * from the active queue and appended to the dead-letter list (oldest entries
 * evicted once the list reaches DEAD_LETTER_MAX).
 */
export function moveToDeadLetter(projectId: number): void {
  const item = queue.get(projectId);
  if (!item) return;
  queue.delete(projectId);

  deadLetter.push({
    projectId: item.projectId,
    creditQuality: item.creditQuality,
    greenImpact: item.greenImpact,
    reason: item.reason,
    attempts: item.retryCount,
    lastError: item.lastError ?? "",
    failedAt: Date.now(),
  });

  if (deadLetter.length > DEAD_LETTER_MAX) {
    deadLetter.splice(0, deadLetter.length - DEAD_LETTER_MAX);
  }
}

/** Returns a snapshot of all dead-letter items (oldest first). */
export function getDeadLetterItems(): DeadLetterItem[] {
  return [...deadLetter];
}

/**
 * Re-enqueue a dead-letter item so the cron will retry it. The dead-letter
 * record is removed immediately; a fresh queue entry is created with
 * retryCount reset to 0.
 *
 * Returns true if the item was found and re-enqueued, false if not found.
 */
export function replayDeadLetterItem(projectId: number): boolean {
  const idx = deadLetter.findIndex((d) => d.projectId === projectId);
  if (idx === -1) return false;
  const [item] = deadLetter.splice(idx, 1);
  enqueue(item.projectId, item.creditQuality, item.greenImpact, item.reason);
  // Reset the retry counter so the replayed item gets a full retry budget.
  const queued = queue.get(item.projectId);
  if (queued) queued.retryCount = 0;
  return true;
}

/** Clear the dead-letter list. Intended for test isolation only. */
export function clearDeadLetter(): void {
  deadLetter.length = 0;
}
