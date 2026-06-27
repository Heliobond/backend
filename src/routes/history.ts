import { Router, Request, Response, NextFunction } from "express";
import { getHistory, computeTrend, entriesToCsv } from "../lib/history";
import { parseProjectId, parseOptionalInt, badRequest } from "../middleware/errors";

const router = Router({ mergeParams: true });

/**
 * GET /api/projects/:id/history
 * Query: from=<unix-ms>, to=<unix-ms>, format=json|csv
 */
router.get("/", (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = parseProjectId(req.params["id"]);
    const from = parseOptionalInt(req.query.from as string | undefined, "from", 0) || undefined;
    const to = parseOptionalInt(req.query.to as string | undefined, "to", 0) || undefined;

    if (from && to && from > to) {
      throw badRequest("from must be earlier than to");
    }

    const entries = getHistory(id, from, to);
    const format = req.query.format === "csv" ? "csv" : "json";

    if (format === "csv") {
      res.set("Content-Type", "text/csv");
      res.set("Content-Disposition", `attachment; filename="history-${id}.csv"`);
      res.send(entriesToCsv(entries));
      return;
    }

    res.json({ project_id: id, count: entries.length, entries });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/projects/:id/history/trend
 * Query: from=<unix-ms>, to=<unix-ms>
 * Compares score direction over the given (or all) history.
 */
router.get("/trend", (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = parseProjectId(req.params["id"]);
    const from = parseOptionalInt(req.query.from as string | undefined, "from", 0) || undefined;
    const to = parseOptionalInt(req.query.to as string | undefined, "to", 0) || undefined;

    const entries = getHistory(id, from, to);
    const trend = computeTrend(entries);
    res.json({ project_id: id, ...trend });
  } catch (err) {
    next(err);
  }
});

export default router;
