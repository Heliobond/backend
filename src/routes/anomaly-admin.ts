import { Router, Request, Response, NextFunction } from "express";
import {
  configureAnomalyDetection,
  getAnomalyConfig,
  clearHistory,
  AnomalyConfig,
} from "../lib/anomaly";
import { parseProjectId } from "../middleware/errors";
import { writeAuditLog } from "../lib/audit-logger";
import { getCorrelationId } from "../lib/correlation";

const router = Router();

/**
 * PUT /v1/anomaly/config
 * Update anomaly detection sensitivity and window settings.
 * Body: { sensitivityZScore?, trendWindowSize?, trendDeviationPct?, minBaseline? }
 * Only the keys present in the body are applied; the rest keep their current values.
 *
 * SECURITY (Issue #762): Requires admin authentication
 * - ipWhitelist
 * - adminLimiter
 * - requireAdminBearer
 * - requestSigning
 */
router.put("/config", (req: Request, res: Response) => {
  const oldConfig = getAnomalyConfig();

  const body = (req.body ?? {}) as Record<string, unknown>;
  const update: Partial<AnomalyConfig> = {};
  for (const key of [
    "sensitivityZScore",
    "trendWindowSize",
    "trendDeviationPct",
    "minBaseline",
  ] as const) {
    if (body[key] !== undefined) update[key] = body[key] as number;
  }
  configureAnomalyDetection(update);

  const newConfig = getAnomalyConfig();

  // Record audit entry for config change (Issue #762)
  writeAuditLog({
    action: "anomaly_config_update",
    correlation_id: getCorrelationId(),
    ip: req.ip ?? null,
    user_agent: req.headers["user-agent"] ?? null,
    project_ids: [],
    success: true,
    results: {
      old_config: oldConfig,
      new_config: newConfig,
      changes: update,
    },
  });

  res.json({ ok: true, config: newConfig });
});

/**
 * DELETE /v1/anomaly/history and DELETE /v1/anomaly/history/:id
 * Clear the baseline history for a specific project (or all projects).
 * Two explicit routes because path-to-regexp v8 (Express 5) dropped the `?`
 * suffix that older Express accepted for optional params.
 *
 * SECURITY (Issue #762): Requires admin authentication
 */
const clearAnomalyHistory = (req: Request, res: Response, next: NextFunction) => {
  try {
    // `/history` has no `:id` param, which means "clear every project".
    const id = req.params.id ? parseProjectId(req.params.id, "project id") : undefined;
    clearHistory(id);

    // Record audit entry for history clear (Issue #762)
    writeAuditLog({
      action: "anomaly_history_clear",
      correlation_id: getCorrelationId(),
      ip: req.ip ?? null,
      user_agent: req.headers["user-agent"] ?? null,
      project_ids: id !== undefined ? [id] : [],
      success: true,
      results: {
        cleared: id ?? "all",
      },
    });

    res.json({ ok: true, cleared: id ?? "all" });
  } catch (err) {
    next(err);
  }
};

router.delete("/history", clearAnomalyHistory);
router.delete("/history/:id", clearAnomalyHistory);

export default router;
