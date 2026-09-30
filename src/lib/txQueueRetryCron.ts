import { getSolarData } from "./iot";
import { fetchSatelliteWithFallback } from "./satellite-sources";
import { computeScores } from "./scoring";
import { updateImpactScore, DuplicateSubmissionError } from "./registry";
import { generateIdempotencyKey, checkIdempotency } from "./idempotency";
import {
  getQueueSize,
  getQueueSnapshot,
  remove,
  incrementRetry,
  hasExceededMaxRetries,
} from "./tx-queue";
import { isRpcAvailable } from "./stellar";
import { logger } from "./logger";
import { config } from "../config";

/**
 * Core logic for the tx-queue retry cron job. Extracted from src/index.ts
 * so it can be unit tested without booting the full Express/cron app.
 *
 * Processes queued transactions that previously failed due to RPC unavailability
 * or transient errors. Each item gets at most one retry attempt per cron tick:
 * - On success (or detected duplicate), the item is removed from the queue
 * - On failure, the retry count is incremented and the item remains queued
 * - Items exceeding MAX_RETRIES are dropped and logged
 *
 * Idempotency checks prevent double-submission of transactions already
 * submitted in the current hour window.
 */
export async function runTxQueueRetry(): Promise<void> {
  if (getQueueSize() === 0) return;

  if (!isRpcAvailable()) {
    logger.info(`[cron] tx-queue: RPC unavailable, ${getQueueSize()} transactions pending`);
    return;
  }

  logger.info(`[cron] tx-queue: processing ${getQueueSize()} queued transactions`);

  // Read max retries from config instead of hardcoding
  const maxRetries = parseInt(process.env.TX_QUEUE_MAX_RETRIES ?? "10", 10);
  const processed: number[] = [];

  // Snapshot the queue once and make a single pass over it. Each item gets
  // at most one attempt per cron tick: on success (or a detected duplicate)
  // it is removed; on failure it is left in the queue (with its retry
  // count bumped in place) so the *next* 5-minute tick retries it, instead
  // of hot-looping the same failing item synchronously in this run.
  //
  // Items are only ever removed from the queue on success, on a detected
  // duplicate, or once they've exceeded MAX_RETRIES — never merely because
  // an attempt was made (see #532).
  for (const item of getQueueSnapshot()) {
    try {
      const solar = getSolarData(item.projectId);
      const satellite = await fetchSatelliteWithFallback(item.projectId);
      const fresh = computeScores({ solar, satellite });

      // Generate an idempotency key for this retry so a queued transaction
      // that was already submitted on-chain is not double-submitted.
      const idempotencyKey = generateIdempotencyKey(item.projectId);
      const { isDuplicate } = checkIdempotency(idempotencyKey);
      if (isDuplicate) {
        logger.info(
          `[cron] tx-queue: project ${item.projectId} skipped — already submitted this hour (key=${idempotencyKey})`,
        );
        remove(item.projectId);
        processed.push(item.projectId);
      } else {
        const tx_hash = await updateImpactScore(
          item.projectId,
          fresh.credit_quality,
          fresh.green_impact,
          idempotencyKey,
        );
        remove(item.projectId);
        processed.push(item.projectId);
        logger.info(
          `[cron] tx-queue: project ${item.projectId} retried successfully tx=${tx_hash}`,
        );
      }
    } catch (err) {
      if (err instanceof DuplicateSubmissionError) {
        // Belt-and-suspenders: also catch if DuplicateSubmissionError bubbles up.
        logger.info(
          `[cron] tx-queue: project ${item.projectId} skipped (duplicate): ${err.message}`,
        );
        remove(item.projectId);
        processed.push(item.projectId);
      } else {
        const errMsg = err instanceof Error ? err.message : String(err);
        incrementRetry(item.projectId, errMsg);

        if (hasExceededMaxRetries(item.projectId)) {
          logger.error(
            `[cron] tx-queue: project ${item.projectId} exceeded max retries (${maxRetries}), dropping`,
          );
          remove(item.projectId);
          processed.push(item.projectId);
        } else {
          logger.warn(
            `[cron] tx-queue: project ${item.projectId} retry failed (attempt ${item.retryCount}), will retry`,
          );
        }
      }
    }
  }

  if (processed.length > 0) {
    logger.info(`[cron] tx-queue: successfully retried ${processed.length} transactions`);
  }
}
