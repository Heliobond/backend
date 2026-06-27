import { Router, Request, Response, NextFunction } from "express";
import {
  collectScores,
  portfolioSummary,
  rankPerformers,
  scoreDistribution,
  projectTimeSeries,
  summaryToCsv,
} from "../lib/analytics";
import { parseProjectId, parseOptionalInt } from "../middleware/errors";

const router = Router();

/** GET /dashboard/summary — portfolio-wide aggregate figures. */
router.get("/summary", async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const scores = await collectScores();
    res.json(portfolioSummary(scores));
  } catch (error) {
    console.error("[dashboard] summary error:", error);
    next(error);
  }
});

/** GET /dashboard/performers?limit=5 — top and bottom performers. */
router.get("/performers", async (req: Request, res: Response, next: NextFunction) => {
  const limit = Math.min(parseOptionalInt(req.query.limit as string | undefined, "limit", 5), 50);
  try {
    const scores = await collectScores();
    res.json(rankPerformers(scores, limit));
  } catch (error) {
    console.error("[dashboard] performers error:", error);
    next(error);
  }
});

/** GET /dashboard/distribution?field=&bucket= — score distribution histogram. */
router.get("/distribution", async (req: Request, res: Response, next: NextFunction) => {
  const field = req.query.field === "green_impact" ? "green_impact" : "credit_quality";
  const bucket = Math.min(Math.max(parseOptionalInt(req.query.bucket as string | undefined, "bucket", 10), 1), 50);
  try {
    const scores = await collectScores();
    res.json({ field, buckets: scoreDistribution(scores, field, bucket) });
  } catch (error) {
    console.error("[dashboard] distribution error:", error);
    next(error);
  }
});

/** GET /dashboard/timeseries/:id?from=&to= — per-project score time-series. */
router.get("/timeseries/:id", (req: Request, res: Response) => {
  const id = parseProjectId(req.params.id, "project id");
  const from = req.query.from !== undefined ? parseOptionalInt(req.query.from as string, "from", 0) : undefined;
  const to = req.query.to !== undefined ? parseOptionalInt(req.query.to as string, "to", 0) : undefined;
  res.json({ project_id: id, points: projectTimeSeries(id, from, to) });
});

/** GET /dashboard/export — CSV export of current portfolio scores. */
router.get("/export", async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const scores = await collectScores();
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", 'attachment; filename="dashboard-export.csv"');
    res.send(summaryToCsv(scores));
  } catch (error) {
    console.error("[dashboard] export error:", error);
    next(error);
  }
});

export default router;
