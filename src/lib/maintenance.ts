import { getHistoricalSolarData } from "./forecast";
import { getPanelConfig } from "./panels";

export interface EfficiencyPoint {
  timestamp: number;
  efficiency_pct: number;
}

export interface EfficiencyTrend {
  direction: "improving" | "declining" | "stable";
  degradation_rate_pct_per_year: number;
  slope: number;
  intercept: number;
  r_squared: number;
  baseline_avg: number;
  current_avg: number;
  sample_count: number;
}

export interface EfficiencyTrendAnalysis {
  project_id: number;
  trend: EfficiencyTrend;
  monthly_averages: { month: string; efficiency_pct: number; point_count: number }[];
  weekly_averages: { week: string; efficiency_pct: number; point_count: number }[];
}

export interface FailurePrediction {
  project_id: number;
  current_efficiency: number;
  critical_threshold: number;
  estimated_hours_to_threshold: number;
  estimated_days_to_threshold: number;
  severity: "none" | "low" | "medium" | "high" | "critical";
  trend_quality: number;
  confidence: number;
  panel_type: string;
}

export type MaintenanceActionType = "inspection" | "cleaning" | "repair" | "panel_replacement" | "inverter_service" | "wiring_check" | "structural_check";

export interface MaintenanceAction {
  type: MaintenanceActionType;
  priority: "low" | "medium" | "high" | "critical";
  description: string;
  estimated_cost: number;
  urgency_hours: number;
}

export interface MaintenanceRecommendation {
  project_id: number;
  panel_type: string;
  current_efficiency: number;
  efficiency_rating: number;
  shading_factor: number;
  overall_health: "good" | "fair" | "poor" | "critical";
  actions: MaintenanceAction[];
  summary: string;
}

export interface ScheduleEntry {
  date: string;
  actions: MaintenanceAction[];
  priority: "low" | "medium" | "high" | "critical";
}

export interface MaintenanceSchedule {
  project_id: number;
  generated_at: string;
  schedule: ScheduleEntry[];
}

export interface FullMaintenanceReport {
  project_id: number;
  generated_at: string;
  trend_analysis: EfficiencyTrendAnalysis;
  failure_prediction: FailurePrediction;
  recommendation: MaintenanceRecommendation;
  schedule: MaintenanceSchedule;
}

export type DegradationSeverity = "none" | "low" | "medium" | "high" | "critical";

const CRITICAL_EFFICIENCY: Record<string, number> = {
  monocrystalline: 70,
  polycrystalline: 65,
  "thin-film": 60,
  bifacial: 72,
};

const PANEL_LIFESPAN: Record<string, number> = {
  monocrystalline: 87600,
  polycrystalline: 78840,
  "thin-film": 52560,
  bifacial: 96360,
};

function round(n: number, d = 2): number {
  const f = Math.pow(10, d);
  return Math.round(n * f) / f;
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((s, v) => s + v, 0) / values.length;
}

function linearRegression(y: number[]): { slope: number; intercept: number; rSquared: number } {
  const n = y.length;
  if (n < 2) return { slope: 0, intercept: y[0] || 0, rSquared: 1 };

  const xMean = (n - 1) / 2;
  const yMean = mean(y);
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    const x = i;
    num += (x - xMean) * (y[i] - yMean);
    den += (x - xMean) ** 2;
  }
  const slope = den !== 0 ? num / den : 0;
  const intercept = yMean - slope * xMean;

  const yPred = y.map((_, i) => intercept + slope * i);
  const ssRes = y.reduce((s, v, i) => s + (v - yPred[i]) ** 2, 0);
  const ssTot = y.reduce((s, v) => s + (v - yMean) ** 2, 0);
  const rSquared = ssTot > 0 ? 1 - ssRes / ssTot : 1;

  return { slope, intercept, rSquared };
}

function sampleEfficiencyHistory(projectId: number, hoursBack: number): EfficiencyPoint[] {
  const now = Date.now();
  const points: EfficiencyPoint[] = [];
  for (let i = hoursBack; i >= 1; i--) {
    const ts = now - i * 3_600_000;
    const solar = getHistoricalSolarData(projectId, ts);
    points.push({ timestamp: ts, efficiency_pct: solar.efficiency_pct });
  }
  return points;
}

function getMonthLabel(ts: number): string {
  const d = new Date(ts);
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${months[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

function getWeekLabel(ts: number): string {
  const d = new Date(ts);
  const startOfYear = new Date(d.getUTCFullYear(), 0, 1);
  const diff = d.getTime() - startOfYear.getTime();
  const week = Math.ceil((diff / 86_400_000 + startOfYear.getUTCDay() + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

export function analyzeEfficiencyTrend(projectId: number, historyHours = 720): EfficiencyTrendAnalysis {
  const points = sampleEfficiencyHistory(projectId, historyHours);
  const values = points.map((p) => p.efficiency_pct);

  const { slope, intercept, rSquared } = linearRegression(values);

  const hourlySlope = slope;
  const annualDegradation = hourlySlope * 8760;

  const half = Math.floor(values.length / 2);
  const baselineAvg = half > 0 ? mean(values.slice(0, half)) : mean(values);
  const currentAvg = mean(values.slice(half));

  const diff = currentAvg - baselineAvg;
  const direction: EfficiencyTrend["direction"] =
    diff > 0.5 ? "improving" : diff < -0.5 ? "declining" : "stable";

  const monthlyMap = new Map<string, { sum: number; count: number }>();
  const weeklyMap = new Map<string, { sum: number; count: number }>();

  for (const point of points) {
    const mLabel = getMonthLabel(point.timestamp);
    const wLabel = getWeekLabel(point.timestamp);

    const mBucket = monthlyMap.get(mLabel) ?? { sum: 0, count: 0 };
    mBucket.sum += point.efficiency_pct;
    mBucket.count++;
    monthlyMap.set(mLabel, mBucket);

    const wBucket = weeklyMap.get(wLabel) ?? { sum: 0, count: 0 };
    wBucket.sum += point.efficiency_pct;
    wBucket.count++;
    weeklyMap.set(wLabel, wBucket);
  }

  const monthlyAverages = Array.from(monthlyMap.entries())
    .map(([month, { sum, count }]) => ({ month, efficiency_pct: round(sum / count), point_count: count }))
    .sort((a, b) => a.month.localeCompare(b.month));

  const weeklyAverages = Array.from(weeklyMap.entries())
    .map(([week, { sum, count }]) => ({ week, efficiency_pct: round(sum / count), point_count: count }))
    .sort((a, b) => a.week.localeCompare(b.week));

  return {
    project_id: projectId,
    trend: {
      direction,
      degradation_rate_pct_per_year: round(Math.abs(annualDegradation), 4),
      slope: round(slope, 6),
      intercept: round(intercept, 2),
      r_squared: round(Math.min(1, Math.max(0, rSquared)), 4),
      baseline_avg: round(baselineAvg, 2),
      current_avg: round(currentAvg, 2),
      sample_count: values.length,
    },
    monthly_averages: monthlyAverages,
    weekly_averages: weeklyAverages,
  };
}

export function predictFailure(projectId: number, historyHours = 720): FailurePrediction {
  const analysis = analyzeEfficiencyTrend(projectId, historyHours);
  const points = sampleEfficiencyHistory(projectId, Math.min(historyHours, 24));
  const currentEfficiency = points.length > 0 ? points[points.length - 1].efficiency_pct : 0;

  const config = getPanelConfig(projectId);
  const panelType = config?.panel_type ?? "monocrystalline";
  const criticalThreshold = CRITICAL_EFFICIENCY[panelType] ?? 70;

  const slope = analysis.trend.slope;
  const projectedHours = slope < 0
    ? Math.max(0, (criticalThreshold - currentEfficiency) / slope)
    : Infinity;

  const rSq = analysis.trend.r_squared;
  const sampleCount = analysis.trend.sample_count;
  const trendQuality = Math.min(1, rSq * sampleCount / 100);
  const confidence = round(Math.min(1, trendQuality), 4);

  let severity: DegradationSeverity = "none";
  if (Number.isFinite(projectedHours)) {
    if (projectedHours < 720) severity = "critical";
    else if (projectedHours < 2160) severity = "high";
    else if (projectedHours < 4320) severity = "medium";
    else if (projectedHours < 8760) severity = "low";
  } else {
    const diff = currentEfficiency - criticalThreshold;
    if (diff < 5) severity = "high";
    else if (diff < 10) severity = "medium";
    else if (diff < 15) severity = "low";
  }

  if (currentEfficiency < criticalThreshold) {
    severity = "critical";
  }

  return {
    project_id: projectId,
    current_efficiency: round(currentEfficiency, 2),
    critical_threshold: criticalThreshold,
    estimated_hours_to_threshold: Number.isFinite(projectedHours) ? Math.round(projectedHours) : -1,
    estimated_days_to_threshold: Number.isFinite(projectedHours) ? Math.round(projectedHours / 24) : -1,
    severity,
    trend_quality: round(trendQuality, 4),
    confidence,
    panel_type: panelType,
  };
}

function classifyHealth(eff: number, threshold: number): "good" | "fair" | "poor" | "critical" {
  const ratio = eff / threshold;
  if (ratio >= 1.1) return "good";
  if (ratio >= 0.95) return "fair";
  if (ratio >= 0.85) return "poor";
  return "critical";
}

export function recommendMaintenance(projectId: number, historyHours = 720): MaintenanceRecommendation {
  const prediction = predictFailure(projectId, historyHours);
  const config = getPanelConfig(projectId);
  const panelType = config?.panel_type ?? "monocrystalline";
  const efficiencyRating = config?.efficiency_rating ?? 18;
  const shadingFactor = config?.shading_factor ?? 0;

  const eff = prediction.current_efficiency;
  const threshold = prediction.critical_threshold;
  const health = classifyHealth(eff, threshold);
  const actions: MaintenanceAction[] = [];

  if (shadingFactor > 0.2) {
    actions.push({
      type: "cleaning",
      priority: shadingFactor > 0.4 ? "high" : "medium",
      description: `Vegetation or debris shading detected (factor: ${(shadingFactor * 100).toFixed(0)}%). Trim vegetation and clean panels.`,
      estimated_cost: Math.round(500 + shadingFactor * 2000),
      urgency_hours: shadingFactor > 0.4 ? 168 : 720,
    });
  }

  if (prediction.severity === "critical" || health === "critical") {
    actions.push({
      type: "panel_replacement",
      priority: "critical",
      description: `Efficiency of ${eff}% is below critical threshold of ${threshold}% for ${panelType} panels. Immediate replacement recommended.`,
      estimated_cost: 15000,
      urgency_hours: 48,
    });
  }

  if (prediction.severity === "high" || health === "poor") {
    actions.push({
      type: "repair",
      priority: "high",
      description: `Degradation trend indicates efficiency will reach ${threshold}% in ~${prediction.estimated_days_to_threshold} days. Schedule repair and detailed inspection.`,
      estimated_cost: 5000,
      urgency_hours: Math.max(24, Math.min(prediction.estimated_hours_to_threshold * 0.5, 2160)),
    });

    if (!actions.some((a) => a.type === "cleaning")) {
      actions.push({
        type: "cleaning",
        priority: "medium",
        description: "Routine cleaning to maximize light absorption and slow degradation.",
        estimated_cost: 800,
        urgency_hours: 720,
      });
    }
  }

  if (prediction.severity === "medium") {
    actions.push({
      type: "inspection",
      priority: "medium",
      description: `Moderate degradation detected. Efficiency trending at ${eff}% (threshold: ${threshold}%). Perform detailed inspection.`,
      estimated_cost: 1500,
      urgency_hours: Math.min(prediction.estimated_hours_to_threshold * 0.3, 4320),
    });

    actions.push({
      type: "wiring_check",
      priority: "low",
      description: "Check wiring and connections for corrosion or damage as part of preventive maintenance.",
      estimated_cost: 600,
      urgency_hours: 2160,
    });
  }

  if (prediction.severity === "low" || prediction.severity === "none") {
    if (prediction.estimated_hours_to_threshold > 0 && Number.isFinite(prediction.estimated_hours_to_threshold)) {
      actions.push({
        type: "inspection",
        priority: "low",
        description: `Routine inspection. Efficiency at ${eff}%, threshold at ${threshold}%. Next check recommended within ${Math.round(prediction.estimated_hours_to_threshold / 2 / 24)} days.`,
        estimated_cost: 1000,
        urgency_hours: Math.min(prediction.estimated_hours_to_threshold * 0.5, 8760),
      });
    }

    if (!actions.some((a) => a.type === "cleaning")) {
      actions.push({
        type: "cleaning",
        priority: "low",
        description: "Scheduled routine cleaning to maintain optimal efficiency.",
        estimated_cost: 500,
        urgency_hours: 2160,
      });
    }
  }

  actions.push({
    type: "inverter_service",
    priority: "low",
    description: "Routine inverter performance check and cooling system service.",
    estimated_cost: 1200,
    urgency_hours: 4320,
  });

  if (health !== "good") {
    actions.push({
      type: "structural_check",
      priority: health === "critical" ? "high" : "low",
      description: "Inspect mounting structures, racking, and tracking systems for stability and corrosion.",
      estimated_cost: 2000,
      urgency_hours: health === "critical" ? 168 : 4320,
    });
  }

  const maxPriority = actions.reduce((max, a) => {
    const order = { critical: 4, high: 3, medium: 2, low: 1 };
    return order[a.priority] > order[max] ? a.priority : max;
  }, "low" as MaintenanceAction["priority"]);

  const summary = health === "critical"
    ? `CRITICAL: Project ${projectId} requires immediate maintenance. Efficiency at ${eff}% (below ${threshold}% threshold for ${panelType}).`
    : health === "poor"
    ? `WARNING: Project ${projectId} shows significant degradation. Schedule maintenance within ${prediction.estimated_days_to_threshold} days.`
    : health === "fair"
    ? `ATTENTION: Project ${projectId} efficiency (${eff}%) approaching threshold (${threshold}%). Preventive maintenance recommended.`
    : `OK: Project ${projectId} is operating efficiently at ${eff}% (threshold: ${threshold}%). Routine maintenance only.`;

  return {
    project_id: projectId,
    panel_type: panelType,
    current_efficiency: eff,
    efficiency_rating: efficiencyRating,
    shading_factor: shadingFactor,
    overall_health: health,
    actions: actions.sort((a, b) => {
      const order = { critical: 0, high: 1, medium: 2, low: 3 };
      return order[a.priority] - order[b.priority];
    }),
    summary,
  };
}

export function generateSchedule(projectId: number, historyHours = 720): MaintenanceSchedule {
  const recommendation = recommendMaintenance(projectId, historyHours);
  const now = Date.now();
  const schedule: ScheduleEntry[] = [];

  for (const action of recommendation.actions) {
    const date = new Date(now + action.urgency_hours * 3_600_000);
    const existing = schedule.find((s) => s.date === date.toISOString().split("T")[0]);
    if (existing) {
      existing.actions.push(action);
      const order = { critical: 0, high: 1, medium: 2, low: 3 };
      if (order[action.priority] < order[existing.priority]) {
        existing.priority = action.priority;
      }
    } else {
      schedule.push({
        date: date.toISOString().split("T")[0],
        actions: [action],
        priority: action.priority,
      });
    }
  }

  schedule.sort((a, b) => a.date.localeCompare(b.date));

  return {
    project_id: projectId,
    generated_at: new Date().toISOString(),
    schedule,
  };
}

export function generateFullReport(projectId: number, historyHours = 720): FullMaintenanceReport {
  return {
    project_id: projectId,
    generated_at: new Date().toISOString(),
    trend_analysis: analyzeEfficiencyTrend(projectId, historyHours),
    failure_prediction: predictFailure(projectId, historyHours),
    recommendation: recommendMaintenance(projectId, historyHours),
    schedule: generateSchedule(projectId, historyHours),
  };
}

export function recommendationToCsv(recommendation: MaintenanceRecommendation): string {
  const header = "project_id,panel_type,current_efficiency,efficiency_rating,shading_factor,overall_health,action_type,priority,description,estimated_cost,urgency_hours,summary";
  const rows = recommendation.actions.map((a) =>
    `${recommendation.project_id},${recommendation.panel_type},${recommendation.current_efficiency},${recommendation.efficiency_rating},${recommendation.shading_factor},${recommendation.overall_health},${a.type},${a.priority},"${a.description}",${a.estimated_cost},${a.urgency_hours},"${recommendation.summary}"`,
  );
  return [header, ...rows].join("\n") + "\n";
}

export function scheduleToCsv(schedule: MaintenanceSchedule): string {
  const header = "project_id,date,priority,action_type,description,estimated_cost,urgency_hours";
  const rows: string[] = [];
  for (const entry of schedule.schedule) {
    for (const action of entry.actions) {
      rows.push(
        `${schedule.project_id},${entry.date},${entry.priority},${action.type},"${action.description}",${action.estimated_cost},${action.urgency_hours}`,
      );
    }
  }
  return [header, ...rows].join("\n") + "\n";
}
