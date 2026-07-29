import { getTotalProjects } from "./registry";
import { updateScoreForProject } from "./scoreService";
import { recordScoreHistory, getHistory } from "./history";
import { tryBeginUpdate, markCompleted, markFailed } from "./duplicate-detection";
import { withProjectLock } from "./request-queue";
import { isErrorRateLimited, resetErrorRateLimit } from "./error-limiter";
import { enqueue } from "./tx-queue";
import { sendAlertIfSignificant } from "./email";
import { triggerWebhooks } from "./webhooks";
import { broadcastScoreUpdate } from "./websocket";
import { recordCronRun } from "./health";
import { logger } from "./logger";
import { config } from "../config";

/**
 * Core logic for the hourly score-update cron job. Extracted from src/index.ts
 * so it can be unit tested without booting the full Express/cron app.
 *
 * Fetches the total project count, walks every project, computes fresh scores,
 * and submits them on-chain. Per-project failures are isolated (logged and
 * counted) so one bad project never aborts the batch. A getTotalProjects
 * failure aborts the whole run — there's nothing to iterate without it.
 */
export async function runHourlyScoreUpdate(): Promise<void> {
  try {
    logger.info("[cron] running hourly score update");
    const total = await getTotalProjects();
    const projectIds = Array.from({ length: total }, (_, i) => i + 1);

    let successCount = 0;
    let failureCount = 0;

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
            await sendAlertIfSignificant({
              project_id: projectId,
              credit_quality_delta: recent[1].credit_quality - recent[0].credit_quality,
              green_impact_delta: recent[1].green_impact - recent[0].green_impact,
            });
          }
          const timestamp = Date.now();
          recordScoreHistory(
            projectId,
            scoreResult.creditQuality,
            scoreResult.greenImpact,
            timestamp,
          );
          triggerWebhooks({
            project_id: projectId,
            credit_quality: scoreResult.creditQuality,
            green_impact: scoreResult.greenImpact,
            tx_hash: scoreResult.txHash,
            timestamp,
          });
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
      // All attempted projects failed — likely a systemic RPC or contract issue.
      logger.error(
        `[cron] ALERT: ALL ${failureCount} projects failed in score-update batch — ` +
          `check Soroban RPC connectivity and contract state`,
      );
      recordCronRun("score-update", "error");
    } else {
      if (failureCount > 0 && failureRate >= config.CRON_FAILURE_THRESHOLD) {
        logger.error(
          `[cron] WARN: high failure rate in score-update batch: ` +
            `${failureCount}/${totalProcessed} (${(failureRate * 100).toFixed(1)}%)`,
        );
      }
      logger.info("[cron] hourly score update complete", { total, successCount, failureCount });
      recordCronRun("score-update", "success");
    }
  } catch (err: any) {
    if (!isErrorRateLimited("cron:score-update")) {
      logger.error("[cron] score update failed", { error: err?.message });
    }
    recordCronRun("score-update", "error");
  }
}
