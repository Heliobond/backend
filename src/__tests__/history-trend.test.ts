import { computeTrend, ScoreEntry } from "../lib/history";

function series(points: Array<[number, number]>): ScoreEntry[] {
  return points.map(([creditQuality, greenImpact], index) => ({
    project_id: 1,
    credit_quality: creditQuality,
    green_impact: greenImpact,
    timestamp: 1_000_000 + index * 60_000,
  }));
}

describe("computeTrend", () => {
  it("reports a monotonic rise as improving", () => {
    const trend = computeTrend(
      series([
        [50, 50],
        [60, 60],
        [70, 70],
      ]),
    );

    expect(trend.trend).toBe("improving");
    expect(trend.credit_quality_delta).toBe(20);
    expect(trend.green_impact_delta).toBe(20);
    expect(trend.sample_count).toBe(3);
  });

  it("reports a monotonic fall as declining", () => {
    const trend = computeTrend(
      series([
        [80, 80],
        [70, 70],
        [60, 60],
      ]),
    );

    expect(trend.trend).toBe("declining");
    expect(trend.credit_quality_delta).toBe(-20);
    expect(trend.green_impact_delta).toBe(-20);
  });

  it("does not report a rise-then-collapse series as stable", () => {
    const trend = computeTrend(
      series([
        [50, 50],
        [80, 80],
        [50, 50],
      ]),
    );

    expect(trend.trend).not.toBe("stable");
    expect(trend.trend).toBe("declining");
    // Endpoint deltas remain zero, which is exactly why endpoint-only
    // classification used to hide the reversal.
    expect(trend.credit_quality_delta).toBe(0);
    expect(trend.green_impact_delta).toBe(0);
  });

  it("does not report a fall-then-recover series as stable", () => {
    const trend = computeTrend(
      series([
        [80, 80],
        [50, 50],
        [80, 80],
      ]),
    );

    expect(trend.trend).not.toBe("stable");
    expect(trend.trend).toBe("improving");
  });

  it("treats large oscillations as volatile rather than stable", () => {
    const trend = computeTrend(
      series([
        [50, 50],
        [60, 60],
        [50, 50],
        [60, 60],
        [50, 50],
      ]),
    );

    expect(trend.trend).not.toBe("stable");
  });

  it("keeps small noise around a flat line stable", () => {
    const trend = computeTrend(
      series([
        [50, 50],
        [51, 50],
        [50, 50],
      ]),
    );

    expect(trend.trend).toBe("stable");
  });

  it("returns stable with zero deltas for fewer than two samples", () => {
    expect(computeTrend([])).toEqual({
      trend: "stable",
      credit_quality_delta: 0,
      green_impact_delta: 0,
      sample_count: 0,
    });
    expect(computeTrend(series([[50, 50]]))).toMatchObject({
      trend: "stable",
      sample_count: 1,
    });
  });

  it("orders samples by timestamp before fitting", () => {
    const entries = series([
      [50, 50],
      [60, 60],
      [70, 70],
    ]).reverse();

    const trend = computeTrend(entries);

    expect(trend.trend).toBe("improving");
    expect(trend.credit_quality_delta).toBe(20);
  });
});
