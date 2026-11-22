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

  it("rankPerformers never overlaps when n exceeds half the projects", () => {
    // 8 projects with the default n=5 would previously share ranks 4-5 in both
    // lists. n is capped at floor(8/2)=4 so top and bottom stay disjoint.
    const many = Array.from({ length: 8 }, (_, i) => ({
      id: i + 1,
      credit_quality: 100 - i * 10,
      green_impact: 100 - i * 10,
      power_output_kw: 100,
    }));
    const { top, bottom } = rankPerformers(many, 5);
    expect(top).toHaveLength(4);
    expect(bottom).toHaveLength(4);
    const topIds = new Set(top.map((p) => p.id));
    for (const b of bottom) {
      expect(topIds.has(b.id)).toBe(false);
    }
    // Together the two lists cover every distinct project exactly once.
    expect(new Set([...top, ...bottom].map((p) => p.id)).size).toBe(8);
  });

  it("rankPerformers returns disjoint lists for a small portfolio", () => {
    // 3 projects with n=2 -> capped to floor(3/2)=1; the middle project is
    // excluded from both lists.
    const { top, bottom } = rankPerformers(scores, 2);
    expect(top).toHaveLength(1);
    expect(bottom).toHaveLength(1);
    expect(top[0].id).not.toBe(bottom[0].id);
  });

  it("rankPerformers handles one or zero projects without overlap", () => {
    const one = [scores[0]];
    const empty = rankPerformers([], 5);
    expect(empty.top).toHaveLength(0);
    expect(empty.bottom).toHaveLength(0);
    const single = rankPerformers(one, 5);
    expect(single.top).toHaveLength(0);
    expect(single.bottom).toHaveLength(0);
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
