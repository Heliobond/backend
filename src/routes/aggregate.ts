import { Router, Request, Response, NextFunction } from "express";
import { parseOptionalInt } from "../middleware/errors";
import { loadProjectScores, computeAggregateScores, inferCategory, type Category } from "../lib/aggregation";

const router = Router();

const VALID_CATEGORIES = new Set<Category>(["solar", "forest", "wind"]);

/**
 * GET /v1/projects/aggregate
 *
 * Returns portfolio-level aggregate scores across multiple projects.
 *
 * Query params:
 *   limit    – number of projects to include (1–100, default 20)
 *   cursor   – pagination offset (default 0)
 *   category – filter by category: solar | forest | wind
 *   region   – filter by region: north | south | east | west
 */
router.get("/", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const limit = Math.min(parseOptionalInt(req.query.limit as string | undefined, "limit", 20), 100);
    const cursor = parseOptionalInt(req.query.cursor as string | undefined, "cursor", 0);
    const categoryFilter = req.query.category as string | undefined;
    const regionFilter = req.query.region as string | undefined;

    if (categoryFilter && !VALID_CATEGORIES.has(categoryFilter as Category)) {
      res.status(400).json({ error: "BadRequest", message: `category must be one of: ${[...VALID_CATEGORIES].join(", ")}` });
      return;
    }

    // Build the project id list for this page (1-indexed)
    const projectIds = Array.from({ length: limit }, (_, i) => cursor + i + 1);

    let projects = loadProjectScores(projectIds);

    if (categoryFilter) {
      projects = projects.filter((p) => p.category === categoryFilter);
    }
    if (regionFilter) {
      projects = projects.filter((p) => p.region === regionFilter);
    }

    const aggregate = computeAggregateScores(projects);

    res.json({
      ...aggregate,
      cursor: cursor + limit,
      limit,
    });
  } catch (err) {
    next(err);
  }
});

export { inferCategory };
export default router;
