/**
 * Dashboard analytics (#23).
 *
 * Pure aggregation helpers over project score snapshots, plus a collector that
 * assembles snapshots from the IoT feeds and scoring engine. Keeping the maths
 * pure (no I/O) makes the aggregations directly unit-testable.
 */
import { getSolarData, getSatelliteData } from "../routes/iot";
import { computeScores } from "./scoring";
import { getTotalProjects } from "./registry";
import { getHistory, ScoreEntry } from "./history";

export interface ProjectScore {
  id: number;
  credit_quality: number;
  green_impact: number;
  power_output_kw: number;
}

export interface PortfolioSummary {
  total_projects: number;
  avg_credit_quality: number;
  avg_green_impact: number;
  total_power_output_kw: number;
  highest_score_project: number | null;
  lowest_score_project: number | null;
}

export interface Performer {
  id: number;
  credit_quality: number;
  green_impact: number;
  combined_score: number;
}

export interface DistributionBucket {
  range: string;
  count: number;
}

export interface TimeSeriesPoint {
  timestamp: number;
  credit_quality: number;
  green_impact: number;
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

const combined = (s: { credit_quality: number; green_impact: number }): number =>
  s.credit_quality + s.green_impact;

/** Assemble a score snapshot for every project from the live feeds. */
export async function collectScores(): Promise<ProjectScore[]> {
  const total = await getTotalProjects();
  const scores: ProjectScore[] = [];
  for (let id = 1; id <= total; id++) {
    const solar = getSolarData(id);
    const satellite = getSatelliteData(id);
    const s = computeScores({ solar, satellite });
    scores.push({
      id,
      credit_quality: s.credit_quality,
      green_impact: s.green_impact,
      power_output_kw: solar.power_output_kw,
    });
  }
  return scores;
}

export function portfolioSummary(scores: ProjectScore[]): PortfolioSummary {
  if (scores.length === 0) {
    return {
      total_projects: 0,
      avg_credit_quality: 0,
      avg_green_impact: 0,
      total_power_output_kw: 0,
      highest_score_project: null,
      lowest_score_project: null,
    };
  }
  const sumCq = scores.reduce((acc, s) => acc + s.credit_quality, 0);
  const sumGi = scores.reduce((acc, s) => acc + s.green_impact, 0);
  const sumPower = scores.reduce((acc, s) => acc + s.power_output_kw, 0);

  const ranked = [...scores].sort((a, b) => combined(b) - combined(a));

  return {
    total_projects: scores.length,
    avg_credit_quality: round(sumCq / scores.length),
    avg_green_impact: round(sumGi / scores.length),
    total_power_output_kw: round(sumPower),
    highest_score_project: ranked[0].id,
    lowest_score_project: ranked[ranked.length - 1].id,
  };
}

/** Top and bottom `n` performers by combined credit + green score. */
export function rankPerformers(scores: ProjectScore[], n = 5): { top: Performer[]; bottom: Performer[] } {
  const mapped: Performer[] = scores.map((s) => ({
    id: s.id,
    credit_quality: s.credit_quality,
    green_impact: s.green_impact,
    combined_score: combined(s),
  }));
  const sorted = [...mapped].sort((a, b) => b.combined_score - a.combined_score);
  const top = sorted.slice(0, n);
  const bottom = sorted.slice(-n).reverse();
  return { top, bottom };
}

/**
 * Bucket a score field into fixed-width ranges (default 0–100 in steps of 10).
 */
export function scoreDistribution(
  scores: ProjectScore[],
  field: "credit_quality" | "green_impact" = "credit_quality",
  bucketSize = 10,
): DistributionBucket[] {
  const buckets: DistributionBucket[] = [];
  for (let lo = 0; lo < 100; lo += bucketSize) {
    const hi = lo + bucketSize;
    const count = scores.filter((s) => {
      const v = s[field];
      // Include the top edge (100) in the final bucket.
      return v >= lo && (hi >= 100 ? v <= hi : v < hi);
    }).length;
    buckets.push({ range: `${lo}-${hi}`, count });
  }
  return buckets;
}

/** Time-series of a single project's scores, oldest first. */
export function projectTimeSeries(projectId: number, from?: number, to?: number): TimeSeriesPoint[] {
  const entries: ScoreEntry[] = getHistory(projectId, from, to);
  return entries
    .sort((a, b) => a.timestamp - b.timestamp)
    .map((e) => ({ timestamp: e.timestamp, credit_quality: e.credit_quality, green_impact: e.green_impact }));
}

/** Flatten a portfolio summary + performers into CSV for export. */
export function summaryToCsv(scores: ProjectScore[]): string {
  const header = "project_id,credit_quality,green_impact,power_output_kw,combined_score";
  const rows = scores.map((s) => `${s.id},${s.credit_quality},${s.green_impact},${s.power_output_kw},${combined(s)}`);
  return [header, ...rows].join("\n") + "\n";
}
