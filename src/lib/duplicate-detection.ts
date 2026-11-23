import { logger } from "./logger";

interface LockEntry {
  timestamp: number;
  token: string;
}

const activeLocks = new Map<number | string, LockEntry>();

/** Default TTL for locks in milliseconds (5 minutes) */
const DEFAULT_LOCK_TTL_MS = 5 * 60 * 1000;

/** Configurable TTL for locks */
let lockTTL = DEFAULT_LOCK_TTL_MS;

/**
 * Sets the TTL (time-to-live) for locks in milliseconds.
 * @param ttlMs TTL in milliseconds. Must be positive.
 */
export function setLockTTL(ttlMs: number): void {
  if (ttlMs <= 0) {
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
 * Gets the age of a lock for the given ID in milliseconds.
 * Returns undefined if no lock exists.
 */
export function getLockAge(id: number | string): number | undefined {
  const existing = activeLocks.get(id);
  if (!existing) return undefined;
  return Date.now() - existing.timestamp;
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
  const existing = activeLocks.get(id);

  if (existing) {
    const lockAge = Date.now() - existing.timestamp;

    // Check if lock has expired
    if (lockAge >= lockTTL) {
      logger.warn(
        `[duplicate-detection] Lock for ${id} expired after ${lockAge}ms (TTL: ${lockTTL}ms), releasing stale lock`
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

  const token = `lock-${id}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  activeLocks.set(id, { timestamp: Date.now(), token });

  return {
    allowed: true,
    key: token,
    reason: "",
  };
}

/**
 * Releases the lock for the given ID after successful completion.
 * The caller must supply the token returned by tryBeginUpdate; a stale
 * completion that arrives after the lock has been re-acquired by a new
 * owner is silently ignored.
 */
export function markCompleted(id: number | string, token: string): void {
  const entry = activeLocks.get(id);
  if (!entry || entry.token !== token) {
    logger.warn(`[duplicate-detection] markCompleted ignored for ${id}: token mismatch (stale completion)`);
    return;
  }
  activeLocks.delete(id);
  logger.debug(`[duplicate-detection] Lock released for ${id} after successful completion`);
}

/**
 * Releases the lock for the given ID after failure.
 * The caller must supply the token returned by tryBeginUpdate; a stale
 * failure that arrives after the lock has been re-acquired by a new
 * owner is silently ignored.
 */
export function markFailed(id: number | string, token: string): void {
  const entry = activeLocks.get(id);
  if (!entry || entry.token !== token) {
    logger.warn(`[duplicate-detection] markFailed ignored for ${id}: token mismatch (stale failure)`);
    return;
  }
  activeLocks.delete(id);
  logger.debug(`[duplicate-detection] Lock released for ${id} after failure`);
}

/** Clears all held locks. Intended for tests only. */
export function resetLocks(): void {
  activeLocks.clear();
}
