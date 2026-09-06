import { Router, Request, Response, NextFunction } from "express";
import {
  detectAnomalies,
  configureAnomalyDetection,
  getAnomalyConfig,
  clearHistory,
  AnomalyConfig,
} from "../lib/anomaly";
import { getSolarData, getSatelliteData } from "./iot";
import { parseProjectId, badRequest } from "../middleware/errors";

const router = Router();

/**
 * GET /v1/anomaly/:id
 * Run anomaly detection on a project's latest IoT readings.
 * Query params:
 *   sensitivity  – z-score threshold (number, optional)
 *   window       – baseline window size (number, optional)
 */
router.get("/:id", (req: Request, res: Response, next: NextFunction) => {
  try {
    const projectId = parseProjectId(req.params.id, "project id");
    const solar = getSolarData(projectId);
    const satellite = getSatelliteData(projectId);

    const config: Record<string, number> = {};
    if (req.query.sensitivity) {
      const sensitivity = Number(req.query.sensitivity);
      if (!Number.isFinite(sensitivity) || sensitivity <= 0) {
        throw badRequest("sensitivity must be a finite positive number");
      }
      config.sensitivityZScore = sensitivity;
    }
    if (req.query.window) {
      const window = Number(req.query.window);
      if (!Number.isFinite(window) || window <= 0) {
        throw badRequest("window must be a finite positive number");
      }
      config.trendWindowSize = window;
    }

    const result = detectAnomalies(
      projectId,
      {
        efficiency_pct: solar.efficiency_pct,
        power_output_kw: solar.power_output_kw,
        forest_density_pct: satellite.forest_density_pct,
        ndvi_score: satellite.ndvi_score,
      },
      Object.keys(config).length ? config : undefined,
    );

    res.json(result);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /v1/anomaly/config
 * Return the current anomaly detection configuration.
 */
router.get("/", (_req: Request, res: Response) => {
  res.json(getAnomalyConfig());
});

/**
 * PUT /v1/anomaly/config
 * Update anomaly detection sensitivity and window settings.
 * Body: { sensitivityZScore?, trendWindowSize?, trendDeviationPct?, minBaseline? }
 * Only the keys present in the body are applied; the rest keep their current values.
 */
router.put("/config", (req: Request, res: Response) => {
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
  res.json({ ok: true, config: getAnomalyConfig() });
});

/**
 * DELETE /v1/anomaly/history
 * Clear the baseline history for all projects.
 */
router.delete("/history", (_req: Request, res: Response) => {
  clearHistory();
  res.json({ ok: true, cleared: "all" });
});

/**
 * DELETE /v1/anomaly/history/:id
 * Clear the baseline history for a specific project.
 */
router.delete("/history/:id", (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = parseProjectId(req.params.id, "project id");
    clearHistory(id);
    res.json({ ok: true, cleared: id });
  } catch (err) {
    next(err);
  }
});

export default router;
