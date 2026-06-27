import {
  portfolioSummary,
  rankPerformers,
  scoreDistribution,
  projectTimeSeries,
  summaryToCsv,
  ProjectScore,
} from "../lib/analytics";
import { recordScoreHistory } from "../lib/history";

const scores: ProjectScore[] = [
  { id: 1, credit_quality: 90, green_impact: 80, power_output_kw: 500 },
  { id: 2, credit_quality: 40, green_impact: 30, power_output_kw: 200 },
  { id: 3, credit_quality: 70, green_impact: 75, power_output_kw: 400 },
];

describe("dashboard analytics", () => {
  it("portfolioSummary aggregates averages and extremes", () => {
    const summary = portfolioSummary(scores);
    expect(summary.total_projects).toBe(3);
    expect(summary.avg_credit_quality).toBeCloseTo((90 + 40 + 70) / 3, 2);
    expect(summary.total_power_output_kw).toBe(1100);
    expect(summary.highest_score_project).toBe(1);
    expect(summary.lowest_score_project).toBe(2);
  });

  it("portfolioSummary handles an empty portfolio", () => {
    const summary = portfolioSummary([]);
    expect(summary.total_projects).toBe(0);
    expect(summary.highest_score_project).toBeNull();
  });

  it("rankPerformers returns top and bottom by combined score", () => {
    const { top, bottom } = rankPerformers(scores, 1);
    expect(top[0].id).toBe(1);
    expect(bottom[0].id).toBe(2);
  });

  it("scoreDistribution buckets a field across 0-100", () => {
    const buckets = scoreDistribution(scores, "credit_quality", 10);
    expect(buckets).toHaveLength(10);
    const total = buckets.reduce((acc, b) => acc + b.count, 0);
    expect(total).toBe(3);
    expect(buckets.find((b) => b.range === "90-100")?.count).toBe(1);
  });

  it("projectTimeSeries returns recorded history oldest-first", () => {
    recordScoreHistory(4242, 50, 60, 2000);
    recordScoreHistory(4242, 55, 65, 1000);
    const points = projectTimeSeries(4242);
    expect(points.map((p) => p.timestamp)).toEqual([1000, 2000]);
  });

  it("summaryToCsv produces a header and one row per project", () => {
    const csv = summaryToCsv(scores);
    const lines = csv.trim().split("\n");
    expect(lines[0]).toContain("project_id");
    expect(lines).toHaveLength(4);
  });
});
