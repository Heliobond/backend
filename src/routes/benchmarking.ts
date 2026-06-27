import { Router, Request, Response, NextFunction } from "express";
import { parseProjectId } from "../middleware/errors";
import { badRequest } from "../middleware/errors";
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

router.get("/benchmarks", (_req: Request, res: Response) => {
  res.json({ benchmarks: getBenchmarks() });
});

router.get("/benchmarks/:id", (req: Request, res: Response, next: NextFunction) => {
  const id = req.params.id as string;
  const benchmark = getBenchmarkById(id);
  if (!benchmark) return next(badRequest(`Benchmark "${id}" not found`));
  res.json(benchmark);
});

router.post("/benchmarks", (req: Request, res: Response, next: NextFunction) => {
  const { name, description, metric, thresholds, source, id } = req.body;
  if (!name || !metric || !thresholds) {
    return next(badRequest("name, metric, and thresholds are required"));
  }
  const { poor, fair, good, excellent } = thresholds;
  if ([poor, fair, good, excellent].some((v: number) => typeof v !== "number")) {
    return next(badRequest("thresholds must have numeric poor, fair, good, excellent values"));
  }
  const benchmark = defineCustomBenchmark({ name, description, metric, thresholds, source, id });
  res.status(201).json(benchmark);
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
    if (!benchmark) return next(badRequest(`Benchmark "${benchmarkId}" not found`));

    const result = trendVsBenchmark(id, metric, benchmarkId);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

export default router;
