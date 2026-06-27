import { Router, Request, Response } from "express";
import { createJob, getJob, runJob } from "../lib/batch";
import { recordScoreHistory } from "../lib/history";
import { triggerWebhooks } from "../lib/webhooks";
import { getSolarData, getSatelliteData } from "./iot";
import { computeScores } from "../lib/scoring";
import { updateImpactScore, getTotalProjects } from "../lib/registry";
import { badRequest } from "../middleware/errors";

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
    if (!body.project_ids.every((n) => Number.isInteger(n) && (n as number) >= 1)) {
      throw badRequest("project_ids must contain only positive integers");
    }
    projectIds = body.project_ids as number[];
  } else {
    const total = await getTotalProjects();
    projectIds = Array.from({ length: total }, (_, i) => i + 1);
  }

  const rawConcurrency = body.concurrency as number | undefined;
  const concurrency = rawConcurrency !== undefined
    ? Math.min(MAX_CONCURRENCY, Math.max(1, Math.floor(rawConcurrency)))
    : DEFAULT_CONCURRENCY;

  const job = createJob(projectIds, concurrency);

  // Fire-and-forget — caller polls /status
  runJob(job, async (projectId) => {
    try {
      const solar = getSolarData(projectId);
      const satellite = getSatelliteData(projectId);
      const scores = computeScores({ solar, satellite });
      const tx_hash = await updateImpactScore(projectId, scores.credit_quality, scores.green_impact);
      recordScoreHistory(projectId, scores.credit_quality, scores.green_impact);
      triggerWebhooks({ project_id: projectId, ...scores, tx_hash, timestamp: Date.now() });
      return { project_id: projectId, tx_hash, ...scores };
    } catch (err) {
      return { project_id: projectId, error: String(err) };
    }
  }).catch(() => {
    job.status = "failed";
    job.completed_at = new Date().toISOString();
  });

  res.status(202).json({
    batch_id: job.id,
    status: job.status,
    total: job.project_ids.length,
    concurrency: job.concurrency,
  });
});

/**
 * GET /api/admin/batch/:batchId/status
 * Returns current progress and results for a batch job.
 */
router.get("/:batchId/status", (req: Request, res: Response) => {
  const job = getJob(req.params["batchId"]);
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
