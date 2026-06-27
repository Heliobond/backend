import { Router, Request, Response, NextFunction } from "express";
import { getTotalProjects } from "../lib/registry";
import { getSolarData, getSatelliteData } from "./iot";
import { computeScores } from "../lib/scoring";
import { badRequest, parseProjectId, parseOptionalInt } from "../middleware/errors";

const router = Router();

const SORTABLE_FIELDS = [
  "id",
  "credit_quality",
  "green_impact",
  "power_output_kw",
  "efficiency_pct",
  "forest_density_pct",
  "ndvi_score",
  "timestamp",
] as const;

type SortableField = (typeof SORTABLE_FIELDS)[number];

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
  filtered_total: number;
  cursor?: number;
}

interface ProjectDetailResponse extends ProjectData {
  funding?: number;
}

function parseOptionalFloat(
  raw: string | undefined,
  field: string,
): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!isFinite(n)) throw badRequest(`${field} must be a number`);
  return n;
}

router.get("/", async (req: Request, res: Response, next: NextFunction) => {
  const limit = Math.min(
    parseOptionalInt(req.query.limit as string | undefined, "limit", 10),
    100,
  );
  const cursor = parseOptionalInt(
    req.query.cursor as string | undefined,
    "cursor",
    0,
  );

  const minScore = parseOptionalFloat(req.query.min_score as string | undefined, "min_score");
  const maxScore = parseOptionalFloat(req.query.max_score as string | undefined, "max_score");
  const minDate = parseOptionalFloat(req.query.min_date as string | undefined, "min_date");
  const maxDate = parseOptionalFloat(req.query.max_date as string | undefined, "max_date");

  const sortByRaw = (req.query.sort_by as string | undefined) ?? "id";
  if (!SORTABLE_FIELDS.includes(sortByRaw as SortableField)) {
    return next(badRequest(`sort_by must be one of: ${SORTABLE_FIELDS.join(", ")}`));
  }
  const sortBy = sortByRaw as SortableField;

  const sortOrderRaw = (req.query.sort_order as string | undefined) ?? "asc";
  if (sortOrderRaw !== "asc" && sortOrderRaw !== "desc") {
    return next(badRequest("sort_order must be 'asc' or 'desc'"));
  }
  const sortOrder = sortOrderRaw as "asc" | "desc";

  try {
    const total = await getTotalProjects();
    const ids = Array.from({ length: total }, (_, i) => i + 1);

    const allProjects: ProjectData[] = [];
    for (const id of ids) {
      const solar = getSolarData(id);
      const satellite = getSatelliteData(id);
      const scores = computeScores({ solar, satellite });
      allProjects.push({
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

    let filtered = allProjects;
    if (minScore !== undefined) filtered = filtered.filter((p) => p.credit_quality >= minScore!);
    if (maxScore !== undefined) filtered = filtered.filter((p) => p.credit_quality <= maxScore!);
    if (minDate !== undefined) filtered = filtered.filter((p) => p.timestamp >= minDate!);
    if (maxDate !== undefined) filtered = filtered.filter((p) => p.timestamp <= maxDate!);

    filtered.sort((a, b) => {
      const diff = a[sortBy] - b[sortBy];
      return sortOrder === "asc" ? diff : -diff;
    });

    const filteredTotal = filtered.length;
    const paginated = filtered.slice(cursor, cursor + limit);

    const response: ProjectListResponse = {
      projects: paginated,
      total,
      filtered_total: filteredTotal,
      ...(cursor + limit < filteredTotal && { cursor: cursor + limit }),
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
