export interface AnomalyConfig {
  sensitivityZScore: number;    // z-score threshold (default 2.5)
  trendWindowSize: number;      // readings to use for baseline (default 20)
  trendDeviationPct: number;    // % deviation to flag as trend anomaly (default 20)
  minBaseline: number;          // min readings before detection activates (default 5)
}

export interface AnomalyAlert {
  type: "outlier" | "trend";
  metric: string;
  value: number;
  baseline: number;
  deviation: number;
  severity: "low" | "medium" | "high";
  timestamp: number;
  message: string;
}

export interface AnomalyResult {
  projectId: number;
  timestamp: number;
  anomalies: AnomalyAlert[];
  metrics: {
    efficiency_pct: { value: number; mean: number; stdDev: number; zScore: number };
    power_output_kw: { value: number; mean: number; stdDev: number; zScore: number };
    forest_density_pct: { value: number; mean: number; stdDev: number; zScore: number };
    ndvi_score: { value: number; mean: number; stdDev: number; zScore: number };
  };
}

type MetricKey = "efficiency_pct" | "power_output_kw" | "forest_density_pct" | "ndvi_score";

const DEFAULT_CONFIG: AnomalyConfig = {
  sensitivityZScore: 2.5,
  trendWindowSize: 20,
  trendDeviationPct: 20,
  minBaseline: 5,
};

// Per-project rolling history for baseline
const historyStore = new Map<number, Map<MetricKey, number[]>>();
let globalConfig: AnomalyConfig = { ...DEFAULT_CONFIG };

export function configureAnomalyDetection(config: Partial<AnomalyConfig>): void {
  globalConfig = { ...globalConfig, ...config };
}

export function getAnomalyConfig(): AnomalyConfig {
  return { ...globalConfig };
}

function getHistory(projectId: number, metric: MetricKey): number[] {
  let projectHistory = historyStore.get(projectId);
  if (!projectHistory) {
    projectHistory = new Map();
    historyStore.set(projectId, projectHistory);
  }
  let vals = projectHistory.get(metric);
  if (!vals) {
    vals = [];
    projectHistory.set(metric, vals);
  }
  return vals;
}

function pushHistory(projectId: number, metric: MetricKey, value: number): void {
  const vals = getHistory(projectId, metric);
  vals.push(value);
  if (vals.length > globalConfig.trendWindowSize) {
    vals.shift();
  }
}

function mean(vals: number[]): number {
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

function stdDev(vals: number[], avg: number): number {
  const variance = vals.reduce((sum, v) => sum + (v - avg) ** 2, 0) / vals.length;
  return Math.sqrt(variance);
}

function severity(zScore: number, threshold: number): "low" | "medium" | "high" {
  const ratio = Math.abs(zScore) / threshold;
  if (ratio >= 2) return "high";
  if (ratio >= 1.5) return "medium";
  return "low";
}

function detectOutlier(
  projectId: number,
  metric: MetricKey,
  value: number,
  config: AnomalyConfig,
): { mean: number; stdDev: number; zScore: number; alert: AnomalyAlert | null } {
  const history = getHistory(projectId, metric);

  if (history.length < config.minBaseline) {
    return { mean: value, stdDev: 0, zScore: 0, alert: null };
  }

  const avg = mean(history);
  const sd = stdDev(history, avg);
  const zScore = sd > 0 ? (value - avg) / sd : 0;

  let alert: AnomalyAlert | null = null;
  if (Math.abs(zScore) > config.sensitivityZScore) {
    alert = {
      type: "outlier",
      metric,
      value,
      baseline: avg,
      deviation: zScore,
      severity: severity(zScore, config.sensitivityZScore),
      timestamp: Date.now(),
      message: `${metric} value ${value.toFixed(2)} is ${Math.abs(zScore).toFixed(2)} std devs from baseline ${avg.toFixed(2)}`,
    };
  }

  return { mean: avg, stdDev: sd, zScore, alert };
}

function detectTrend(
  projectId: number,
  metric: MetricKey,
  value: number,
  config: AnomalyConfig,
): AnomalyAlert | null {
  const history = getHistory(projectId, metric);
  if (history.length < config.minBaseline) return null;

  const baseline = mean(history.slice(0, Math.ceil(history.length / 2)));
  if (baseline === 0) return null;

  const deviationPct = ((value - baseline) / baseline) * 100;
  if (Math.abs(deviationPct) > config.trendDeviationPct) {
    return {
      type: "trend",
      metric,
      value,
      baseline,
      deviation: deviationPct,
      severity: Math.abs(deviationPct) > config.trendDeviationPct * 2 ? "high" : "medium",
      timestamp: Date.now(),
      message: `${metric} shows ${deviationPct > 0 ? "upward" : "downward"} trend of ${Math.abs(deviationPct).toFixed(1)}% from historical baseline`,
    };
  }
  return null;
}

export function detectAnomalies(
  projectId: number,
  readings: {
    efficiency_pct: number;
    power_output_kw: number;
    forest_density_pct: number;
    ndvi_score: number;
  },
  config?: Partial<AnomalyConfig>,
): AnomalyResult {
  const cfg = config ? { ...globalConfig, ...config } : globalConfig;
  const metrics: MetricKey[] = ["efficiency_pct", "power_output_kw", "forest_density_pct", "ndvi_score"];
  const anomalies: AnomalyAlert[] = [];
  const metricResults: AnomalyResult["metrics"] = {} as any;

  for (const metric of metrics) {
    const value = readings[metric];
    const { mean: avg, stdDev: sd, zScore, alert: outlierAlert } = detectOutlier(projectId, metric, value, cfg);
    const trendAlert = detectTrend(projectId, metric, value, cfg);

    if (outlierAlert) anomalies.push(outlierAlert);
    if (trendAlert) anomalies.push(trendAlert);

    metricResults[metric] = { value, mean: avg, stdDev: sd, zScore };

    // Record into history after detection so current value doesn't skew its own check
    pushHistory(projectId, metric, value);
  }

  return { projectId, timestamp: Date.now(), anomalies, metrics: metricResults };
}

export function clearHistory(projectId?: number): void {
  if (projectId !== undefined) {
    historyStore.delete(projectId);
  } else {
    historyStore.clear();
  }
}
