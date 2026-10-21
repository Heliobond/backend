import { Router, Request, Response } from "express";
import { createJob, getJob, runJob } from "../lib/batch";
import { recordScoreHistory } from "../lib/history";
import { triggerWebhooks } from "../lib/webhooks";
import { getSolarData, getSatelliteData } from "./iot";
import { computeScores } from "../lib/scoring";
import { updateImpactScore, getTotalProjects, RpcDegradedError } from "../lib/registry";
import { withProjectLock } from "../lib/request-queue";
import { tryBeginUpdate, markCompleted, markFailed } from "../lib/duplicate-detection";
import { generateIdempotencyKey, checkIdempotency } from "../lib/idempotency";
import { enqueue } from "../lib/tx-queue";
import { badRequest, maxProjectId } from "../middleware/errors";
import { parseContractError } from "../lib/contractErrors";

const router = Router();

const DEFAULT_CONCURRENCY = 3;
const MAX_CONCURRENCY = 10;

/**
 * POST /api/admin/batch/score-update
 * Body: { project_ids?: number[], concurrency?: number }
 * Enqueues a batch job and processes it asynchronously.
 * Returns the job id and initial status immediately.
 */
router.post("/score-update", async (req: Request, res: Response) => {
  const body = req.body as { project_ids?: unknown; concurrency?: unknown };

  let projectIds: number[];
  if (body.project_ids !== undefined && body.project_ids !== null) {
    if (!Array.isArray(body.project_ids)) {
      throw badRequest("project_ids must be an array of positive integers");
    }
    const parsed: number[] = [];
    for (const raw of body.project_ids) {
      if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1) {
        throw badRequest("project_ids must contain only positive integers");
      }
      parsed.push(raw);
    }
    const max = maxProjectId();
    if (!parsed.every((n) => n <= max)) {
      throw badRequest(`project_ids must not exceed maximum project id ${max}`);
    }
    projectIds = parsed;
  } else {
    const total = await getTotalProjects();
    projectIds = Array.from({ length: total }, (_, i) => i + 1);
  }

  const rawConcurrency = typeof body.concurrency === "number" ? body.concurrency : undefined;
  const concurrency =
    rawConcurrency !== undefined
      ? Math.min(MAX_CONCURRENCY, Math.max(1, Math.floor(rawConcurrency)))
      : DEFAULT_CONCURRENCY;

  const job = createJob(projectIds, concurrency);
  const initialStatus = job.status;

  // Fire-and-forget — caller polls /status
  runJob(job, async (projectId) => {
    return withProjectLock(projectId, async () => {
      const { allowed, reason } = tryBeginUpdate(projectId);
      if (!allowed) {
        return { project_id: projectId, skipped: true, skip_reason: reason };
      }
      try {
        const solar = getSolarData(projectId);
        const satellite = getSatelliteData(projectId);
        const scores = computeScores({ solar, satellite });

        // Idempotency: the batch path previously called updateImpactScore
        // without a key, so a batch overlapping the hourly cron in the
        // same clock-hour double-submitted update_impact_score on-chain.
        // Match the key scoreService.updateScoreForProject uses so both
        // paths collide in the same store (#833).
        const idempotencyKey = generateIdempotencyKey(projectId);
        const { isDuplicate, recordedAt } = checkIdempotency(idempotencyKey);
        if (isDuplicate) {
          markCompleted(projectId);
          return {
            project_id: projectId,
            skipped: true,
            skip_reason: `duplicate submission rejected — key="${idempotencyKey}" recordedAt=${recordedAt}`,
          };
        }

        let tx_hash: string;
        try {
          tx_hash = await updateImpactScore(
            projectId,
            scores.credit_quality,
            scores.green_impact,
            idempotencyKey,
          );
        } catch (updateErr) {
          if (updateErr instanceof RpcDegradedError) {
            // Queue the scores for later retry. Previously this path
            // recorded history and fired investor webhooks with
            // `tx_hash: "deferred"` — a transaction that never happened —
            // and skipped the queue entirely, so the deferred update was
            // silently lost (#833). Mirror the cron behavior: enqueue
            // only, no history, no webhooks until a real tx_hash exists.
            enqueue(projectId, scores.credit_quality, scores.green_impact, "RPC degraded");
            markCompleted(projectId);
            return { project_id: projectId, tx_hash: "deferred", ...scores };
          }
          throw updateErr;
        }
        recordScoreHistory(projectId, scores.credit_quality, scores.green_impact);
        triggerWebhooks({ project_id: projectId, ...scores, tx_hash, timestamp: Date.now() });
        markCompleted(projectId);
        return { project_id: projectId, tx_hash, ...scores };
      } catch (err) {
        markFailed(projectId);
        const decoded = parseContractError(err);
        return {
          project_id: projectId,
          error: String(err),
          ...(decoded
            ? { contract_error_name: decoded.name, contract_error_code: decoded.code }
            : {}),
        };
      }
    });
  }).catch(() => {
    job.status = "failed";
    job.completed_at = new Date().toISOString();
  });

  res.status(202).json({
    batch_id: job.id,
    status: initialStatus,
    total: job.project_ids.length,
    concurrency: job.concurrency,
  });
});

/**
 * GET /api/admin/batch/:batchId/status
 * Returns current progress and results for a batch job.
 */
router.get("/:batchId/status", (req: Request, res: Response) => {
  const job = getJob(String(req.params["batchId"]));
  if (!job) {
    res.status(404).json({ error: "not_found", message: "Batch job not found" });
    return;
  }
  res.json({
    batch_id: job.id,
    status: job.status,
    progress: job.progress,
    concurrency: job.concurrency,
    created_at: job.created_at,
    started_at: job.started_at,
    completed_at: job.completed_at,
    results: job.results,
    errors: job.errors,
  });
});

export default router;
