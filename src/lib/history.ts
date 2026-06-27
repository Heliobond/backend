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

export function recordScoreHistory(
  projectId: number,
  creditQuality: number,
  greenImpact: number,
  timestamp = Date.now(),
): void {
  if (!store.has(projectId)) store.set(projectId, []);
  store.get(projectId)!.push({ project_id: projectId, credit_quality: creditQuality, green_impact: greenImpact, timestamp });
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

export function computeTrend(entries: ScoreEntry[]): TrendAnalysis {
  if (entries.length < 2) {
    return { trend: "stable", credit_quality_delta: 0, green_impact_delta: 0, sample_count: entries.length };
  }
  const sorted = [...entries].sort((a, b) => a.timestamp - b.timestamp);
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  const cqDelta = last.credit_quality - first.credit_quality;
  const giDelta = last.green_impact - first.green_impact;
  const netDelta = cqDelta + giDelta;
  const trend: Trend = netDelta > 2 ? "improving" : netDelta < -2 ? "declining" : "stable";
  return { trend, credit_quality_delta: cqDelta, green_impact_delta: giDelta, sample_count: entries.length };
}

export function entriesToCsv(entries: ScoreEntry[]): string {
  const header = "project_id,credit_quality,green_impact,timestamp";
  const rows = entries.map((e) =>
    `${e.project_id},${e.credit_quality},${e.green_impact},${new Date(e.timestamp).toISOString()}`,
  );
  return [header, ...rows].join("\n") + "\n";
}
