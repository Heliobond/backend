import { Router, Request, Response, NextFunction } from "express";
import { getSolarData, getSatelliteData } from "./iot";
import { computeScores } from "../lib/scoring";
import { updateImpactScore, getTotalProjects } from "../lib/registry";
import { badRequest, parseOptionalInt } from "../middleware/errors";
import { recordAudit, getAuditLog, auditToCsv } from "../lib/audit";
import { broadcastScoreUpdate } from "../lib/websocket";
import { tryBeginUpdate, markCompleted, markFailed } from "../lib/duplicate-detection";
import { RpcDegradedError } from "../lib/registry";
import { withProjectLock } from "../lib/request-queue";

const router = Router();

// Bearer token auth — enforced when ADMIN_API_KEY env var is set
router.use((req: Request, res: Response, next: NextFunction) => {
  const apiKey = process.env.ADMIN_API_KEY;
  if (!apiKey) return next();
  if (req.headers.authorization !== `Bearer ${apiKey}`) {
    return res.status(401).json({ error: "unauthorized", message: "Missing or invalid bearer token" });
  }
  next();
});

/**
 * Validate the optional `project_ids` field. Returns a list of ids, or `null`
 * to signal "update every registered project". Throws `ApiError` (400) on
 * anything that isn't an array of positive integers.
 */
function parseProjectIds(body: unknown): number[] | null {
  const raw = (body as { project_ids?: unknown } | undefined)?.project_ids;
  if (raw === undefined || raw === null) return null;
  if (!Array.isArray(raw)) {
    throw badRequest("project_ids must be an array of positive integers");
  }
  if (raw.length === 0) return null;
  if (!raw.every((n) => Number.isInteger(n) && (n as number) >= 1)) {
    throw badRequest("project_ids must contain only positive integers");
  }
  return raw as number[];
}

// POST /api/admin/update-scores
// Body: { project_ids?: number[] }  — defaults to all projects
// Returns: { updated: number, results: [...], errors: [...] }
router.post("/update-scores", async (req: Request, res: Response) => {
  // Validation throws ApiError -> handled by the central error middleware as 400.
  const requested = parseProjectIds(req.body);

  try {
    let projectIds: number[];

    if (requested) {
      projectIds = requested;
    } else {
      const total = await getTotalProjects();
      projectIds = Array.from({ length: total }, (_, i) => i + 1);
    }

    const results: Array<{
      project_id: number;
      tx_hash: string;
      credit_quality: number;
      green_impact: number;
    }> = [];
    const errors: Array<{ project_id: number; error: string }> = [];
    const skipped: Array<{ project_id: number; reason: string }> = [];

    // Soroban does not support multi-call batching — submit sequentially
    for (const projectId of projectIds) {
      try {
        const result = await withProjectLock(projectId, async () => {
          const { allowed, key, reason } = tryBeginUpdate(projectId);
          if (!allowed) {
            return { skipped: true, reason: reason! };
          }
          try {
            const solar = getSolarData(projectId);
            const satellite = getSatelliteData(projectId);
            const scores = computeScores({ solar, satellite });
            let tx_hash: string;
            try {
              tx_hash = await updateImpactScore(projectId, scores.credit_quality, scores.green_impact);
            } catch (updateErr) {
              if (updateErr instanceof RpcDegradedError) {
                console.warn(`[oracle] project ${projectId}: RPC degraded, score queued for later`);
                markCompleted(projectId);
                return { project_id: projectId, tx_hash: "deferred", ...scores };
              }
              throw updateErr;
            }
            markCompleted(projectId);
            recordAudit({
              project_id: projectId,
              credit_quality: scores.credit_quality,
              green_impact: scores.green_impact,
              tx_hash,
              triggered_by: "api",
            });
            broadcastScoreUpdate({
              project_id: projectId,
              credit_quality: scores.credit_quality,
              green_impact: scores.green_impact,
              timestamp: Date.now(),
            });
            console.log(`[oracle] project ${projectId}: cq=${scores.credit_quality} gi=${scores.green_impact} tx=${tx_hash}`);
            return { project_id: projectId, tx_hash, ...scores };
          } catch (err) {
            markFailed(projectId);
            throw err;
          }
        });

        if (result.skipped) {
          skipped.push({ project_id: projectId, reason: result.reason });
          console.log(`[oracle] skipping project ${projectId}: ${result.reason}`);
        } else {
          results.push(result);
        }
      } catch (err) {
        console.error(`[oracle] project ${projectId} failed:`, err);
        errors.push({ project_id: projectId, error: String(err) });
      }
    }

    res.json({ updated: results.length, results, errors, skipped });
  } catch (error) {
    console.error("[oracle] failed:", error);
    res.status(500).json({ error: "internal_error", message: "Failed to update scores" });
  }
});

/**
 * GET /admin/audit
 * Query: project_id=<int>, from=<unix-ms>, to=<unix-ms>, format=json|csv
 * Returns the immutable audit log of all score updates.
 */
router.get("/audit", (req: Request, res: Response, next: NextFunction) => {
  try {
    const project_id = parseOptionalInt(req.query.project_id as string | undefined, "project_id", 0) || undefined;
    const from = parseOptionalInt(req.query.from as string | undefined, "from", 0) || undefined;
    const to = parseOptionalInt(req.query.to as string | undefined, "to", 0) || undefined;

    if (from && to && from > to) {
      throw badRequest("from must be earlier than to");
    }

    const entries = getAuditLog({ project_id, from, to });
    const format = req.query.format === "csv" ? "csv" : "json";

    if (format === "csv") {
      res.set("Content-Type", "text/csv");
      res.set("Content-Disposition", "attachment; filename=\"audit-log.csv\"");
      res.send(auditToCsv(entries));
      return;
    }

    res.json({ count: entries.length, entries });
  } catch (err) {
    next(err);
  }
});

export default router;
