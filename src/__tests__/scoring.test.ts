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

  // ── Edge cases ─────────────────────────────────────────────────────────

  it("negative efficiency clamped to 0", () => {
    const scores = computeScores({
      solar: { efficiency_pct: -50, power_output_kw: 100, max_power_kw: 1000 },
      satellite: { forest_density_pct: 50, ndvi_score: 0.5 },
    });
    expect(scores.credit_quality).toBe(0);
  });

  it("negative forest_density clamped to 0", () => {
    const scores = computeScores({
      solar: { efficiency_pct: 50, power_output_kw: 500, max_power_kw: 1000 },
      satellite: { forest_density_pct: -30, ndvi_score: 0.5 },
    });
    expect(scores.green_impact).toBe(25); // (500/1000)*50 + (0/100)*50 = 25
  });

  it("efficiency > 100 clamped to 100", () => {
    const scores = computeScores({
      solar: { efficiency_pct: 999, power_output_kw: 500, max_power_kw: 1000 },
      satellite: { forest_density_pct: 50, ndvi_score: 0.5 },
    });
    expect(scores.credit_quality).toBe(100);
  });

  it("forest_density > 100 clamped to 100", () => {
    const scores = computeScores({
      solar: { efficiency_pct: 50, power_output_kw: 500, max_power_kw: 1000 },
      satellite: { forest_density_pct: 200, ndvi_score: 2.0 },
    });
    expect(scores.green_impact).toBe(75); // (500/1000)*50 + (100/100)*50 = 75
  });

  it("power_output > max_power produces > 50 green_impact component", () => {
    const scores = computeScores({
      solar: { efficiency_pct: 50, power_output_kw: 1500, max_power_kw: 1000 },
      satellite: { forest_density_pct: 0, ndvi_score: 0 },
    });
    // (1500/1000)*50 + 0 = 75, clamped to 100
    expect(scores.green_impact).toBe(75);
  });

  it("very large numbers do not overflow", () => {
    const scores = computeScores({
      solar: { efficiency_pct: 1e15, power_output_kw: 1e15, max_power_kw: 1 },
      satellite: { forest_density_pct: 1e15, ndvi_score: 1e15 },
    });
    expect(scores.credit_quality).toBe(100);
    expect(scores.green_impact).toBe(100);
  });

  it("zero max_power produces Infinity then clamps", () => {
    const scores = computeScores({
      solar: { efficiency_pct: 50, power_output_kw: 100, max_power_kw: 0 },
      satellite: { forest_density_pct: 50, ndvi_score: 0.5 },
    });
    // (100/0) = Infinity → Infinity*50 = Infinity, clamped to 100
    expect(scores.green_impact).toBe(100);
  });

  it("NaN inputs propagate as NaN (caller responsibility)", () => {
    const scores = computeScores({
      solar: { efficiency_pct: NaN, power_output_kw: 100, max_power_kw: 1000 },
      satellite: { forest_density_pct: 50, ndvi_score: 0.5 },
    });
    // NaN comparisons return false, so clamp returns NaN
    expect(scores.credit_quality).toBeNaN();
  });

  it("mid-range values round correctly", () => {
    // (333/1000)*50 + (33/100)*50 = 16.65 + 16.5 = 33.15 → rounds to 33
    const scores = computeScores({
      solar: { efficiency_pct: 33.6, power_output_kw: 333, max_power_kw: 1000 },
      satellite: { forest_density_pct: 33, ndvi_score: 0.33 },
    });
    expect(scores.credit_quality).toBe(34);
    expect(scores.green_impact).toBe(33);
  });
});
