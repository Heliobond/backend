import { getSolarData, getSatelliteData } from "../routes/iot";
import { computeScores } from "./scoring";
import { getHistory } from "./history";

export interface ComparisonMetric {
  label: string;
  key: string;
  unit: string;
}

export interface ProjectMetrics {
  id: number;
  credit_quality: number;
  green_impact: number;
  power_output_kw: number;
  efficiency_pct: number;
  forest_density_pct: number;
  ndvi_score: number;
  combined_score: number;
}

export interface ComparisonResult {
  projects: ProjectMetrics[];
  metrics: ComparisonMetric[];
  summary: {
    highest_combined: number | null;
    lowest_combined: number | null;
    avg_credit_quality: number;
    avg_green_impact: number;
    avg_combined: number;
  };
}

export interface RankingEntry {
  rank: number;
  id: number;
  score: number;
  credit_quality: number;
  green_impact: number;
}

export interface RankingResult {
  criteria: string;
  rankings: RankingEntry[];
}

export const COMPARISON_METRICS: ComparisonMetric[] = [
  { label: "Credit Quality", key: "credit_quality", unit: "points" },
  { label: "Green Impact", key: "green_impact", unit: "points" },
  { label: "Power Output", key: "power_output_kw", unit: "kW" },
  { label: "Efficiency", key: "efficiency_pct", unit: "%" },
  { label: "Forest Density", key: "forest_density_pct", unit: "%" },
  { label: "NDVI Score", key: "ndvi_score", unit: "score" },
  { label: "Combined Score", key: "combined_score", unit: "points" },
];

const VALID_CRITERIA = new Set([
  "credit_quality",
  "green_impact",
  "combined_score",
  "power_output_kw",
  "efficiency_pct",
  "forest_density_pct",
  "ndvi_score",
]);

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

export function loadProjectMetrics(ids: number[]): ProjectMetrics[] {
  return ids.map((id) => {
    const solar = getSolarData(id);
    const satellite = getSatelliteData(id);
    const scores = computeScores({ solar, satellite });
    const combined = scores.credit_quality + scores.green_impact;
    return {
      id,
      credit_quality: scores.credit_quality,
      green_impact: scores.green_impact,
      power_output_kw: solar.power_output_kw,
      efficiency_pct: solar.efficiency_pct,
      forest_density_pct: satellite.forest_density_pct,
      ndvi_score: satellite.ndvi_score,
      combined_score: combined,
    };
  });
}

export function compareProjects(ids: number[]): ComparisonResult {
  const projects = loadProjectMetrics(ids);

  if (projects.length === 0) {
    return {
      projects: [],
      metrics: COMPARISON_METRICS,
      summary: {
        highest_combined: null,
        lowest_combined: null,
        avg_credit_quality: 0,
        avg_green_impact: 0,
        avg_combined: 0,
      },
    };
  }

  const sorted = [...projects].sort((a, b) => b.combined_score - a.combined_score);
  const avgCq = round(projects.reduce((s, p) => s + p.credit_quality, 0) / projects.length);
  const avgGi = round(projects.reduce((s, p) => s + p.green_impact, 0) / projects.length);
  const avgComb = round(projects.reduce((s, p) => s + p.combined_score, 0) / projects.length);

  return {
    projects,
    metrics: COMPARISON_METRICS,
    summary: {
      highest_combined: sorted[0]?.id ?? null,
      lowest_combined: sorted[sorted.length - 1]?.id ?? null,
      avg_credit_quality: avgCq,
      avg_green_impact: avgGi,
      avg_combined: avgComb,
    },
  };
}

export function generateRanking(ids: number[], criteria: string): RankingResult {
  if (!VALID_CRITERIA.has(criteria)) {
    throw new Error(`Invalid ranking criteria "${criteria}". Valid options: ${Array.from(VALID_CRITERIA).join(", ")}`);
  }

  const projects = loadProjectMetrics(ids);
  const sorted = [...projects].sort((a, b) => {
    const aVal = a[criteria as keyof ProjectMetrics] as number;
    const bVal = b[criteria as keyof ProjectMetrics] as number;
    return bVal - aVal;
  });

  const rankings: RankingEntry[] = sorted.map((p, i) => ({
    rank: i + 1,
    id: p.id,
    score: p[criteria as keyof ProjectMetrics] as number,
    credit_quality: p.credit_quality,
    green_impact: p.green_impact,
  }));

  return { criteria, rankings };
}

export function comparisonToCsv(comparison: ComparisonResult): string {
  const header = [
    "project_id",
    ...comparison.metrics.map((m) => m.label),
  ].join(",");

  const rows = comparison.projects.map((p) =>
    [
      p.id,
      p.credit_quality,
      p.green_impact,
      p.power_output_kw,
      p.efficiency_pct,
      p.forest_density_pct,
      p.ndvi_score,
      p.combined_score,
    ].join(","),
  );

  const summaryRow = [
    "AVERAGE",
    round(comparison.summary.avg_credit_quality),
    round(comparison.summary.avg_green_impact),
    "",
    "",
    "",
    "",
    round(comparison.summary.avg_combined),
  ].join(",");

  return [header, ...rows, "", summaryRow].join("\n") + "\n";
}

export function rankingToCsv(ranking: RankingResult): string {
  const header = "rank,project_id,score,credit_quality,green_impact";
  const rows = ranking.rankings.map((r) =>
    `${r.rank},${r.id},${r.score},${r.credit_quality},${r.green_impact}`,
  );
  return [header, ...rows].join("\n") + "\n";
}

export function validateCriteria(criteria: string): string | null {
  if (!VALID_CRITERIA.has(criteria)) {
    return `Invalid criteria "${criteria}". Valid options: ${Array.from(VALID_CRITERIA).join(", ")}`;
  }
  return null;
}
