import { Router, Request, Response, NextFunction } from "express";
import {
  compareProjects,
  generateRanking,
  comparisonToCsv,
  rankingToCsv,
  validateCriteria,
  COMPARISON_METRICS,
} from "../lib/comparison";
import { badRequest, MAX_U32_PROJECT_ID } from "../middleware/errors";

const router = Router();

function parseIds(raw: string | undefined): number[] {
  if (!raw) throw badRequest("ids query parameter is required (comma-separated)");
  const maxId = MAX_U32_PROJECT_ID;
  const ids = raw.split(",").map((s) => {
    const trimmed = s.trim();
    const n = Number(trimmed);
    if (!Number.isInteger(n) || n < 1) throw badRequest(`Invalid project id "${trimmed}"`);
    if (n > maxId)
      throw badRequest(
        `Invalid project id "${trimmed}" exceeds maximum allowed project id ${maxId}`,
      );
    return n;
  });
  if (ids.length === 0) throw badRequest("At least one project id is required");
  if (ids.length > 20) throw badRequest("Cannot compare more than 20 projects at once");
  return ids;
}

router.get("/", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ids = parseIds(req.query.ids as string | undefined);
    const result = await compareProjects(ids);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

router.get("/metrics", (_req: Request, res: Response) => {
  res.json({ metrics: COMPARISON_METRICS });
});

router.get("/ranking", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ids = parseIds(req.query.ids as string | undefined);
    const criteria = (req.query.criteria as string) ?? "combined_score";

    const validationError = validateCriteria(criteria);
    if (validationError) return next(badRequest(validationError));

    const result = await generateRanking(ids, criteria);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

router.get("/export", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ids = parseIds(req.query.ids as string | undefined);
    const format = (req.query.format as string) ?? "csv";

    if (format === "csv") {
      const result = await compareProjects(ids);
      const csv = comparisonToCsv(result);
      res.setHeader("Content-Type", "text/csv");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="comparison-${ids.join("-")}.csv"`,
      );
      res.send(csv);
    } else {
      return next(badRequest("Unsupported export format. Use 'csv'."));
    }
  } catch (error) {
    next(error);
  }
});

router.get("/ranking/export", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ids = parseIds(req.query.ids as string | undefined);
    const criteria = (req.query.criteria as string) ?? "combined_score";

    const validationError = validateCriteria(criteria);
    if (validationError) return next(badRequest(validationError));

    const ranking = await generateRanking(ids, criteria);
    const csv = rankingToCsv(ranking);
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="ranking-${criteria}.csv"`);
    res.send(csv);
  } catch (error) {
    next(error);
  }
});

export default router;
