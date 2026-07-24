import { Router, Request, Response, NextFunction } from "express";
import { parseProjectId } from "../middleware/errors";
import { fetchSatelliteWithFallback } from "../lib/satellite-sources";
import { getSolarData, getSatelliteData } from "../lib/iot";

export { getSolarData, getSatelliteData };

const router = Router();

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
