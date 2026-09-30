import { Router, Request, Response, NextFunction } from "express";
import {
  getScoreHistory,
  getInterestRate,
  ProjectNotFoundError,
  type OnChainScoreHistoryEntry,
} from "../lib/registry";
import { parseProjectId, parseOptionalInt, badRequest, ApiError } from "../middleware/errors";
import { logger } from "../lib/logger";

/**
 * GET /v1/projects/:id/price-history (#769).
 *
 * Serves the frontend's `PricePoint[] = { date, price, yield? }` chart data
 * from real on-chain state. `get_score_history(id)` provides the timestamped
 * ring-buffer entries (registry stores up to 50) and `get_interest_rate(id)`
 * the current yield in basis points.
 *
 * Yield/price derivation (see also API.md):
 *   yield_pct = rate_bps / 100
 *   price     = 100 / (1 + yield_pct / 100)          // one-period present value
 *
 * Historical rate is not yet indexed from `RateUpdated` / `ScoreChanged`
 * events (paired backend work); we therefore expose the CURRENT interest
 * rate as the `yield` on every point, and the price is derived from that
 * same rate. This keeps every value on the chart traceable to an on-chain
 * read and avoids fabricating a synthetic rate curve. When the event
 * indexer lands, only the rate lookup changes: the response shape is
 * stable.
 */

const DEFAULT_INTERVAL = "day" as const;
const VALID_INTERVALS = ["day", "week"] as const;
type Interval = (typeof VALID_INTERVALS)[number];

export interface PricePoint {
  date: string;
  price: number;
  yield?: number;
}

function bucketKey(timestampMs: number, interval: Interval): string {
  const d = new Date(timestampMs);
  if (interval === "week") {
    // ISO week: bucket by the Monday (UTC) of the containing week so the
    // client can render aligned weekly bars regardless of local timezone.
    const dayOfWeek = d.getUTCDay(); // 0 = Sunday
    const daysSinceMonday = (dayOfWeek + 6) % 7;
    const monday = new Date(
      Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - daysSinceMonday),
    );
    return monday.toISOString().slice(0, 10);
  }
  return d.toISOString().slice(0, 10);
}

function computePrice(rateBps: number): number {
  const yieldPct = rateBps / 100;
  const price = 100 / (1 + yieldPct / 100);
  return Math.round(price * 100) / 100;
}

/**
 * Turns raw score-history entries into `PricePoint` records for the chart.
 * Groups by day/week using the last entry in each bucket (stable ordering
 * because the ring buffer is chronological). Range filter is inclusive.
 */
export function buildPricePoints(
  history: OnChainScoreHistoryEntry[],
  currentRateBps: number,
  opts: { from?: number; to?: number; interval: Interval },
): PricePoint[] {
  const yieldPct = Math.round((currentRateBps / 100) * 100) / 100;
  const price = computePrice(currentRateBps);

  const bucketed = new Map<string, PricePoint>();
  for (const entry of history) {
    // Contract stores unix seconds; the frontend expects ISO dates.
    const timestampMs = entry.timestamp * 1000;
    if (opts.from !== undefined && timestampMs < opts.from) continue;
    if (opts.to !== undefined && timestampMs > opts.to) continue;
    const key = bucketKey(timestampMs, opts.interval);
    bucketed.set(key, { date: key, price, yield: yieldPct });
  }
  return Array.from(bucketed.values()).sort((a, b) =>
    a.date < b.date ? -1 : a.date > b.date ? 1 : 0,
  );
}

const router = Router({ mergeParams: true });

router.get("/", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = parseProjectId(req.params["id"]);

    const from = parseOptionalInt(req.query.from as string | undefined, "from", 0) || undefined;
    const to = parseOptionalInt(req.query.to as string | undefined, "to", 0) || undefined;
    if (from !== undefined && to !== undefined && from > to) {
      throw badRequest("from must be earlier than to");
    }

    const rawInterval = (req.query.interval as string | undefined) ?? DEFAULT_INTERVAL;
    if (!VALID_INTERVALS.includes(rawInterval as Interval)) {
      throw badRequest(`interval must be one of: ${VALID_INTERVALS.join(", ")}`);
    }
    const interval = rawInterval as Interval;

    let history: OnChainScoreHistoryEntry[];
    let currentRateBps: number;
    try {
      [history, currentRateBps] = await Promise.all([getScoreHistory(id), getInterestRate(id)]);
    } catch (err) {
      if (err instanceof ProjectNotFoundError) {
        throw new ApiError(404, "not_found", err.message);
      }
      throw err;
    }

    const points = buildPricePoints(history, currentRateBps, { from, to, interval });

    // Short cache: chart data doesn't change more than hourly; 60s balances
    // freshness (after a score-update cron tick) with load protection.
    res.set("Cache-Control", "public, max-age=60");
    res.json({ project_id: id, interval, count: points.length, points });
  } catch (err) {
    if (!(err instanceof ApiError)) {
      logger.error("[price-history] failed", logger.formatError(err));
    }
    next(err);
  }
});

export default router;
