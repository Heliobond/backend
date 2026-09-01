import { Router, Request, Response, NextFunction } from "express";
import { getSolarData, getSatelliteData } from "./iot";
import { computeScores } from "../lib/scoring";
import { updateImpactScore, getTotalProjects, updateScoreForProject } from "../lib/registry";
import { badRequest, parseOptionalInt, MAX_PROJECT_ID, errorBody } from "../middleware/errors";
import { recordAudit, getAuditLog, auditToCsv } from "../lib/audit";
import { broadcastScoreUpdate } from "../lib/websocket";
import { tryBeginUpdate, markCompleted, markFailed } from "../lib/duplicate-detection";
import { withProjectLock } from "../lib/request-queue";
import { config } from "../config";
import { logger } from "../lib/logger";
import { timingSafeCompare } from "../lib/timing-safe";

const router = Router();

router.use((req: Request, res: Response, next: NextFunction) => {
  const apiKey = config.ADMIN_API_KEY;
  if (!apiKey) {
    return res
      .status(500)
      .json(errorBody("server_misconfigured", "Admin API key is not configured"));
  }
  const authorization = req.headers.authorization ?? "";
  if (!timingSafeCompare(authorization, `Bearer ${apiKey}`)) {
    return res.status(401).json(errorBody("unauthorized", "Missing or invalid bearer token"));
  }
  next();
});

type ScoreUpdateResult = {
  project_id: number;
  tx_hash: string;
  credit_quality: number;
  green_impact: number;
};

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

function queryValue(value: unknown): string | string[] | undefined {
  if (typeof value === "string") return value;
  if (isStringArray(value)) return value;
  return undefined;
}

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

    const results: ScoreUpdateResult[] = [];
    const errors: Array<{ project_id: number; error: { code: string; message: string } }> = [];
    const skipped: Array<{ project_id: number; reason: string }> = [];

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
    next(error);
  }
});

export default router;
