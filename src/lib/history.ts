import { logger } from "./logger";

export interface ScoreEntry {
  project_id: number;
  credit_quality: number;
  green_impact: number;
  timestamp: number; // Unix ms
}

export type Trend = "improving" | "declining" | "stable";

export interface TrendAnalysis {
  trend: Trend;
  credit_quality_delta: number;
  green_impact_delta: number;
  sample_count: number;
}

const store = new Map<number, ScoreEntry[]>();

/**
 * Default cap on history entries per project.
 * Approximately 1 week of hourly score updates (168 hours).
 * Overridable via SCORE_HISTORY_MAX_ENTRIES_PER_PROJECT.
 */
const DEFAULT_HISTORY_MAX_ENTRIES = 168;

/**
 * Default TTL for score history entries (milliseconds).
 * Default: 7 days. Overridable via SCORE_HISTORY_TTL_MS.
 */
const DEFAULT_HISTORY_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * Resolve the configured max entries per project.
 * A missing, non-numeric or non-positive value falls back to the default.
 */
function historyMaxEntries(): number {
  const raw = process.env.SCORE_HISTORY_MAX_ENTRIES_PER_PROJECT;
  if (!raw) return DEFAULT_HISTORY_MAX_ENTRIES;
  const parsed = parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed < 1) {
    logger.warn("Invalid SCORE_HISTORY_MAX_ENTRIES_PER_PROJECT, falling back to default", {
      SCORE_HISTORY_MAX_ENTRIES_PER_PROJECT: raw,
      default: DEFAULT_HISTORY_MAX_ENTRIES,
    });
    return DEFAULT_HISTORY_MAX_ENTRIES;
  }
  return parsed;
}

/**
 * Resolve the configured TTL for history entries.
 * A missing, non-numeric or non-positive value falls back to the default.
 */
function historyTtlMs(): number {
  const raw = process.env.SCORE_HISTORY_TTL_MS;
  if (!raw) return DEFAULT_HISTORY_TTL_MS;
  const parsed = parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed < 1) {
    logger.warn("Invalid SCORE_HISTORY_TTL_MS, falling back to default", {
      SCORE_HISTORY_TTL_MS: raw,
      default: DEFAULT_HISTORY_TTL_MS,
    });
    return DEFAULT_HISTORY_TTL_MS;
  }
  return parsed;
}

/**
 * Evict expired and excess entries from a project's history.
 * First removes entries older than the TTL, then evicts oldest-first
 * until the entry count fits within the configured max.
 */
function evictHistoryForProject(projectId: number): void {
  const entries = store.get(projectId);
  if (!entries) return;

  const now = Date.now();
  const ttl = historyTtlMs();

  // Remove expired entries
  const unexpired = entries.filter((e) => now - e.timestamp <= ttl);
  if (unexpired.length < entries.length) {
    store.set(projectId, unexpired);
  }

  // Evict oldest-first if still over capacity
  const maxEntries = historyMaxEntries();
  if (unexpired.length > maxEntries) {
    // Entries are already in insertion order (oldest first after filtering)
    const retained = unexpired.slice(unexpired.length - maxEntries);
    store.set(projectId, retained);
  }
}

export function recordScoreHistory(
  projectId: number,
  creditQuality: number,
  greenImpact: number,
  timestamp = Date.now(),
): void {
  if (!store.has(projectId)) store.set(projectId, []);
  store.get(projectId)!.push({ project_id: projectId, credit_quality: creditQuality, green_impact: greenImpact, timestamp });

  // Evict expired and excess entries to maintain bounded size
  evictHistoryForProject(projectId);
}

export function getHistory(
  projectId: number,
  from?: number,
  to?: number,
): ScoreEntry[] {
  const entries = store.get(projectId) ?? [];
  return entries.filter((e) => {
    if (from !== undefined && e.timestamp < from) return false;
    if (to !== undefined && e.timestamp > to) return false;
    return true;
  });
}

/**
 * Threshold (in combined score points) below which a fitted trend counts as
 * flat. Matches the historic endpoint-delta threshold.
 */
const TREND_THRESHOLD = 2;

/**
 * Least-squares slope of `values` against sample order. Sample index rather
 * than timestamp avoids extreme numeric values for epoch-millisecond inputs.
 */
function leastSquaresSlope(values: number[]): number {
  const n = values.length;
  const meanX = (n - 1) / 2;
  const meanY = values.reduce((acc, value) => acc + value, 0) / n;

  let numerator = 0;
  let denominator = 0;
  for (let i = 0; i < n; i++) {
    const dx = i - meanX;
    numerator += dx * (values[i] - meanY);
    denominator += dx * dx;
  }

  return denominator === 0 ? 0 : numerator / denominator;
}

/**
 * Classify the direction of a score series.
 *
 * Unlike the previous endpoint-only comparison, every sample contributes:
 *
 * 1. A least-squares slope is fitted over the combined score
 *    (`credit_quality + green_impact`). If the fitted change across the whole
 *    window exceeds `TREND_THRESHOLD`, the series is improving/declining.
 * 2. Otherwise, if the series both rose and fell by more than
 *    `TREND_THRESHOLD`, it is volatile rather than flat; the trend follows the
 *    most recent non-zero step, so a rise-then-collapse reads as declining.
 * 3. Otherwise the series is stable.
 *
 * The `*_delta` fields remain endpoint deltas for backwards compatibility.
 */
export function computeTrend(entries: ScoreEntry[]): TrendAnalysis {
  if (entries.length < 2) {
    return {
      trend: "stable",
      credit_quality_delta: 0,
      green_impact_delta: 0,
      sample_count: entries.length,
    };
  }
  const sorted = [...entries].sort((a, b) => a.timestamp - b.timestamp);
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  const cqDelta = last.credit_quality - first.credit_quality;
  const giDelta = last.green_impact - first.green_impact;

  const combined = sorted.map((e) => e.credit_quality + e.green_impact);
  const fittedChange = leastSquaresSlope(combined) * (combined.length - 1);

  let trend: Trend;
  if (fittedChange > TREND_THRESHOLD) {
    trend = "improving";
  } else if (fittedChange < -TREND_THRESHOLD) {
    trend = "declining";
  } else {
    // Flat overall — check whether intermediate samples reveal a reversal.
    let peak = combined[0];
    let trough = combined[0];
    let maxRise = 0;
    let maxDrop = 0;
    for (const value of combined) {
      if (value > peak) peak = value;
      if (value < trough) trough = value;
      if (value - trough > maxRise) maxRise = value - trough;
      if (peak - value > maxDrop) maxDrop = peak - value;
    }

    const volatile = maxRise > TREND_THRESHOLD && maxDrop > TREND_THRESHOLD;
    if (!volatile) {
      trend = "stable";
    } else {
      // Follow the latest movement so a rise-then-collapse is not "stable".
      let latestStep = 0;
      for (let i = combined.length - 1; i > 0; i--) {
        const step = combined[i] - combined[i - 1];
        if (step !== 0) {
          latestStep = Math.sign(step);
          break;
        }
      }
      trend = latestStep > 0 ? "improving" : latestStep < 0 ? "declining" : "stable";
    }
  }

  return {
    trend,
    credit_quality_delta: cqDelta,
    green_impact_delta: giDelta,
    sample_count: entries.length,
  };
}

export function entriesToCsv(entries: ScoreEntry[]): string {
  const header = "project_id,credit_quality,green_impact,timestamp";
  const rows = entries.map((e) =>
    `${e.project_id},${e.credit_quality},${e.green_impact},${new Date(e.timestamp).toISOString()}`,
  );
  return [header, ...rows].join("\n") + "\n";
}

/** Clears all stored history. Intended for tests only. */
export function clearHistoryStore(): void {
  store.clear();
}

/** History store introspection for tests and health/metrics surfaces. */
export function getHistoryStats(): {
  projects: number;
  totalEntries: number;
  maxEntriesPerProject: number;
  ttlMs: number;
} {
  let totalEntries = 0;
  for (const entries of store.values()) {
    totalEntries += entries.length;
  }
  return {
    projects: store.size,
    totalEntries,
    maxEntriesPerProject: historyMaxEntries(),
    ttlMs: historyTtlMs(),
  };
}
