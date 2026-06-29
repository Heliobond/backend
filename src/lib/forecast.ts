const MAX_POWER_KW = 1000;

export interface ForecastPoint {
  timestamp: number;
  value: number;
}

export interface ForecastResult {
  project_id: number;
  field: string;
  method: string;
  horizon: number;
  forecasts: ForecastPoint[];
}

export interface SeasonalPattern {
  period: string;
  patterns: { label: string; avg_value: number; count: number }[];
  strength: number;
}

export interface AccuracyMetrics {
  mae: number;
  rmse: number;
  mape: number;
  bias: number;
  sample_count: number;
}

export interface ForecastAccuracyResult {
  project_id: number;
  field: string;
  method: string;
  metrics: AccuracyMetrics;
  comparisons: { timestamp: number; actual: number; predicted: number; error: number }[];
}

export interface SolarSnapshot {
  power_output_kw: number;
  efficiency_pct: number;
  max_power_kw: number;
  timestamp: number;
}

export interface SatelliteSnapshot {
  forest_density_pct: number;
  ndvi_score: number;
  timestamp: number;
}

/**
 * Generates a deterministic pseudo-random number in [0, 1) for a given seed and timestamp.
 * Uses a MurmurHash3 finalizer to ensure avalanche: nearby seeds produce
 * vastly different outputs, preventing seed collision for adjacent project IDs.
 * The timeMs parameter allows historical/forecast data to vary by hour.
 */
function seededRandomAtTime(seed: number, timeMs: number): number {
  const hourSeed = Math.floor(timeMs / 3_600_000);
  let h = (seed * 2654435761) ^ (hourSeed * 40503) ^ 0x9e3779b9;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h = (h ^ (h >>> 16)) >>> 0;
  return h / 0xffffffff;
}

export function getHistoricalSolarData(projectId: number, timestamp: number): SolarSnapshot {
  const base = seededRandomAtTime(projectId, timestamp);
  const drift = seededRandomAtTime(projectId * 7 + 1, timestamp);
  const efficiency_pct = Math.min(98, Math.max(40, 40 + base * 58 + drift * 2 - 1));
  const power_output_kw = (efficiency_pct / 100) * MAX_POWER_KW;
  return {
    power_output_kw: Math.round(power_output_kw * 100) / 100,
    efficiency_pct: Math.round(efficiency_pct * 100) / 100,
    max_power_kw: MAX_POWER_KW,
    timestamp,
  };
}

export function getHistoricalSatelliteData(projectId: number, timestamp: number): SatelliteSnapshot {
  const base = seededRandomAtTime(projectId * 3 + 5, timestamp);
  const drift = seededRandomAtTime(projectId * 11 + 2, timestamp);
  const forest_density_pct = Math.min(100, Math.max(0, 30 + base * 65 + drift * 5 - 2.5));
  return {
    forest_density_pct: Math.round(forest_density_pct * 100) / 100,
    ndvi_score: Math.round(Math.min(1, forest_density_pct / 100) * 1000) / 1000,
    timestamp,
  };
}

export function generateHistory(
  projectId: number,
  field: "power_output_kw" | "efficiency_pct",
  hoursBack: number,
): ForecastPoint[] {
  const now = Date.now();
  const points: ForecastPoint[] = [];
  for (let i = hoursBack; i >= 1; i--) {
    const ts = now - i * 3_600_000;
    const solar = getHistoricalSolarData(projectId, ts);
    points.push({ timestamp: ts, value: solar[field] });
  }
  return points;
}

function round(n: number, d = 4): number {
  const f = Math.pow(10, d);
  return Math.round(n * f) / f;
}

function mean(values: number[]): number {
  return values.reduce((s, v) => s + v, 0) / values.length;
}

function stdDev(values: number[], avg: number): number {
  return Math.sqrt(values.reduce((s, v) => s + (v - avg) ** 2, 0) / values.length);
}

function last(values: number[]): number {
  return values[values.length - 1];
}

// ── Forecasting methods ──────────────────────────────────────────────────────

function naiveForecast(history: number[], horizon: number): number[] {
  if (history.length === 0) return [];
  const v = last(history);
  return Array(horizon).fill(v);
}

function movingAverageForecast(history: number[], horizon: number, window = 4): number[] {
  if (history.length < window) return naiveForecast(history, horizon);
  const windowed = history.slice(-window);
  const avg = mean(windowed);
  return Array(horizon).fill(round(avg));
}

function exponentialSmoothingForecast(history: number[], horizon: number, alpha = 0.3): number[] {
  if (history.length === 0) return [];
  let s = history[0];
  for (let i = 1; i < history.length; i++) {
    s = alpha * history[i] + (1 - alpha) * s;
  }
  return Array(horizon).fill(round(s));
}

function linearTrendForecast(history: number[], horizon: number): number[] {
  const n = history.length;
  if (n < 2) return naiveForecast(history, horizon);
  const xMean = (n - 1) / 2;
  const yMean = mean(history);
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    const x = i;
    num += (x - xMean) * (history[i] - yMean);
    den += (x - xMean) ** 2;
  }
  const slope = den !== 0 ? num / den : 0;
  const intercept = yMean - slope * xMean;
  const forecasts: number[] = [];
  for (let i = 0; i < horizon; i++) {
    const t = n + i;
    forecasts.push(round(intercept + slope * t));
  }
  return forecasts;
}

function seasonalNaiveForecast(history: number[], horizon: number, seasonLength = 24): number[] {
  if (history.length < seasonLength) return naiveForecast(history, horizon);
  const forecasts: number[] = [];
  for (let i = 0; i < horizon; i++) {
    const idx = history.length - seasonLength + (i % seasonLength);
    forecasts.push(history[idx]);
  }
  return forecasts;
}

function seasonalDecompositionForecast(history: number[], horizon: number, seasonLength = 24): number[] {
  const n = history.length;
  if (n < seasonLength * 2) return linearTrendForecast(history, horizon);

  const seasonalComponents: number[] = [];
  for (let i = 0; i < seasonLength; i++) {
    let sum = 0;
    let count = 0;
    for (let j = i; j < n; j += seasonLength) {
      sum += history[j];
      count++;
    }
    seasonalComponents.push(count > 0 ? sum / count : 0);
  }

  const seasonalAvg = mean(seasonalComponents);
  const detrended: number[] = history.map((v, i) => v - seasonalComponents[i % seasonLength] + seasonalAvg);
  const trend = linearTrendForecast(detrended, horizon);

  const forecasts: number[] = [];
  for (let i = 0; i < horizon; i++) {
    const idx = (n + i) % seasonLength;
    forecasts.push(round(trend[i] - seasonalAvg + seasonalComponents[idx]));
  }
  return forecasts;
}

type ForecastMethod = "naive" | "moving_average" | "exponential_smoothing" | "linear_trend" | "seasonal_naive" | "seasonal_decomposition";

const FORECAST_METHODS: Record<ForecastMethod, (h: number[], horizon: number) => number[]> = {
  naive: naiveForecast,
  moving_average: (h, horizon) => movingAverageForecast(h, horizon, 4),
  exponential_smoothing: (h, horizon) => exponentialSmoothingForecast(h, horizon, 0.3),
  linear_trend: linearTrendForecast,
  seasonal_naive: (h, horizon) => seasonalNaiveForecast(h, horizon, 24),
  seasonal_decomposition: (h, horizon) => seasonalDecompositionForecast(h, horizon, 24),
};

export function getValidMethods(): string[] {
  return Object.keys(FORECAST_METHODS);
}

export function isMethodValid(method: string): method is ForecastMethod {
  return method in FORECAST_METHODS;
}

// ── Main forecast function ───────────────────────────────────────────────────

export function forecastProject(
  projectId: number,
  field: "power_output_kw" | "efficiency_pct",
  horizon: number,
  method: ForecastMethod = "exponential_smoothing",
  historyHours = 168,
): ForecastResult {
  const history = generateHistory(projectId, field, historyHours);
  const values = history.map((p) => p.value);

  const forecastFn = FORECAST_METHODS[method];
  const predicted = forecastFn(values, horizon);

  const lastTs = history.length > 0 ? history[history.length - 1].timestamp : Date.now();
  const forecasts: ForecastPoint[] = predicted.map((v, i) => ({
    timestamp: lastTs + (i + 1) * 3_600_000,
    value: round(v, 2),
  }));

  return {
    project_id: projectId,
    field,
    method,
    horizon,
    forecasts,
  };
}

// ── Weather-adjusted predictions ─────────────────────────────────────────────

export function forecastWeatherAdjusted(
  projectId: number,
  horizon: number,
  historyHours = 168,
): ForecastResult {
  const solarHistory = generateHistory(projectId, "power_output_kw", historyHours);
  const tsValues = solarHistory.map((p) => p.value);

  const now = Date.now();
  const satHistory: { forest_density_pct: number; ndvi_score: number }[] = [];
  for (let i = historyHours; i >= 1; i--) {
    satHistory.push(getHistoricalSatelliteData(projectId, now - i * 3_600_000));
  }

  const correlations = satHistory.map((s) => s.ndvi_score);
  const avgCorr = mean(correlations);
  const baseForecast = exponentialSmoothingForecast(tsValues, horizon, 0.3);

  const lateHours = 24;
  const recentSatData = correlations.slice(-lateHours).filter((v) => v > 0);
  const recentWeatherFactor = recentSatData.length > 0
    ? mean(recentSatData) / Math.max(avgCorr, 0.01)
    : 1;

  const lastTs = solarHistory.length > 0 ? solarHistory[solarHistory.length - 1].timestamp : now;
  const forecasts: ForecastPoint[] = baseForecast.map((v, i) => {
    const weatherImpact = 1 + (recentWeatherFactor - 1) * Math.max(0, 1 - i / horizon);
    return {
      timestamp: lastTs + (i + 1) * 3_600_000,
      value: round(Math.max(0, v * weatherImpact), 2),
    };
  });

  return {
    project_id: projectId,
    field: "power_output_kw",
    method: "weather_adjusted",
    horizon,
    forecasts,
  };
}

// ── Seasonal patterns ────────────────────────────────────────────────────────

export function analyzeSeasonalPatterns(
  projectId: number,
  field: "power_output_kw" | "efficiency_pct",
  historyHours = 720,
): { hourly: SeasonalPattern; monthly: SeasonalPattern } {
  const history = generateHistory(projectId, field, historyHours);

  const hourlyBuckets = new Map<number, number[]>();
  for (const point of history) {
    const hour = new Date(point.timestamp).getUTCHours();
    if (!hourlyBuckets.has(hour)) hourlyBuckets.set(hour, []);
    hourlyBuckets.get(hour)!.push(point.value);
  }

  const hourlyPatterns: { label: string; avg_value: number; count: number }[] = [];
  let hourlyStrengthSum = 0;
  for (let h = 0; h < 24; h++) {
    const vals = hourlyBuckets.get(h) ?? [];
    const avg = vals.length > 0 ? mean(vals) : 0;
    hourlyPatterns.push({ label: `${h}:00`, avg_value: round(avg, 2), count: vals.length });
    if (vals.length > 0) {
      hourlyStrengthSum += Math.abs(avg - mean(history.map((p) => p.value)));
    }
  }

  const monthlyBuckets = new Map<number, number[]>();
  for (const point of history) {
    const month = new Date(point.timestamp).getUTCMonth();
    if (!monthlyBuckets.has(month)) monthlyBuckets.set(month, []);
    monthlyBuckets.get(month)!.push(point.value);
  }

  const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const monthlyPatterns: { label: string; avg_value: number; count: number }[] = [];
  let monthlyStrengthSum = 0;
  const overallAvg = mean(history.map((p) => p.value));
  for (let m = 0; m < 12; m++) {
    const vals = monthlyBuckets.get(m) ?? [];
    const avg = vals.length > 0 ? mean(vals) : 0;
    monthlyPatterns.push({ label: monthNames[m], avg_value: round(avg, 2), count: vals.length });
    if (vals.length > 0) {
      monthlyStrengthSum += Math.abs(avg - overallAvg);
    }
  }

  const totalHourlyDev = history.length > 0 ? hourlyStrengthSum / 24 : 0;
  const totalVar = history.length > 0 ? stdDev(history.map((p) => p.value), overallAvg) : 1;
  const hourlyStrength = totalVar > 0 ? Math.min(1, totalHourlyDev / totalVar) : 0;

  const totalMonthlyDev = history.length > 0 ? monthlyStrengthSum / 12 : 0;
  const monthlyStrength = totalVar > 0 ? Math.min(1, totalMonthlyDev / totalVar) : 0;

  return {
    hourly: { period: "hourly", patterns: hourlyPatterns, strength: round(hourlyStrength, 4) },
    monthly: { period: "monthly", patterns: monthlyPatterns, strength: round(monthlyStrength, 4) },
  };
}

// ── Forecast accuracy ────────────────────────────────────────────────────────

export function evaluateForecastAccuracy(
  projectId: number,
  field: "power_output_kw" | "efficiency_pct",
  method: ForecastMethod = "exponential_smoothing",
  testHours = 24,
  trainingHours = 168,
): ForecastAccuracyResult {
  const history = generateHistory(projectId, field, trainingHours);
  if (history.length < testHours + 1) {
    return {
      project_id: projectId,
      field,
      method,
      metrics: { mae: 0, rmse: 0, mape: 0, bias: 0, sample_count: 0 },
      comparisons: [],
    };
  }

  const training = history.slice(0, -testHours);
  const actuals = history.slice(-testHours);

  const trainValues = training.map((p) => p.value);
  const forecastFn = FORECAST_METHODS[method];
  const predictedValues = forecastFn(trainValues, testHours);

  const comparisons: { timestamp: number; actual: number; predicted: number; error: number }[] = [];
  for (let i = 0; i < testHours && i < predictedValues.length && i < actuals.length; i++) {
    comparisons.push({
      timestamp: actuals[i].timestamp,
      actual: actuals[i].value,
      predicted: round(predictedValues[i], 2),
      error: round(actuals[i].value - predictedValues[i], 2),
    });
  }

  const errors = comparisons.map((c) => Math.abs(c.error));
  const sqErrors = comparisons.map((c) => c.error ** 2);
  const pctErrors = comparisons.map((c) => (c.actual !== 0 ? Math.abs(c.error / c.actual) * 100 : 0));
  const biases = comparisons.map((c) => c.error);

  const count = comparisons.length;
  const metrics: AccuracyMetrics = {
    mae: count > 0 ? round(mean(errors), 2) : 0,
    rmse: count > 0 ? round(Math.sqrt(mean(sqErrors)), 2) : 0,
    mape: count > 0 ? round(mean(pctErrors), 2) : 0,
    bias: count > 0 ? round(mean(biases), 2) : 0,
    sample_count: count,
  };

  return { project_id: projectId, field, method, metrics, comparisons };
}

// ── CSV export ───────────────────────────────────────────────────────────────

export function forecastToCsv(result: ForecastResult): string {
  const header = "project_id,field,method,horizon,timestamp,forecast_value";
  const rows = result.forecasts.map((f) =>
    `${result.project_id},${result.field},${result.method},${result.horizon},${new Date(f.timestamp).toISOString()},${f.value}`,
  );
  return [header, ...rows].join("\n") + "\n";
}

export function seasonalPatternsToCsv(
  projectId: number,
  patterns: { hourly: SeasonalPattern; monthly: SeasonalPattern },
): string {
  const rows: string[] = ["type,label,avg_value,count,strength"];
  const hourly = patterns.hourly;
  for (const p of hourly.patterns) {
    rows.push(`hourly,${p.label},${p.avg_value},${p.count},${hourly.strength}`);
  }
  const monthly = patterns.monthly;
  for (const p of monthly.patterns) {
    rows.push(`monthly,${p.label},${p.avg_value},${p.count},${monthly.strength}`);
  }
  return rows.join("\n") + "\n";
}

export function accuracyToCsv(result: ForecastAccuracyResult): string {
  const header = "project_id,field,method,timestamp,actual,predicted,error";
  const rows = result.comparisons.map((c) =>
    `${result.project_id},${result.field},${result.method},${new Date(c.timestamp).toISOString()},${c.actual},${c.predicted},${c.error}`,
  );
  const summary = `\nMAE,RMSE,MAPE,Bias,SampleCount\n${result.metrics.mae},${result.metrics.rmse},${result.metrics.mape},${result.metrics.bias},${result.metrics.sample_count}`;
  return [header, ...rows, summary].join("\n") + "\n";
}
