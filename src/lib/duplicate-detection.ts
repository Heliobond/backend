import { logger } from "./logger";

interface LockEntry {
  timestamp: number;
}

const activeLocks = new Map<number | string, LockEntry>();

/** Default TTL for locks in milliseconds (5 minutes) */
const DEFAULT_LOCK_TTL_MS = 5 * 60 * 1000;

/** Default max number of active locks to bound in-memory map size */
export const DEFAULT_MAX_ACTIVE_LOCKS = 10_000;

/** Configurable TTL for locks */
let lockTTL = DEFAULT_LOCK_TTL_MS;

/** Configurable maximum size limit for activeLocks map */
let maxActiveLocks = DEFAULT_MAX_ACTIVE_LOCKS;

/**
 * Sets the TTL (time-to-live) for locks in milliseconds.
 * @param ttlMs TTL in milliseconds. Must be positive.
 */
export function setLockTTL(ttlMs: number): void {
  if (ttlMs <= 0 || !Number.isFinite(ttlMs)) {
    throw new Error("Lock TTL must be positive");
  }
  lockTTL = ttlMs;
}

/**
 * Gets the current lock TTL in milliseconds.
 */
export function getLockTTL(): number {
  return lockTTL;
}

/**
 * Sets the maximum number of active locks permitted in memory.
 * @param limit Maximum capacity. Must be a positive integer.
 */
export function setMaxActiveLocks(limit: number): void {
  if (limit <= 0 || !Number.isFinite(limit)) {
    throw new Error("Max active locks must be positive");
  }
  maxActiveLocks = Math.floor(limit);
}

/**
 * Gets the current maximum active locks limit.
 */
export function getMaxActiveLocks(): number {
  return maxActiveLocks;
}

/**
 * Returns the current count of active locks in memory.
 */
export function getActiveLocksCount(): number {
  return activeLocks.size;
}

/**
 * Gets the age of a lock for the given ID in milliseconds.
 * Returns undefined if no lock exists.
 */
export function getLockAge(id: number | string): number | undefined {
  const existing = activeLocks.get(id);
  if (!existing) return undefined;
  return Date.now() - existing.timestamp;
}

/**
 * Sweeps and purges all expired locks across all project IDs.
 * @param now Optional timestamp to compare against (defaults to Date.now()).
 * @returns The number of expired locks purged.
 */
export function sweepExpiredLocks(now: number = Date.now()): number {
  let purgedCount = 0;
  for (const [id, entry] of activeLocks.entries()) {
    const lockAge = now - entry.timestamp;
    if (lockAge >= lockTTL) {
      logger.warn(
        `[duplicate-detection] Lock for ${id} expired after ${lockAge}ms (TTL: ${lockTTL}ms), releasing stale lock`,
      );
      activeLocks.delete(id);
      purgedCount++;
    }
  }
  return purgedCount;
}

/**
 * Attempts to acquire a lock for updating the given ID.
 * Returns allowed: true if the lock was acquired, false if already locked.
 * Locks automatically expire after the configured TTL.
 */
export function tryBeginUpdate(id: number | string): {
  allowed: boolean;
  key: string;
  reason: string;
} {
  const now = Date.now();

  // Opportunistic sweep: remove all expired locks across all project IDs
  sweepExpiredLocks(now);

  const existing = activeLocks.get(id);

  if (existing) {
    const lockAge = now - existing.timestamp;

    // Check if lock has expired
    if (lockAge >= lockTTL) {
      logger.warn(
        `[duplicate-detection] Lock for ${id} expired after ${lockAge}ms (TTL: ${lockTTL}ms), releasing stale lock`,
      );
      activeLocks.delete(id);
      // Fall through to acquire new lock
    } else {
      const reason = `Update already in progress since ${new Date(existing.timestamp).toISOString()}`;
      logger.warn(`[duplicate-detection] Skipping update for ${id}: ${reason}`);
      return {
        allowed: false,
        key: "",
        reason,
      };
    }
  }

  // Ensure map capacity stays bounded
  if (activeLocks.size >= maxActiveLocks) {
    let oldestId: number | string | undefined;
    let oldestTimestamp = Infinity;
    for (const [lockId, entry] of activeLocks.entries()) {
      if (entry.timestamp < oldestTimestamp) {
        oldestTimestamp = entry.timestamp;
        oldestId = lockId;
      }
    }
    if (oldestId !== undefined) {
      logger.warn(
        `[duplicate-detection] activeLocks capacity limit (${maxActiveLocks}) reached; evicting oldest lock for ${oldestId}`,
      );
      activeLocks.delete(oldestId);
    }
  }

  const key = `lock-${id}-${now}`;
  activeLocks.set(id, { timestamp: now });

  return {
    allowed: true,
    key,
    reason: "",
  };
}

/**
 * Releases the lock for the given ID after successful completion.
 */
export function markCompleted(id: number | string): void {
  activeLocks.delete(id);
  logger.debug(`[duplicate-detection] Lock released for ${id} after successful completion`);
}

/**
 * Releases the lock for the given ID after failure.
 */
export function markFailed(id: number | string): void {
  activeLocks.delete(id);
  logger.debug(`[duplicate-detection] Lock released for ${id} after failure`);
}

/** Clears all held locks and resets settings. Intended for tests only. */
export function resetLocks(): void {
  activeLocks.clear();
  lockTTL = DEFAULT_LOCK_TTL_MS;
  maxActiveLocks = DEFAULT_MAX_ACTIVE_LOCKS;
}
