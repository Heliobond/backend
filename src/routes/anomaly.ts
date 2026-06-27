import { Router, Request, Response, NextFunction } from "express";
import { detectAnomalies, configureAnomalyDetection, getAnomalyConfig, clearHistory } from "../lib/anomaly";
import { getSolarData, getSatelliteData } from "./iot";
import { parseProjectId } from "../middleware/errors";

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
    if (req.query.sensitivity) config.sensitivityZScore = Number(req.query.sensitivity);
    if (req.query.window) config.trendWindowSize = Number(req.query.window);

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
 */
router.put("/config", (req: Request, res: Response) => {
  const { sensitivityZScore, trendWindowSize, trendDeviationPct, minBaseline } = req.body as Record<string, number>;
  configureAnomalyDetection({ sensitivityZScore, trendWindowSize, trendDeviationPct, minBaseline });
  res.json({ ok: true, config: getAnomalyConfig() });
});

/**
 * DELETE /v1/anomaly/history/:id?
 * Clear the baseline history for a specific project (or all projects).
 */
router.delete("/history/:id?", (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = req.params.id ? parseProjectId(req.params.id, "project id") : undefined;
    clearHistory(id);
    res.json({ ok: true, cleared: id ?? "all" });
  } catch (err) {
    next(err);
  }
});

export default router;
