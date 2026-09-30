import { Router, Request, Response, NextFunction } from "express";
import { parseProjectId, parseOptionalInt, badRequest, notFound } from "../middleware/errors";
import { getPriceHistory, PricePoint } from "../lib/price-history";
import { logger } from "../lib/logger";

const router = Router({ mergeParams: true });

type IntervalType = "day" | "week";

/**
 * GET /v1/projects/:id/price-history
 *
 * Returns historical price and yield data for a project, derived from on-chain
 * RateUpdated and ScoreChanged events from the project registry contract.
 *
 * Query parameters:
 *   - from: Unix timestamp (ms) for range start (optional)
 *   - to: Unix timestamp (ms) for range end (optional)
 *   - interval: "day" or "week" for data point granularity (default: "day")
 *
 * Returns:
 *   - 200: Array of PricePoint objects { date, price, yield }
 *   - 400: Invalid query parameters
 *   - 404: Project not found
 */
router.get("/", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = parseProjectId(req.params["id"]);

    // Parse query parameters
    const from = parseOptionalInt(req.query.from as string | undefined, "from", 0) || undefined;
    const to = parseOptionalInt(req.query.to as string | undefined, "to", 0) || undefined;

    // Validate time range
    if (from && to && from > to) {
      return next(badRequest("from must be earlier than to"));
    }

    // Parse and validate interval
    const intervalRaw = (req.query.interval as string | undefined) ?? "day";
    if (intervalRaw !== "day" && intervalRaw !== "week") {
      return next(badRequest("interval must be 'day' or 'week'"));
    }
    const interval = intervalRaw as IntervalType;

    // Fetch price history
    const priceHistory = await getPriceHistory(id, from, to, interval);

    // Set Cache-Control headers for public read tier
    res.set("Cache-Control", "public, max-age=300, stale-while-revalidate=600");
    res.json(priceHistory);

  } catch (err) {
    logger.error("[price-history] error", { error: err });
    next(err);
  }
});

export default router;
