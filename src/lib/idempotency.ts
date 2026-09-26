/**
 * Idempotency guard for Stellar transaction submissions (#543).
 *
 * Generates a deterministic key per (projectId, hourSeed) so that every call
 * within the same clock-hour produces the same key. An in-memory Map holds
 * recently-seen keys with a configurable TTL; duplicate submissions within the
 * TTL window are rejected before they can reach the RPC layer.
 *
 * Key formula: `score:<projectId>:<hourSeed>`
 *   where hourSeed = Math.floor(Date.now() / 3_600_000)
 *
 * The TTL defaults to 3 600 000 ms (1 hour) and is controlled by the
 * IDEMPOTENCY_TTL_MS environment variable via config.
 */

import { config } from "../config";
import { logger } from "./logger";

interface IdempotencyEntry {
  /** Unix timestamp (ms) when the key was first recorded. */
  recordedAt: number;
}

/** In-memory store — lives for the lifetime of the process. */
const store = new Map<string, IdempotencyEntry>();

/**
 * Generate a deterministic idempotency key for a project score update.
 *
 * The key is stable within the same clock-hour, so every retry or duplicate
 * call within that window produces an identical key and will be rejected by
 * `checkIdempotency`.
 */
export function generateIdempotencyKey(projectId: number): string {
  const hourSeed = Math.floor(Date.now() / 3_600_000);
  return `score:${projectId}:${hourSeed}`;
}

/**
 * Check whether the key has already been seen within the TTL window.
 *
 * - Returns `{ isDuplicate: false }` and records the key when it is new.
 * - Returns `{ isDuplicate: true, recordedAt }` and logs a warning when the
 *   key was already seen within `IDEMPOTENCY_TTL_MS` milliseconds.
 *
 * Expired entries are pruned opportunistically on every call to keep memory
 * usage bounded without requiring a background timer.
 */
export function checkIdempotency(key: string): { isDuplicate: boolean; recordedAt?: number } {
  const now = Date.now();
  const ttl = config.IDEMPOTENCY_TTL_MS;

  // Opportunistic sweep: remove keys whose TTL has elapsed.
  for (const [storedKey, entry] of store.entries()) {
    if (now - entry.recordedAt > ttl) {
      store.delete(storedKey);
    }
  }

  const existing = store.get(key);
  if (existing) {
    logger.warn(
      `[idempotency] duplicate submission rejected — key="${key}" ` +
        `first seen at ${new Date(existing.recordedAt).toISOString()} ` +
        `(${now - existing.recordedAt}ms ago, TTL=${ttl}ms)`,
    );
    return { isDuplicate: true, recordedAt: existing.recordedAt };
  }

  store.set(key, { recordedAt: now });
  return { isDuplicate: false };
}

/**
 * Manually remove a key from the store (e.g. after a confirmed on-chain
 * failure that should be retried in the next window).
 */
export function removeIdempotencyKey(key: string): void {
  store.delete(key);
}

/** Exposed for testing — returns the current number of live (non-expired) keys. */
export function getIdempotencyStoreSize(): number {
  return store.size;
}

/** Exposed for testing — clears the entire store. */
export function clearIdempotencyStore(): void {
  store.clear();
}
