import { Router, Request, Response, NextFunction } from "express";
import { getTotalProjects } from "../lib/registry";
import { getSolarData, getSatelliteData } from "./iot";
import { computeScores } from "../lib/scoring";
import { parseProjectId, parseOptionalInt } from "../middleware/errors";

const router = Router();

interface ProjectData {
  id: number;
  credit_quality: number;
  green_impact: number;
  power_output_kw: number;
  efficiency_pct: number;
  forest_density_pct: number;
  ndvi_score: number;
  timestamp: number;
}

interface ProjectListResponse {
  projects: ProjectData[];
  total: number;
  cursor?: number;
}

interface ProjectDetailResponse extends ProjectData {
  funding?: number;
}

router.get("/", async (req: Request, res: Response, next: NextFunction) => {
  // Validation throws ApiError -> handled by the central error middleware as 400.
  const limit = Math.min(parseOptionalInt(req.query.limit as string | undefined, "limit", 10), 100);
  const cursor = parseOptionalInt(req.query.cursor as string | undefined, "cursor", 0);

  try {
    const total = await getTotalProjects();
    const ids = Array.from({ length: total }, (_, i) => i + 1);

    const paginated = ids.slice(cursor, cursor + limit);
    const projects: ProjectData[] = [];

    for (const id of paginated) {
      const solar = getSolarData(id);
      const satellite = getSatelliteData(id);
      const scores = computeScores({ solar, satellite });

      projects.push({
        id,
        credit_quality: scores.credit_quality,
        green_impact: scores.green_impact,
        power_output_kw: solar.power_output_kw,
        efficiency_pct: solar.efficiency_pct,
        forest_density_pct: satellite.forest_density_pct,
        ndvi_score: satellite.ndvi_score,
        timestamp: Math.max(solar.timestamp, satellite.timestamp),
      });
    }

    const response: ProjectListResponse = {
      projects,
      total,
      ...(cursor + limit < total && { cursor: cursor + limit }),
    };

    res.json(response);
  } catch (error) {
    console.error("[projects] list error:", error);
    next(error);
  }
});

router.get("/:id", async (req: Request, res: Response, next: NextFunction) => {
  const id = parseProjectId(req.params.id, "project id");

  try {
    const solar = getSolarData(id);
    const satellite = getSatelliteData(id);
    const scores = computeScores({ solar, satellite });

    const response: ProjectDetailResponse = {
      id,
      credit_quality: scores.credit_quality,
      green_impact: scores.green_impact,
      power_output_kw: solar.power_output_kw,
      efficiency_pct: solar.efficiency_pct,
      forest_density_pct: satellite.forest_density_pct,
      ndvi_score: satellite.ndvi_score,
      timestamp: Math.max(solar.timestamp, satellite.timestamp),
      funding: Math.random() * 1000000,
    };

    res.json(response);
  } catch (error) {
    console.error("[projects] detail error:", error);
    next(error);
  }
});

export default router;
