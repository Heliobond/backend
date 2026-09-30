import { getTotalProjects, isRegistryPaused } from "./registry";
import { updateScoreForProject } from "./scoreService";
import { recordScoreHistory, getHistory } from "./history";
import { tryBeginUpdate, markCompleted, markFailed } from "./duplicate-detection";
import { withProjectLock } from "./request-queue";
import { isErrorRateLimited, resetErrorRateLimit } from "./error-limiter";
import { enqueue } from "./tx-queue";
import { sendAlertIfSignificant } from "./email";
import { notify } from "./notifications";
import { triggerWebhooks } from "./webhooks";
import { broadcastScoreUpdate } from "./websocket";
import { recordCronRun } from "./health";
import { logger } from "./logger";
import { config } from "../config";
import {
  cronJobDuration,
  cronJobTotal,
  cronProjectsSkipped,
  registryPaused as registryPausedGauge,
} from "./prometheus";
import { parseContractError } from "./contractErrors";

/**
 * Reasons the cron can skip a project before or during submission (#765).
 *
 * `paused` covers the whole batch; the rest are per-project. Kept as a
 * closed union so any future skip reason has to be added intentionally
 * (and mirrored in dashboards that filter on the label).
 */
export type CronSkipReason = "paused" | "archived" | "deleted" | "unchanged";

function classifyContractSkip(err: unknown): CronSkipReason | null {
  const decoded = parseContractError(err, "registry");
  if (!decoded) return null;
  if (decoded.name === "ProjectArchived") return "archived";
  if (decoded.name === "ProjectNotFound") return "deleted";
  if (decoded.name === "Paused") return "paused";
  return null;
}

/**
 * Core logic for the hourly score-update cron job. Extracted from src/index.ts
 * so it can be unit tested without booting the full Express/cron app.
 *
 * Fetches the total project count, walks every project, computes fresh scores,
 * and submits them on-chain. Per-project failures are isolated (logged and
 * counted) so one bad project never aborts the batch. A getTotalProjects
 * failure aborts the whole run, there's nothing to iterate without it.
 *
 * Before iterating, `is_paused()` is simulated once; a paused registry causes
 * the whole batch to be skipped (recorded as `skipped(paused)` in health and
 * the Prometheus `cron_projects_skipped_total` counter) rather than running
 * `n` per-project simulations that would all fail with `Paused` (#765).
 * Per-project archived and deleted contract errors are similarly classified
 * as skips rather than failures so they don't trip the "ALL projects failed"
 * alert.
 */
export async function runHourlyScoreUpdate(): Promise<void> {
  const endCronTimer = cronJobDuration.startTimer({ job: "score-update" });
  try {
    logger.info("[cron] running hourly score update");

    // Pause gate: one contract read up-front avoids `n` per-project
    // simulations that would all fail with the same `Paused` error while
    // emergency_pause() is engaged.
    let paused: boolean;
    try {
      paused = await isRegistryPaused();
    } catch (err) {
      // A failure of the pause check itself is not conclusive; fall through
      // and let the per-project loop run. Any Paused errors from the loop
      // will still be classified as skips, so the "ALL failed" alert won't
      // fire spuriously.
      logger.warn(
        "[cron] is_paused check failed; continuing without pause gate",
        logger.formatError(err),
      );
      paused = false;
    }

    if (paused) {
      registryPausedGauge.set(1);
      logger.info("[cron] registry is paused; skipping score-update run");
      cronProjectsSkipped.inc({ job: "score-update", reason: "paused" });
      recordCronRun("score-update", "skipped", "paused");
      endCronTimer();
      cronJobTotal.inc({ job: "score-update", result: "skipped" });
      return;
    }
    registryPausedGauge.set(0);

    const total = await getTotalProjects();
    const projectIds = Array.from({ length: total }, (_, i) => i + 1);

    let successCount = 0;
    let failureCount = 0;
    let skippedCount = 0;

    for (const projectId of projectIds) {
      await withProjectLock(projectId, async () => {
        const { allowed, reason } = tryBeginUpdate(projectId);
        if (!allowed) {
          logger.info(`[cron] skipping project ${projectId}: ${reason}`);
          return;
        }
        try {
          const scoreResult = await updateScoreForProject(projectId);

          if (scoreResult.status === "deferred") {
            logger.warn(`[cron] project ${projectId}: RPC degraded, score queued for later`);
            enqueue(projectId, scoreResult.creditQuality, scoreResult.greenImpact, "RPC degraded");
            markCompleted(projectId);
            resetErrorRateLimit(`cron:project-${projectId}`);
            successCount++;
            return;
          }

          if (scoreResult.status === "skipped") {
            logger.warn(
              `[cron] project ${projectId}: skipped on-chain update (${scoreResult.reason})`,
            );
            cronProjectsSkipped.inc({ job: "score-update", reason: "unchanged" });
            markCompleted(projectId);
            resetErrorRateLimit(`cron:project-${projectId}`);
            skippedCount++;
            return;
          }

          if (scoreResult.status === "error") {
            throw new Error(scoreResult.error);
          }

          recordScoreHistory(projectId, scoreResult.creditQuality, scoreResult.greenImpact);
          triggerWebhooks({
            project_id: projectId,
            credit_quality: scoreResult.creditQuality,
            green_impact: scoreResult.greenImpact,
            tx_hash: scoreResult.txHash,
            timestamp: Date.now(),
          });

          // Email alert when this update moved scores significantly (#22).
          const recent = getHistory(projectId).slice(-2);
          if (recent.length === 2) {
            const change = {
              project_id: projectId,
              credit_quality_delta: recent[1].credit_quality - recent[0].credit_quality,
              green_impact_delta: recent[1].green_impact - recent[0].green_impact,
            };
            await sendAlertIfSignificant(change);
            // Investor notifications (#661); never let a delivery failure fail the score update.
            await notify({
              type: "score_changed",
              id: scoreResult.txHash,
              project_id: projectId,
              data: {
                credit_quality_delta: change.credit_quality_delta,
                green_impact_delta: change.green_impact_delta,
              },
            }).catch((err) =>
              logger.error("[cron] investor notification failed", logger.formatError(err)),
            );
          }
          const timestamp = Date.now();
          broadcastScoreUpdate({
            project_id: projectId,
            credit_quality: scoreResult.creditQuality,
            green_impact: scoreResult.greenImpact,
            timestamp,
          });
          logger.info(
            `[cron] project ${projectId}: cq=${scoreResult.creditQuality} gi=${scoreResult.greenImpact} tx=${scoreResult.txHash}`,
          );
          markCompleted(projectId);
          resetErrorRateLimit(`cron:project-${projectId}`);
          successCount++;
        } catch (err) {
          // Archived / deleted / paused project errors are expected state
          // transitions, not oracle failures. Classify them as skips so
          // they don't trip the "ALL projects failed" alert and don't
          // spam the log on every hourly run.
          const skipReason = classifyContractSkip(err);
          if (skipReason) {
            logger.info(`[cron] project ${projectId}: skipping (${skipReason})`);
            cronProjectsSkipped.inc({ job: "score-update", reason: skipReason });
            markCompleted(projectId);
            resetErrorRateLimit(`cron:project-${projectId}`);
            skippedCount++;
            return;
          }
          markFailed(projectId);
          if (!isErrorRateLimited(`cron:project-${projectId}`)) {
            logger.error(`[cron] project ${projectId} failed`, logger.formatError(err));
          }
          failureCount++;
        }
      });
    }

    const totalProcessed = successCount + failureCount;
    const failureRate = totalProcessed > 0 ? failureCount / totalProcessed : 0;

    if (totalProcessed > 0 && failureCount === totalProcessed) {
      // All attempted projects failed, likely a systemic RPC or contract issue.
      logger.error(
        `[cron] ALERT: ALL ${failureCount} projects failed in score-update batch; ` +
          `check Soroban RPC connectivity and contract state`,
      );
      recordCronRun("score-update", "error");
      endCronTimer();
      cronJobTotal.inc({ job: "score-update", result: "error" });
    } else {
      if (failureCount > 0 && failureRate >= config.CRON_FAILURE_THRESHOLD) {
        logger.error(
          `[cron] WARN: high failure rate in score-update batch: ` +
            `${failureCount}/${totalProcessed} (${(failureRate * 100).toFixed(1)}%)`,
        );
      }
      logger.info("[cron] hourly score update complete", {
        total,
        successCount,
        failureCount,
        skippedCount,
      });
      recordCronRun("score-update", "success");
      endCronTimer();
      cronJobTotal.inc({ job: "score-update", result: "success" });
    }
  } catch (err) {
    if (!isErrorRateLimited("cron:score-update")) {
      logger.error("[cron] score update failed", logger.formatError(err));
    }
    recordCronRun("score-update", "error");
    endCronTimer();
    cronJobTotal.inc({ job: "score-update", result: "error" });
  }
}
