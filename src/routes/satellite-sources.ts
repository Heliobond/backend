import { Router, Request, Response, NextFunction } from "express";
import {
  getSources,
  configureSource,
  fetchSatelliteWithFallback,
  getSourceHealth,
  registerSource,
  getCustomFetchUrl,
} from "../lib/satellite-sources";
import { parseProjectId, badRequest, errorBody } from "../middleware/errors";
import { validatePublicUrl } from "../lib/ssrf";

const router = Router();

/** GET /v1/satellite-sources — list all configured sources with health */
router.get("/", (_req: Request, res: Response) => {
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
router.get("/health", (_req: Request, res: Response) => {
  res.json(getSourceHealth());
});

/**
 * PATCH /v1/satellite-sources/:name — configure a source (enable/disable, priority)
 */
router.patch("/:name", (req: Request, res: Response) => {
  const { enabled, priority } = req.body as { enabled?: boolean; priority?: number };

  if (priority !== undefined && (!Number.isInteger(priority) || priority < 1)) {
    throw badRequest("priority must be a positive integer");
  }

  const ok = configureSource(String(req.params.name), { enabled, priority });
  if (!ok) return res.status(404).json(errorBody("not_found", "source not found"));

  res.json({ ok: true, sources: getSources() });
});

/** Timeout for outbound requests to custom satellite source endpoints. */
const CUSTOM_SOURCE_FETCH_TIMEOUT_MS = 10_000;

/**
 * Call a custom source's fetchUrl for a project and validate the response
 * shape. Expects JSON with numeric forest_density_pct and ndvi_score fields.
 */
async function fetchFromCustomUrl(
  projectId: number,
  sourceName: string,
): Promise<{ forest_density_pct: number; ndvi_score: number; timestamp: number; source: string }> {
  // Read the endpoint back from the registry at call time.
  const fetchUrl = getCustomFetchUrl(sourceName);
  if (fetchUrl === undefined) {
    throw new Error(`Custom source ${sourceName} has no registered fetch URL`);
  }

  // Re-validate immediately before sending to avoid DNS rebinding attacks after registration.
  await validatePublicUrl(fetchUrl);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CUSTOM_SOURCE_FETCH_TIMEOUT_MS);

  // `Response` refers to the express type here, so derive the fetch type.
  let response: Awaited<ReturnType<typeof fetch>>;
  try {
    response = await fetch(`${fetchUrl}?projectId=${encodeURIComponent(String(projectId))}`, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    throw new Error(`Custom source ${sourceName} returned HTTP ${response.status}`);
  }

  const body = (await response.json()) as {
    forest_density_pct?: unknown;
    ndvi_score?: unknown;
  };

  if (typeof body.forest_density_pct !== "number" || typeof body.ndvi_score !== "number") {
    throw new Error(
      `Custom source ${sourceName} returned an invalid response shape (expected numeric forest_density_pct and ndvi_score)`,
    );
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
router.post("/", async (req: Request, res: Response) => {
  const { name, priority, fetchUrl } = req.body as {
    name?: string;
    priority?: number;
    fetchUrl?: string;
  };

  const NAME_RE = /^[a-z0-9_-]{1,64}$/i;
  if (!name || typeof name !== "string" || !NAME_RE.test(name.trim())) {
    return res
      .status(400)
      .json(
        errorBody("bad_request", "name must be 1-64 characters (alphanumeric, dash, underscore)"),
      );
  }

  const cleanName = name.trim();
  if (cleanName === "sentinel-2" || cleanName === "landsat-8") {
    return res
      .status(400)
      .json(errorBody("bad_request", `Cannot replace built-in source "${cleanName}"`));
  }

  if (priority !== undefined && (!Number.isInteger(priority) || priority < 1)) {
    return res.status(400).json(errorBody("bad_request", "priority must be a positive integer"));
  }

  if (!fetchUrl || typeof fetchUrl !== "string") {
    return res.status(400).json(errorBody("bad_request", "fetchUrl is required"));
  }

  // SSRF guard: only allow http/https URLs that resolve to public addresses.
  let validatedUrl: string;
  try {
    validatedUrl = await validatePublicUrl(fetchUrl);
  } catch (err) {
    return res
      .status(400)
      .json(
        errorBody(
          "bad_request",
          err instanceof Error ? err.message : "fetchUrl must be a valid URL",
        ),
      );
  }

  const sourcePriority = typeof priority === "number" ? priority : 99;

  try {
    registerSource(
      {
        name: cleanName,
        priority: sourcePriority,
        enabled: true,
        fetch: (projectId: number) => fetchFromCustomUrl(projectId, cleanName),
      },
      validatedUrl,
    );
  } catch (err) {
    return res
      .status(400)
      .json(errorBody("bad_request", err instanceof Error ? err.message : String(err)));
  }

  res.status(201).json({ ok: true, name: cleanName, priority: sourcePriority });
});

/**
 * GET /v1/satellite-sources/fetch/:projectId
 * Fetch satellite data using the primary source with automatic fallback.
 */
router.get("/fetch/:projectId", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const projectId = parseProjectId(req.params.projectId, "project id");
    const data = await fetchSatelliteWithFallback(projectId);
    res.json(data);
  } catch (err) {
    next(err);
  }
});

export default router;
