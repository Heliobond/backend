import { Router, Request, Response, NextFunction } from "express";
import { parseProjectId, badRequest, notFound } from "../middleware/errors";
import { requireAdminBearer } from "../middleware/requireAdminBearer";
import {
  evaluateAllBenchmarks,
  getPercentileRanking,
  checkBenchmarkAlerts,
  trendVsBenchmark,
  getBenchmarks,
  getBenchmarkById,
  defineCustomBenchmark,
  KNOWN_METRICS,
  isKnownMetric,
  isBuiltInBenchmark,
} from "../lib/benchmarking";

const router = Router();

router.get("/benchmarks", (_req: Request, res: Response) => {
  res.json({ benchmarks: getBenchmarks() });
});

router.get("/benchmarks/:id", (req: Request, res: Response, next: NextFunction) => {
  const id = req.params.id as string;
  const benchmark = getBenchmarkById(id);
  if (!benchmark) return next(notFound(`Benchmark "${id}" not found`));
  res.json(benchmark);
});

router.post("/benchmarks", requireAdminBearer, (req: Request, res: Response, next: NextFunction) => {
  const { name, description, metric, thresholds, source, id } = req.body;
  if (!name || typeof name !== "string" || !name.trim()) {
    return next(badRequest("name is required and must be a non-empty string"));
  }
  if (!metric || typeof metric !== "string") {
    return next(badRequest("metric is required and must be a string"));
  }
  if (!isKnownMetric(metric)) {
    return next(badRequest(`Invalid metric "${metric}". Allowed metrics: ${KNOWN_METRICS.join(", ")}`));
  }
  if (!thresholds || typeof thresholds !== "object" || Array.isArray(thresholds)) {
    return next(badRequest("thresholds is required and must be an object"));
  }
  const { poor, fair, good, excellent } = thresholds;
  if (
    typeof poor !== "number" ||
    !Number.isFinite(poor) ||
    typeof fair !== "number" ||
    !Number.isFinite(fair) ||
    typeof good !== "number" ||
    !Number.isFinite(good) ||
    typeof excellent !== "number" ||
    !Number.isFinite(excellent)
  ) {
    return next(badRequest("thresholds must have numeric poor, fair, good, excellent values"));
  }
  if (poor < 0 || fair < 0 || good < 0 || excellent < 0) {
    return next(badRequest("thresholds values must be non-negative"));
  }
  if (!(poor <= fair && fair <= good && good <= excellent)) {
    return next(badRequest("thresholds must satisfy poor <= fair <= good <= excellent"));
  }

  const targetId =
    typeof id === "string" && id.trim()
      ? id.trim()
      : name.trim().toLowerCase().replace(/\s+/g, "_");

  if (isBuiltInBenchmark(targetId)) {
    return next(badRequest(`Cannot overwrite built-in benchmark "${targetId}"`));
  }

  try {
    const benchmark = defineCustomBenchmark({
      name: name.trim(),
      description: typeof description === "string" ? description : "",
      metric,
      thresholds: { poor, fair, good, excellent },
      source: typeof source === "string" ? source : "Custom",
      id: targetId,
    });
    res.status(201).json(benchmark);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    next(badRequest(msg));
  }
});

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
    if (!benchmark) return next(notFound(`Benchmark "${benchmarkId}" not found`));

    const result = trendVsBenchmark(id, metric, benchmarkId);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

export default router;
