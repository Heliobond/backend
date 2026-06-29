import { computeScores } from "../lib/scoring";

describe("computeScores", () => {
  it("perfect data → 100/100", () => {
    const scores = computeScores({
      solar: { efficiency_pct: 100, power_output_kw: 1000, max_power_kw: 1000 },
      satellite: { forest_density_pct: 100, ndvi_score: 1.0 },
    });
    expect(scores.credit_quality).toBe(100);
    expect(scores.green_impact).toBe(100);
  });

  it("zero data → 0/0", () => {
    const scores = computeScores({
      solar: { efficiency_pct: 0, power_output_kw: 0, max_power_kw: 1000 },
      satellite: { forest_density_pct: 0, ndvi_score: 0 },
    });
    expect(scores.credit_quality).toBe(0);
    expect(scores.green_impact).toBe(0);
  });

  it("clamps out-of-range inputs to 0–100", () => {
    const scores = computeScores({
      solar: { efficiency_pct: 150, power_output_kw: 2000, max_power_kw: 1000 },
      satellite: { forest_density_pct: 120, ndvi_score: 1.5 },
    });
    expect(scores.credit_quality).toBeLessThanOrEqual(100);
    expect(scores.green_impact).toBeLessThanOrEqual(100);
  });

  it("blended green_impact formula: (power/max)*50 + (forest/100)*50", () => {
    // (800/1000)*50 + (60/100)*50 = 40 + 30 = 70
    const scores = computeScores({
      solar: { efficiency_pct: 80, power_output_kw: 800, max_power_kw: 1000 },
      satellite: { forest_density_pct: 60, ndvi_score: 0.6 },
    });
    expect(scores.green_impact).toBe(70);
    expect(scores.credit_quality).toBe(80);
  });
});
