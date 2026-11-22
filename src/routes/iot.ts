import { Router, Request, Response, NextFunction } from "express";
import { parseProjectId, badRequest } from "../middleware/errors";
import { fetchSolarData, fetchSatelliteData, getProjectCredentials } from "../providers/registry";
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
    const credentials = getProjectCredentials(id);
    const reading = await fetchSolarData(id, credentials);
    res.json({
      ...reading,
      data_source: reading.provenance?.source ?? (credentials ? "solaredge" : "simulator"),
    });
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
    let polygon: [number, number][] | undefined = undefined;

    if (polygonParam !== undefined) {
      try {
        polygon = JSON.parse(polygonParam);
      } catch (err) {
        throw badRequest("polygon must be a valid JSON array of coordinates");
      }

      if (!Array.isArray(polygon)) {
        throw badRequest("polygon must be an array of coordinate pairs");
      }

      if (polygon.length > 500) {
        throw badRequest("polygon contains too many vertices (max 500)");
      }

      for (const pt of polygon) {
        if (
          !Array.isArray(pt) ||
          pt.length !== 2 ||
          typeof pt[0] !== "number" ||
          typeof pt[1] !== "number" ||
          !Number.isFinite(pt[0]) ||
          !Number.isFinite(pt[1])
        ) {
          throw badRequest("polygon vertices must be [number, number] coordinates");
        }
      }
    }

    const credentials = getProjectCredentials(id);
    const reading = await fetchSatelliteData(id, polygon, credentials);
    res.json({
      ...reading,
      data_source: reading.provenance?.source ?? (credentials ? "sentinel-2" : "simulator"),
    });
  } catch (err) {
    next(err);
  }
});

export default router;
