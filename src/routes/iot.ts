import { Router, Request, Response, NextFunction } from "express";
import { parseProjectId } from "../middleware/errors";
import { fetchSatelliteWithFallback } from "../lib/satellite-sources";
import { getSolarData } from "../lib/iot";
import { extractApiKeyRole } from "../middleware/requireApiKeyRole";

/**
 * The simulation itself lives in `../lib/iot`, which owns the seeded-random
 * generator and the hourly in-memory cache in front of it. These re-exports
 * keep the historical `routes/iot` import path working for existing callers
 * while there is only one implementation — and therefore one cache — behind it.
 */
export { seededRandom, getSolarData, getSatelliteData, getHourSeed } from "../lib/iot";

const router = Router();

// Optional API key authentication for IoT endpoints
// If a valid Bearer token is provided, req.apiKeyRole will be set
// Otherwise, routes can proceed without authentication
router.use(extractApiKeyRole);

router.get("/solar/:id", (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = parseProjectId(req.params.id, "project id");
    res.json(getSolarData(id));
  } catch (err) {
    next(err);
  }
});

router.get("/satellite/:id", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = parseProjectId(req.params.id, "project id");
    const data = await fetchSatelliteWithFallback(id);
    res.json(data);
  } catch (err) {
    next(err);
  }
});

export default router;
