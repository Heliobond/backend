import { Router, Request, Response, NextFunction } from "express";
import { getSolarData, getSatelliteData } from "./iot";
import { computeScores } from "../lib/scoring";
import { updateImpactScore, getTotalProjects } from "../lib/registry";
import { ApiError, badRequest, parseOptionalInt } from "../middleware/errors";
import { recordAudit, getAuditLog, auditToCsv } from "../lib/audit";
import { broadcastScoreUpdate } from "../lib/websocket";

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
//
// All errors — including validation (400) and unexpected failures (500) — are
// forwarded to the central errorHandler via next() so status codes stay consistent
// across all endpoints. The nested per-project catch is intentional: it collects
// partial failures without aborting the entire batch.
router.post("/update-scores", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const requested = parseProjectIds(req.body);

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

    // Soroban does not support multi-call batching — submit sequentially.
    // Each project is individually isolated: a failure on one does not abort
    // the rest. Accumulated errors are returned in the response body alongside
    // the successes so callers can retry only the affected ids.
    for (const projectId of projectIds) {
      try {
        const solar = getSolarData(projectId);
        const satellite = getSatelliteData(projectId);
        const scores = computeScores({ solar, satellite });
        const tx_hash = await updateImpactScore(projectId, scores.credit_quality, scores.green_impact);
        results.push({ project_id: projectId, tx_hash, ...scores });
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
      } catch (err) {
        // Log full error context so it is visible in server logs even though
        // we keep the batch running. Callers receive the stringified reason in
        // the errors array so they can diagnose without tailing logs.
        console.error(`[oracle] project ${projectId} failed:`, err);
        errors.push({ project_id: projectId, error: String(err) });
      }
    }

    res.json({ updated: results.length, results, errors });
  } catch (error) {
    // Forward to errorHandler: ApiError → its .status (e.g. 400 for bad input),
    // SyntaxError → 400, anything else → 500. Avoids silently swallowing errors
    // or hard-coding 500 for cases that are actually the caller's fault.
    next(error);
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
