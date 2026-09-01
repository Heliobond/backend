import { logger } from "./logger";

interface LockEntry {
  timestamp: number;
}

const activeLocks = new Map<any, LockEntry>();

export function resetDuplicateDetectionLocks(): void {
  activeLocks.clear();
}

/**
 * Attempts to acquire a lock for updating the given ID.
 * Returns allowed: true if the lock was acquired, false if already locked.
 */
export function tryBeginUpdate(id: any): { allowed: boolean; key: string; reason: string } {
  const existing = activeLocks.get(id);

  if (existing) {
    const reason = `Update already in progress since ${new Date(existing.timestamp).toISOString()}`;
    logger.warn(`[duplicate-detection] Skipping update for ${id}: ${reason}`);
    return {
      allowed: false,
      key: "",
      reason,
    };
  }

  const key = `lock-${id}-${Date.now()}`;
  activeLocks.set(id, { timestamp: Date.now() });

  return {
    allowed: true,
    key,
    reason: "",
  };
}

/**
 * Releases the lock for the given ID after successful completion.
 */
export function markCompleted(id: any): void {
  activeLocks.delete(id);
  logger.debug(`[duplicate-detection] Lock released for ${id} after successful completion`);
}

/**
 * Releases the lock for the given ID after failure.
 */
export function markFailed(id: any): void {
  activeLocks.delete(id);
  logger.debug(`[duplicate-detection] Lock released for ${id} after failure`);
}
