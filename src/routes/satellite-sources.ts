import { Router, Request, Response as ExpressResponse, NextFunction } from "express";
import {
  getSources,
  configureSource,
  fetchSatelliteWithFallback,
  getSourceHealth,
  registerSource,
} from "../lib/satellite-sources";
import { parseProjectId, badRequest } from "../middleware/errors";

const router = Router();

/** GET /v1/satellite-sources — list all configured sources with health */
router.get("/", (_req: Request, res: ExpressResponse) => {
  const sources = getSources();
  const health = getSourceHealth();
  const healthMap = Object.fromEntries(health.map((h) => [h.name, h]));
  res.json({
    sources: sources.map((s) => ({
      name: s.name,
      priority: s.priority,
      enabled: s.enabled,
      health: healthMap[s.name] ?? { healthy: true, failureCount: 0 },
    })),
  });
});

/** GET /v1/satellite-sources/health — data source health status */
router.get("/health", (_req: Request, res: ExpressResponse) => {
  res.json(getSourceHealth());
});

/**
 * PATCH /v1/satellite-sources/:name — configure a source (enable/disable, priority)
 */
router.patch("/:name", (req: Request, res: ExpressResponse) => {
  const { enabled, priority } = req.body as { enabled?: boolean; priority?: number };

  if (priority !== undefined && (!Number.isInteger(priority) || priority < 1)) {
    throw badRequest("priority must be a positive integer");
  }

  const ok = configureSource(String(req.params.name), { enabled, priority });
  if (!ok) return res.status(404).json({ error: "source not found" });
import { Router, Request, Response, NextFunction } from "express";
import { badRequest, errorBody } from "../middleware/errors";
import { config } from "../config";
import { logger } from "../lib/logger";

const router = Router();

const CUSTOM_SOURCE_FETCH_TIMEOUT_MS = 10000;

async function fetchFromCustomUrl(
  fetchUrl: string,
  projectId: number,
  sourceName: string,
): Promise<{ forest_density_pct: number; ndvi_score: number; timestamp: number; source: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CUSTOM_SOURCE_FETCH_TIMEOUT_MS);

  let httpResponse: any;
  let response: globalThis.Response;
  try {
    httpResponse = await fetch(`${fetchUrl}?projectId=${encodeURIComponent(String(projectId))}`, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }

  if (!httpResponse.ok) {
    throw new Error(`Custom source ${sourceName} returned HTTP ${httpResponse.status}`);
  }

  const body = (await httpResponse.json()) as {
    forest_density_pct?: unknown;
    ndvi_score?: unknown;
  };

  if (body.forest_density_pct === undefined || body.forest_density_pct === null) {
    throw new Error(`Custom source ${sourceName} response missing forest_density_pct`);
  }

  return {
    forest_density_pct: body.forest_density_pct,
    ndvi_score: body.ndvi_score,
    timestamp: Date.now(),
    source: sourceName,
  };
}

/**
 * POST /v1/satellite-sources — register a custom data source adapter.
 * Body: { name, priority, fetchUrl } — fetchUrl is the external endpoint
 * queried (via `?projectId=<id>`) for live satellite readings.
 */
router.post("/", (req: Request, res: ExpressResponse) => {
  const { name, priority, fetchUrl } = req.body as {
    name?: string;
    priority?: number;
    fetchUrl?: string;
  };

  if (!name || typeof name !== "string") {
    return res.status(400).json({ error: "name is required" });
  if (body.ndvi_score === undefined || body.ndvi_score === null) {
    throw new Error(`Custom source ${sourceName} response missing ndvi_score`);
  }

  const density = Number(body.forest_density_pct);
  const ndvi = Number(body.ndvi_score);

  if (isNaN(density) || density < 0 || density > 100) {
    throw new Error(`Custom source ${sourceName} returned invalid forest_density_pct: ${body.forest_density_pct}`);
  }
  if (isNaN(ndvi) || ndvi < 0 || ndvi > 100) {
    throw new Error(`Custom source ${sourceName} returned invalid ndvi_score: ${body.ndvi_score}`);
  try {
     
    new URL(fetchUrl);
  } catch {
    return res.status(400).json({ error: "fetchUrl must be a valid URL" });
  }

  return {
    forest_density_pct: density,
    ndvi_score: ndvi,
    timestamp: Date.now(),
    source: `custom:${sourceName}`,
  };
}

/**
 * GET /v1/satellite-sources/fetch/:projectId
 * Fetch satellite data using the primary source with automatic fallback.
 */
router.get("/fetch/:projectId", async (req: Request, res: ExpressResponse, next: NextFunction) => {
router.get("/", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const projectIdRaw = req.query.projectId;
    if (!projectIdRaw) {
      throw badRequest("Missing required query parameter: projectId");
    }
    const projectId = parseInt(String(projectIdRaw), 10);
    if (isNaN(projectId) || projectId <= 0) {
      throw badRequest("Invalid projectId parameter");
    }

    const sourceName = req.query.source;
    if (!sourceName || typeof sourceName !== "string") {
      throw badRequest("Missing or invalid required query parameter: source");
    }

    const customSources = config.CUSTOM_SATELLITE_SOURCES as Record<string, string> | undefined;
    const fetchUrl = customSources?.[sourceName];

    if (!fetchUrl) {
      return res.status(404).json(errorBody("source_not_found", `Satellite source '${sourceName}' is not configured`));
    }

    logger.info(`[satellite] fetching data for project ${projectId} from custom source ${sourceName}`);
    const data = await fetchFromCustomUrl(fetchUrl, projectId, sourceName);
    
    res.json(data);
  } catch (error) {
    next(error);
  }
});

export default router;
