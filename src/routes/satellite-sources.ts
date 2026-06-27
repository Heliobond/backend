import { Router, Request, Response, NextFunction } from "express";
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

  const ok = configureSource(req.params.name, { enabled, priority });
  if (!ok) return res.status(404).json({ error: "source not found" });

  res.json({ ok: true, sources: getSources() });
});

/**
 * POST /v1/satellite-sources — register a custom data source adapter.
 * Body: { name, priority, fetchUrl } — fetchUrl is a placeholder for an external endpoint.
 */
router.post("/", (req: Request, res: Response) => {
  const { name, priority, fetchUrl } = req.body as {
    name?: string;
    priority?: number;
    fetchUrl?: string;
  };

  if (!name || typeof name !== "string") {
    return res.status(400).json({ error: "name is required" });
  }

  const sourcePriority = typeof priority === "number" ? priority : 99;

  registerSource({
    name,
    priority: sourcePriority,
    enabled: true,
    async fetch(projectId: number) {
      if (fetchUrl) {
        // Real adapter would call fetchUrl; for now return a placeholder
        return {
          forest_density_pct: 50,
          ndvi_score: 0.5,
          timestamp: Date.now(),
          source: name,
        };
      }
      throw new Error(`Custom source ${name} has no fetchUrl configured`);
    },
  });

  res.status(201).json({ ok: true, name, priority: sourcePriority });
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
