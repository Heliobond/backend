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
