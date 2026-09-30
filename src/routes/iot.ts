import { Router, Request, Response, NextFunction } from "express";
import { parseProjectId } from "../middleware/errors";
import { fetchSolarData, fetchSatelliteData } from "../providers/registry";
import { extractApiKeyRole } from "../middleware/requireApiKeyRole";

/**
 * Issue #653: Pluggable real data sources.
 * Routes now use provider registry with fallback support.
 */
export { seededRandom, getSolarData, getSatelliteData, getHourSeed } from "../lib/iot";

const router = Router();

router.use(extractApiKeyRole);

/**
 * GET /v1/iot/solar/:id
 * Fetch solar data using provider fallback (SolarEdge → Simulator)
 */
router.get("/solar/:id", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = parseProjectId(req.params.id, "project id");
    // TODO: Load project credentials from database
    const credentials = undefined; // Will fallback to simulator
    const reading = await fetchSolarData(id, credentials);
    res.json(reading);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /v1/iot/satellite/:id
 * Fetch satellite data using provider fallback (Sentinel-2 → Simulator)
 */
router.get("/satellite/:id", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = parseProjectId(req.params.id, "project id");
    const polygonParam = req.query.polygon as string | undefined;
    const polygon = polygonParam ? JSON.parse(polygonParam) : undefined;
    const credentials = undefined; // Will fallback to simulator
    const reading = await fetchSatelliteData(id, polygon, credentials);
    res.json(reading);
  } catch (err) {
    next(err);
  }
});

export default router;
