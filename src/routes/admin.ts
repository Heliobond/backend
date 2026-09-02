import { Router, Request, Response, NextFunction } from "express";
import { errorBody } from "../middleware/errors";
import { getSolarData, getSatelliteData } from "./iot";
import { computeScores } from "../lib/scoring";
import { updateImpactScore, getTotalProjects } from "../lib/registry";
import { badRequest, parseOptionalInt, MAX_PROJECT_ID, errorBody } from "../middleware/errors";
import { recordAudit, getAuditLog, auditToCsv } from "../lib/audit";
import { broadcastScoreUpdate } from "../lib/websocket";
import { tryBeginUpdate, markCompleted, markFailed } from "../lib/duplicate-detection";
import { withProjectLock } from "../lib/request-queue";
import { updateScoreForProject } from "../lib/scoreService";
import { config } from "../config";
import { logger } from "../lib/logger";
import { extractApiKeyRole, requireApiKeyRole, requireApiKeyAuth } from "../middleware/requireApiKeyRole";

const router = Router();

// Apply role-based API key authentication to all admin routes
router.use(extractApiKeyRole);
router.use(requireApiKeyAuth);

/** A per-project score update that made it onto the ledger (or was deferred). */
type ScoreUpdateResult = {
  project_id: number;
  tx_hash: string;
  credit_quality: number;
  green_impact: number;
};

/**
 * Discriminated result of one locked project update. The `skipped` flag lets
 * the caller narrow the two shapes apart without a type assertion.
 */
type ProjectUpdateOutcome =
  { skipped: true; reason: string } | ({ skipped: false } & ScoreUpdateResult);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

/**
 * Narrow an Express query value to what `parseOptionalInt` accepts. Express
 * types query entries as a union that also covers nested objects; those are
 * treated as absent rather than being asserted into a string.
 */
function queryValue(value: unknown): string | string[] | undefined {
  if (typeof value === "string") return value;
  if (isStringArray(value)) return value;
  return undefined;
}

/**
 * Validate the optional `project_ids` field. Returns a list of ids, or `null`
 * to signal "update every registered project". Throws `ApiError` (400) on
 * anything that isn't an array of positive integers.
 *
 * Each entry is checked individually and copied into a `number[]`, so the
 * returned array is typed by construction rather than by assertion.
 */
function parseProjectIds(body: unknown): number[] | null {
  if (!isRecord(body)) return null;

  const raw = body.project_ids;
  if (raw === undefined || raw === null) return null;
  if (!Array.isArray(raw)) {
    throw badRequest("project_ids must be an array of positive integers");
  }
  if (raw.length === 0) return null;

  const projectIds: number[] = [];
  for (const entry of raw) {
    if (!isPositiveInteger(entry)) {
      throw badRequest("project_ids must contain only positive integers");
    }
    projectIds.push(entry);
  }
  if (!raw.every((n) => (n as number) <= MAX_PROJECT_ID)) {
    throw badRequest(`project_ids must not exceed maximum project id ${MAX_PROJECT_ID}`);
  }
  return raw as number[];
}

// POST /api/admin/update-scores
// Body: { project_ids?: number[] }  — defaults to all projects
// Returns: { updated: number, results: [...], errors: [...], skipped: [...] }
//
// All errors — including validation (400) and unexpected failures (500) — are
// forwarded to the central errorHandler via next() so status codes stay consistent
// across all endpoints. The nested per-project catch is intentional: it collects
// partial failures without aborting the entire batch.
router.post("/update-scores", requireApiKeyRole("admin:write"), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const requested = parseProjectIds(req.body);

    let projectIds: number[];

    if (requested) {
      projectIds = requested;
    } else {
      const total = await getTotalProjects();
      projectIds = Array.from({ length: total }, (_, i) => i + 1);
    }

    const results: ScoreUpdateResult[] = [];
    const errors: Array<{ project_id: number; error: { code: string; message: string } }> = [];
    const skipped: Array<{ project_id: number; reason: string }> = [];

    // Soroban does not support multi-call batching — submit sequentially.
    // Each project is individually isolated: a failure on one does not abort
    // the rest. Accumulated errors are returned alongside successes so callers
    // can retry only the affected ids.
    for (const projectId of projectIds) {
      try {
        const result = await withProjectLock<ProjectUpdateOutcome>(projectId, async () => {
          const { allowed, reason } = tryBeginUpdate(projectId);
          if (!allowed) {
            return { skipped: true, reason };
          }
          try {
            const scoreResult = await updateScoreForProject(projectId);

            if (scoreResult.status === "deferred") {
              logger.warn(`[oracle] project ${projectId}: RPC degraded, score queued for later`);
              markCompleted(projectId);
              return {
                skipped: false,
                project_id: projectId,
                tx_hash: "deferred",
                credit_quality: scoreResult.creditQuality,
                green_impact: scoreResult.greenImpact,
              };
            }

            if (scoreResult.status === "error") {
              throw new Error(scoreResult.error);
            }

            markCompleted(projectId);
            recordAudit({
              project_id: projectId,
              credit_quality: scoreResult.creditQuality,
              green_impact: scoreResult.greenImpact,
              tx_hash: scoreResult.txHash,
              triggered_by: "api",
            });
            broadcastScoreUpdate({
              project_id: projectId,
              credit_quality: scoreResult.creditQuality,
              green_impact: scoreResult.greenImpact,
              timestamp: Date.now(),
            });
            logger.info(
              `[oracle] project ${projectId}: cq=${scoreResult.creditQuality} gi=${scoreResult.greenImpact} tx=${scoreResult.txHash}`,
            );
            return {
              skipped: false,
              project_id: projectId,
              tx_hash: scoreResult.txHash,
              credit_quality: scoreResult.creditQuality,
              green_impact: scoreResult.greenImpact,
            };
          } catch (err) {
            markFailed(projectId);
            throw err;
          }
        });

        if (result.skipped) {
          skipped.push({ project_id: projectId, reason: result.reason });
          logger.info(`[oracle] skipping project ${projectId}: ${result.reason}`);
        } else {
          // Rebuilt field by field so the internal `skipped` discriminant does
          // not leak into the response body.
          results.push({
            project_id: result.project_id,
            tx_hash: result.tx_hash,
            credit_quality: result.credit_quality,
            green_impact: result.green_impact,
          });
        }
      } catch (err) {
        logger.error(`[oracle] project ${projectId} failed`, logger.formatError(err));
        errors.push({
          project_id: projectId,
          error: {
            code: "update_failed",
            message: err instanceof Error ? err.message : String(err),
          },
        });
      }
    }

    res.json({ updated: results.length, results, errors, skipped });
  } catch (error) {
    // Forward to errorHandler: ApiError → its .status (e.g. 400 for bad input),
    // SyntaxError → 400, anything else → 500.
    next(error);
  }
});

/**
 * GET /admin/audit
 * Query: project_id=<int>, from=<unix-ms>, to=<unix-ms>, format=json|csv
 * Returns the immutable audit log of all score updates.
 */
router.get("/audit", requireApiKeyRole("admin:read"), (req: Request, res: Response, next: NextFunction) => {
  try {
    const project_id =
      parseOptionalInt(queryValue(req.query.project_id), "project_id", 0) || undefined;
    const from = parseOptionalInt(queryValue(req.query.from), "from", 0) || undefined;
    const to = parseOptionalInt(queryValue(req.query.to), "to", 0) || undefined;

    if (from && to && from > to) {
      throw badRequest("from must be earlier than to");
    }

    const entries = getAuditLog({ project_id, from, to });
    const format = req.query.format === "csv" ? "csv" : "json";

    if (format === "csv") {
      res.set("Content-Type", "text/csv");
      res.set("Content-Disposition", 'attachment; filename="audit-log.csv"');
      res.send(auditToCsv(entries));
      return;
    }

    res.json({ count: entries.length, entries });
  } catch (err) {
    next(err);
  }
});

export default router;
