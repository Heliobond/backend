import { getSolarData, getSatelliteData } from "../routes/iot";
import { computeScores } from "./scoring";
import { getHistory, ScoreEntry } from "./history";

// ── Industry standard benchmarks ─────────────────────────────────────────────

export interface BenchmarkThreshold {
  poor: number;
  fair: number;
  good: number;
  excellent: number;
}

export interface BenchmarkDefinition {
  id: string;
  name: string;
  description: string;
  metric: string;
  thresholds: BenchmarkThreshold;
  source: string;
}

const DEFAULT_BENCHMARKS: BenchmarkDefinition[] = [
  {
    id: "credit_quality",
    name: "Credit Quality",
    description: "Industry standard credit quality benchmark based on efficiency and reliability",
    metric: "credit_quality",
    thresholds: { poor: 40, fair: 60, good: 80, excellent: 95 },
    source: "Heliobond Industry Standards 2026",
  },
  {
    id: "green_impact",
    name: "Green Impact",
    description: "Industry standard green impact benchmark based on environmental contribution",
    metric: "green_impact",
    thresholds: { poor: 35, fair: 55, good: 75, excellent: 90 },
    source: "Heliobond Industry Standards 2026",
  },
  {
    id: "combined_score",
    name: "Combined Score",
    description: "Aggregate performance benchmark combining credit quality and green impact",
    metric: "combined_score",
    thresholds: { poor: 80, fair: 120, good: 160, excellent: 190 },
    source: "Heliobond Industry Standards 2026",
  },
  {
    id: "efficiency_pct",
    name: "Solar Efficiency",
    description: "Solar panel efficiency benchmark based on industry averages",
    metric: "efficiency_pct",
    thresholds: { poor: 50, fair: 65, good: 80, excellent: 92 },
    source: "National Renewable Energy Lab (NREL)",
  },
  {
    id: "forest_density_pct",
    name: "Forest Density",
    description: "Forest density benchmark based on global conservation standards",
    metric: "forest_density_pct",
    thresholds: { poor: 30, fair: 50, good: 70, excellent: 85 },
    source: "Global Forest Watch",
  },
];

// Custom benchmarks defined by users
const customBenchmarks = new Map<string, BenchmarkDefinition>();

// ── Types ────────────────────────────────────────────────────────────────────

export interface ProjectBenchmarkData {
  project_id: number;
  value: number;
  benchmark: BenchmarkDefinition;
  rating: "poor" | "fair" | "good" | "excellent";
  percentile: number;
}

export interface PercentileRanking {
  project_id: number;
  value: number;
  percentile: number;
  total_projects_sampled: number;
}

export interface BenchmarkAlert {
  project_id: number;
  metric: string;
  value: number;
  threshold: number;
  severity: "info" | "warning" | "critical";
  message: string;
  benchmark_name: string;
  timestamp: number;
}

export interface TrendVsBenchmark {
  project_id: number;
  metric: string;
  benchmark_value: number;
  current_value: number;
  delta: number;
  trend_direction: "improving" | "declining" | "stable";
  history: { timestamp: number; value: number }[];
}

// ── Helper ───────────────────────────────────────────────────────────────────

function getMetricValue(projectId: number, metric: string): number {
  const solar = getSolarData(projectId);
  const satellite = getSatelliteData(projectId);
  const scores = computeScores({ solar, satellite });

  const metricMap: Record<string, number> = {
    credit_quality: scores.credit_quality,
    green_impact: scores.green_impact,
    combined_score: scores.credit_quality + scores.green_impact,
    power_output_kw: solar.power_output_kw,
    efficiency_pct: solar.efficiency_pct,
    forest_density_pct: satellite.forest_density_pct,
    ndvi_score: satellite.ndvi_score,
  };

  return metricMap[metric];
}

function getRating(value: number, thresholds: BenchmarkThreshold): "poor" | "fair" | "good" | "excellent" {
  if (value >= thresholds.excellent) return "excellent";
  if (value >= thresholds.good) return "good";
  if (value >= thresholds.fair) return "fair";
  return "poor";
}

// ── Benchmark definitions ────────────────────────────────────────────────────

export function getBenchmarks(): BenchmarkDefinition[] {
  const defaults = [...DEFAULT_BENCHMARKS];
  const customs = Array.from(customBenchmarks.values());
  return [...defaults, ...customs];
}

export function getBenchmarkById(id: string): BenchmarkDefinition | undefined {
  const found = DEFAULT_BENCHMARKS.find((b) => b.id === id) ?? customBenchmarks.get(id);
  return found;
}

export function defineCustomBenchmark(def: Omit<BenchmarkDefinition, "id"> & { id?: string }): BenchmarkDefinition {
  const id = def.id ?? def.name.toLowerCase().replace(/\s+/g, "_");
  const benchmark: BenchmarkDefinition = { ...def, id };
  customBenchmarks.set(id, benchmark);
  return benchmark;
}

// ── Benchmark evaluation ─────────────────────────────────────────────────────

export function evaluateProjectBenchmark(projectId: number, benchmark: BenchmarkDefinition): ProjectBenchmarkData {
  const value = getMetricValue(projectId, benchmark.metric);
  const rating = getRating(value, benchmark.thresholds);
  const percentile = calculatePercentile(value, benchmark.metric);

  return {
    project_id: projectId,
    value,
    benchmark,
    rating,
    percentile,
  };
}

export function evaluateAllBenchmarks(projectId: number): ProjectBenchmarkData[] {
  return getBenchmarks().map((b) => evaluateProjectBenchmark(projectId, b));
}

// ── Percentile calculation ───────────────────────────────────────────────────

const percentileStore = new Map<string, number[]>();

function recordSample(metric: string, value: number): void {
  if (!percentileStore.has(metric)) {
    percentileStore.set(metric, []);
  }
  percentileStore.get(metric)!.push(value);
}

function getSampledValues(metric: string): number[] {
  return percentileStore.get(metric) ?? [];
}

export function calculatePercentile(value: number, metric: string): number {
  recordSample(metric, value);
  const samples = getSampledValues(metric);
  const sorted = [...samples].sort((a, b) => a - b);
  const index = sorted.indexOf(value);
  if (index === -1) return 50;
  return Math.round((index / Math.max(sorted.length - 1, 1)) * 100);
}

export function getPercentileRanking(projectId: number, metric: string): PercentileRanking {
  const value = getMetricValue(projectId, metric);
  const percentile = calculatePercentile(value, metric);
  const samples = getSampledValues(metric);

  return {
    project_id: projectId,
    value,
    percentile,
    total_projects_sampled: samples.length,
  };
}

// ── Benchmark alerts ─────────────────────────────────────────────────────────

export function checkBenchmarkAlerts(projectId: number): BenchmarkAlert[] {
  const alerts: BenchmarkAlert[] = [];

  for (const benchmark of DEFAULT_BENCHMARKS) {
    const data = evaluateProjectBenchmark(projectId, benchmark);
    const now = Date.now();

    if (data.rating === "poor") {
      alerts.push({
        project_id: projectId,
        metric: benchmark.metric,
        value: data.value,
        threshold: benchmark.thresholds.fair,
        severity: "critical",
        message: `Project ${projectId} has poor ${benchmark.name} (${data.value}) — below fair threshold (${benchmark.thresholds.fair})`,
        benchmark_name: benchmark.name,
        timestamp: now,
      });
    } else if (data.rating === "fair") {
      alerts.push({
        project_id: projectId,
        metric: benchmark.metric,
        value: data.value,
        threshold: benchmark.thresholds.good,
        severity: "warning",
        message: `Project ${projectId} has fair ${benchmark.name} (${data.value}) — below good threshold (${benchmark.thresholds.good})`,
        benchmark_name: benchmark.name,
        timestamp: now,
      });
    } else if (data.rating === "good") {
      alerts.push({
        project_id: projectId,
        metric: benchmark.metric,
        value: data.value,
        threshold: benchmark.thresholds.excellent,
        severity: "info",
        message: `Project ${projectId} has good ${benchmark.name} (${data.value}) — approaching excellent (${benchmark.thresholds.excellent})`,
        benchmark_name: benchmark.name,
        timestamp: now,
      });
    }
  }

  return alerts;
}

// ── Trend vs benchmark ───────────────────────────────────────────────────────

export function trendVsBenchmark(
  projectId: number,
  metric: string,
  benchmarkId: string,
): TrendVsBenchmark {
  const benchmark = getBenchmarkById(benchmarkId);
  if (!benchmark) {
    throw new Error(`Benchmark "${benchmarkId}" not found`);
  }

  const currentValue = getMetricValue(projectId, metric);
  const benchmarkValue = benchmark.thresholds.good;

  const rawHistory = getHistory(projectId);
  const history = rawHistory
    .map((e: ScoreEntry) => ({ timestamp: e.timestamp, value: e[metric as keyof ScoreEntry] as number }))
    .filter((h) => h.value !== undefined)
    .sort((a, b) => a.timestamp - b.timestamp);

  let trendDirection: "improving" | "declining" | "stable" = "stable";
  if (history.length >= 2) {
    const first = history[0].value;
    const last = history[history.length - 1].value;
    const delta = last - first;
    trendDirection = delta > 2 ? "improving" : delta < -2 ? "declining" : "stable";
  }

  return {
    project_id: projectId,
    metric,
    benchmark_value: benchmarkValue,
    current_value: currentValue,
    delta: currentValue - benchmarkValue,
    trend_direction: trendDirection,
    history,
  };
}

// ── Initialise percentile store with some samples ────────────────────────────

export function initBenchmarkSamples(sampleSize = 20): void {
  const metrics = ["credit_quality", "green_impact", "combined_score", "efficiency_pct", "forest_density_pct"];
  for (const metric of metrics) {
    const samples: number[] = [];
    for (let i = 1; i <= sampleSize; i++) {
      const solar = getSolarData(i);
      const satellite = getSatelliteData(i);
      const scores = computeScores({ solar, satellite });
      const metricMap: Record<string, number> = {
        credit_quality: scores.credit_quality,
        green_impact: scores.green_impact,
        combined_score: scores.credit_quality + scores.green_impact,
        efficiency_pct: solar.efficiency_pct,
        forest_density_pct: satellite.forest_density_pct,
      };
      samples.push(metricMap[metric]);
    }
    percentileStore.set(metric, samples);
  }
}
