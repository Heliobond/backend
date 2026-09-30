import { logger } from "./logger";

/**
 * Price point matching frontend PricePoint type.
 * Frontend expects: { date: number, price: number, yield?: number }
 */
export interface PricePoint {
  date: number; // Unix timestamp in ms
  price: number; // Bond price (0-200 range, par = 100)
  yield?: number; // Yield percentage (optional)
}

/**
 * In-memory store for rate history.
 * In production, this should be backed by database with indexed queries.
 *
 * Structure: Map<projectId, Array<{ timestamp, rate_bps }>>
 */
const rateHistory = new Map<number, Array<{ timestamp: number; rate_bps: number }>>();

/**
 * Calculate bond price from interest rate using simple bond pricing formula.
 *
 * Formula documented in API.md:
 *   Price = 100 / (1 + (rate / 100))
 *
 * Where rate is in percentage (rate_bps / 100).
 *
 * Examples:
 *   - 5% rate → Price = 100 / 1.05 ≈ 95.24
 *   - 10% rate → Price = 100 / 1.10 ≈ 90.91
 *   - 0% rate → Price = 100.00
 */
function calculateBondPrice(rate_bps: number): number {
  const ratePercent = rate_bps / 100; // Convert basis points to percentage
  if (ratePercent === 0) return 100.0;
  const price = 100 / (1 + (ratePercent / 100));
  return Math.round(price * 100) / 100; // Round to 2 decimal places
}

/**
 * Aggregate price points by day or week interval.
 * Takes the last (most recent) price point within each interval.
 */
function aggregateByInterval(
  points: PricePoint[],
  interval: "day" | "week"
): PricePoint[] {
  if (points.length === 0) return [];

  const intervalMs = interval === "day" ? 24 * 60 * 60 * 1000 : 7 * 24 * 60 * 60 * 1000;
  const buckets = new Map<number, PricePoint>();

  for (const point of points) {
    const bucketKey = Math.floor(point.date / intervalMs) * intervalMs;
    const existing = buckets.get(bucketKey);

    // Keep the most recent point in this bucket
    if (!existing || point.date > existing.date) {
      buckets.set(bucketKey, point);
    }
  }

  // Return sorted by date ascending
  return Array.from(buckets.values()).sort((a, b) => a.date - b.date);
}

/**
 * Record a rate update event.
 * In production, this would be called by the event indexer polling the registry contract.
 */
export function recordRateUpdate(projectId: number, rate_bps: number, timestamp = Date.now()): void {
  if (!rateHistory.has(projectId)) {
    rateHistory.set(projectId, []);
  }

  rateHistory.get(projectId)!.push({ timestamp, rate_bps });

  // Keep only last 1000 entries per project to prevent unbounded growth
  const entries = rateHistory.get(projectId)!;
  if (entries.length > 1000) {
    rateHistory.set(projectId, entries.slice(-1000));
  }

  logger.debug("[price-history] Recorded rate update", { projectId, rate_bps, timestamp });
}

/**
 * Seed initial history from on-chain get_score_history.
 * This is called on first request for a project to backfill historical data.
 *
 * In production, this would call the Soroban contract's get_score_history function
 * which returns a 50-entry ring buffer of past scores and rates.
 */
async function seedHistoryFromChain(projectId: number): Promise<void> {
  // Placeholder: In production, this would invoke the contract
  // const history = await sorobanContract.get_score_history(projectId);

  // For now, we'll just log that seeding would happen here
  logger.info("[price-history] Would seed history from chain for project", { projectId });

  // Example of what the seeding would look like:
  // for (const entry of history) {
  //   recordRateUpdate(projectId, entry.rate_bps, entry.timestamp);
  // }
}

/**
 * Ensure project history is loaded (seed from chain if needed).
 */
async function ensureProjectHistory(projectId: number): Promise<void> {
  if (!rateHistory.has(projectId)) {
    await seedHistoryFromChain(projectId);
  }
}

/**
 * Get price history for a project.
 *
 * @param projectId - Project identifier
 * @param from - Start timestamp in ms (optional)
 * @param to - End timestamp in ms (optional)
 * @param interval - Aggregation interval: "day" or "week"
 * @returns Array of PricePoint objects in ascending date order
 */
export async function getPriceHistory(
  projectId: number,
  from?: number,
  to?: number,
  interval: "day" | "week" = "day"
): Promise<PricePoint[]> {
  // Ensure history is loaded
  await ensureProjectHistory(projectId);

  const entries = rateHistory.get(projectId) ?? [];

  // Filter by time range
  const filtered = entries.filter((e) => {
    if (from !== undefined && e.timestamp < from) return false;
    if (to !== undefined && e.timestamp > to) return false;
    return true;
  });

  // Convert to price points
  const points: PricePoint[] = filtered.map((entry) => ({
    date: entry.timestamp,
    price: calculateBondPrice(entry.rate_bps),
    yield: entry.rate_bps / 100, // Convert basis points to percentage
  }));

  // Aggregate by interval
  const aggregated = aggregateByInterval(points, interval);

  logger.debug("[price-history] Retrieved price history", {
    projectId,
    count: aggregated.length,
    interval,
    from,
    to,
  });

  return aggregated;
}

/**
 * Clear all rate history. For tests only.
 */
export function clearRateHistory(): void {
  rateHistory.clear();
}

/**
 * Get statistics about stored rate history.
 */
export function getRateHistoryStats(): {
  projects: number;
  totalEntries: number;
} {
  let totalEntries = 0;
  for (const entries of rateHistory.values()) {
    totalEntries += entries.length;
  }
  return {
    projects: rateHistory.size,
    totalEntries,
  };
}
