import { Router, Request, Response, NextFunction } from "express";
import { getTotalProjects, projectExists } from "../lib/registry";
import { logger } from "../lib/logger";
import { getSolarData, getSatelliteData, seededRandom } from "./iot";
import { computeScores } from "../lib/scoring";
import { getMetadata } from "../lib/metadata";
import {
  ApiError,
  badRequest,
  parseProjectId,
  parseOptionalInt,
  MAX_U32_PROJECT_ID,
} from "../middleware/errors";

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
  page: number;
  pageSize: number;
  hasMore: boolean;
  /** Legacy cursor alias: the offset of the next page when one exists. */
  cursor?: number;
}

interface ProjectSummary {
  id: number;
  credit_quality: number;
  green_impact: number;
}

interface ProjectDetailData {
  power_output_kw: number;
  efficiency_pct: number;
  forest_density_pct: number;
  ndvi_score: number;
  timestamp: number;
  funding: number;
}

/** Nested detail shape the frontend's `ProjectWithDetail` expects (#768). */
interface ProjectWithDetailResponse {
  project: ProjectSummary;
  detail: ProjectDetailData;
  verifiedMetadata: boolean;
}

/** Default page size, mirrored from the historical `limit` default. */
const DEFAULT_PAGE_SIZE = 10;
/** Hard cap on `pageSize`/`limit` so a single request can't scan the registry. */
const MAX_PAGE_SIZE = 100;

function parseOptionalFloat(raw: string | undefined, field: string): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!isFinite(n)) throw badRequest(`${field} must be a number`);
  return n;
}

router.get("/", async (req: Request, res: Response, next: NextFunction) => {
  // `page`/`pageSize` are the frontend contract (#768). `limit` is kept as an
  // alias for `pageSize`, and `cursor` remains a working offset alias so
  // existing cursor clients are not broken.
  const page = Math.max(parseOptionalInt(req.query.page as string | undefined, "page", 1), 1);
  const limitParam = parseOptionalInt(
    req.query.limit as string | undefined,
    "limit",
    DEFAULT_PAGE_SIZE,
  );
  const pageSize = Math.min(
    Math.max(parseOptionalInt(req.query.pageSize as string | undefined, "pageSize", limitParam), 1),
    MAX_PAGE_SIZE,
  );
  const hasCursor = req.query.cursor !== undefined;
  const cursorParam = parseOptionalInt(req.query.cursor as string | undefined, "cursor", 0);
  const offset = hasCursor ? cursorParam : (page - 1) * pageSize;

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
    const paginated = filtered.slice(offset, offset + pageSize);
    const hasMore = offset + pageSize < filteredTotal;
    // Report the page consistent with the effective offset, so a cursor client
    // still receives a sensible `page` value.
    const effectivePage = Math.floor(offset / pageSize) + 1;

    const response: ProjectListResponse = {
      projects: paginated,
      total,
      filtered_total: filteredTotal,
      page: effectivePage,
      pageSize,
      hasMore,
      ...(hasMore && { cursor: offset + pageSize }),
    };

    res.json(response);
  } catch (error) {
    logger.error("[projects] list error", logger.formatError(error));
    next(error);
  }
});

router.get("/:id", async (req: Request, res: Response, next: NextFunction) => {
  // Validate against the contract's u32 range, then let the registry decide
  // existence — the deployment's synthetic MAX_PROJECT_ID is not a data bound.
  const id = parseProjectId(req.params.id, "project id", { max: MAX_U32_PROJECT_ID });

  try {
    // Existence is sourced from the registry (`get_project`), not from the
    // synthetic `MAX_PROJECT_ID` bound: unknown and deleted ids 404 instead of
    // receiving fabricated metrics (#768).
    if (!(await projectExists(id))) {
      throw new ApiError(404, "not_found", `Project ${id} not found`);
    }

    const solar = getSolarData(id);
    const satellite = getSatelliteData(id);
    const scores = computeScores({ solar, satellite });

    const response: ProjectWithDetailResponse = {
      project: {
        id,
        credit_quality: scores.credit_quality,
        green_impact: scores.green_impact,
      },
      detail: {
        power_output_kw: solar.power_output_kw,
        efficiency_pct: solar.efficiency_pct,
        forest_density_pct: satellite.forest_density_pct,
        ndvi_score: satellite.ndvi_score,
        timestamp: Math.max(solar.timestamp, satellite.timestamp),
        funding: seededRandom(id * 13 + 7) * 1000000,
      },
      // Surface whether the backend holds metadata for the project so the
      // frontend's optional `verifiedMetadata` flag is meaningful.
      verifiedMetadata: getMetadata(id) !== undefined,
    };

    res.json(response);
  } catch (error) {
    if (!(error instanceof ApiError)) {
      logger.error("[projects] detail error", logger.formatError(error));
    }
    next(error);
  }
});

export default router;
