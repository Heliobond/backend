import { Router, Request, Response, NextFunction } from "express";
import { parseProjectId, badRequest, errorBody } from "../middleware/errors";
import { apiKeyAuth } from "../middleware/apiKeyAuth";
import {
  evaluateAllBenchmarks,
  evaluateProjectBenchmark,
  getPercentileRanking,
  checkBenchmarkAlerts,
  trendVsBenchmark,
  getBenchmarks,
  getBenchmarkById,
  defineCustomBenchmark,
  BenchmarkDefinition,
} from "../lib/benchmarking";

const router = Router();

const VALID_METRICS = [
  "credit_quality",
  "green_impact",
  "combined_score",
  "power_output_kw",
  "efficiency_pct",
  "forest_density_pct",
  "ndvi_score",
] as const;

function requireAdminAccess(req: Request, res: Response, next: NextFunction): void {
  const adminKey = process.env.ADMIN_API_KEY;
  if (!adminKey) {
    res.status(401).json(errorBody("unauthorized", "Admin API key is not configured"));
    return;
  }

  const authHeader = req.headers.authorization;
  const providedKey = req.headers["x-api-key"];

  const isAuthorized =
    (typeof providedKey === "string" && providedKey === adminKey) ||
    (typeof authHeader === "string" && authHeader === `Bearer ${adminKey}`);

  if (!isAuthorized) {
    res.status(401).json(errorBody("unauthorized", "Admin access required"));
    return;
  }

  next();
}

router.get("/benchmarks", (_req: Request, res: Response) => {
  res.json({ benchmarks: getBenchmarks() });
});

router.get("/benchmarks/:id", (req: Request, res: Response) => {
  const id = req.params.id as string;
  const benchmark = getBenchmarkById(id);
  if (!benchmark) {
    return res.status(404).json(errorBody("not_found", `Benchmark "${id}" not found`));
  }
  res.json(benchmark);
});

router.post(
  "/benchmarks",
  requireAdminAccess,
  (req: Request, res: Response, next: NextFunction) => {
    const { name, description, metric, thresholds, source, id } = req.body;
    if (!name || !metric || !thresholds) {
      return next(badRequest("name, metric, and thresholds are required"));
    }

    if (!VALID_METRICS.includes(metric)) {
      return next(badRequest(`metric must be one of: ${VALID_METRICS.join(", ")}`));
    }

    const { poor, fair, good, excellent } = thresholds;
    if (
      [poor, fair, good, excellent].some(
        (v: number) => typeof v !== "number" || !Number.isFinite(v),
      )
    ) {
      return next(badRequest("thresholds must have numeric poor, fair, good, excellent values"));
    }
    if (poor > fair || fair > good || good > excellent) {
      return next(badRequest("thresholds must be ordered poor <= fair <= good <= excellent"));
    }

    const requestedId = typeof id === "string" && id.trim().length > 0 ? id.trim() : undefined;
    const benchmarkId = requestedId ?? String(name).trim().toLowerCase().replace(/\s+/g, "_");
    if (getBenchmarkById(benchmarkId)) {
      return next(badRequest(`Benchmark "${benchmarkId}" already exists`));
    }

    const benchmark = defineCustomBenchmark({
      name,
      description,
      metric,
      thresholds,
      source,
      id: benchmarkId,
    });
    res.status(201).json(benchmark);
  },
);

router.get("/:id", (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = parseProjectId(req.params.id, "project id");
    const results = evaluateAllBenchmarks(id);
    res.json({ project_id: id, benchmarks: results });
  } catch (error) {
    next(error);
  }
});

router.get("/:id/percentiles", (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = parseProjectId(req.params.id, "project id");
    const metric = (req.query.metric as string) ?? "combined_score";
    const result = getPercentileRanking(id, metric);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

router.get("/:id/alerts", (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = parseProjectId(req.params.id, "project id");
    const alerts = checkBenchmarkAlerts(id);
    res.json({ project_id: id, alerts, count: alerts.length });
  } catch (error) {
    next(error);
  }
});

router.get("/:id/trend", (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = parseProjectId(req.params.id, "project id");
    const metric = (req.query.metric as string) ?? "credit_quality";
    const benchmarkId = (req.query.benchmark as string) ?? "credit_quality";

    const benchmark = getBenchmarkById(benchmarkId);
    if (!benchmark) {
      return res.status(404).json(errorBody("not_found", `Benchmark "${benchmarkId}" not found`));
    }

    const result = trendVsBenchmark(id, metric, benchmarkId);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

export default router;
