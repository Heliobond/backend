import {
  computeScores,
  GREEN_IMPACT_FOREST_WEIGHT,
  GREEN_IMPACT_POWER_WEIGHT,
  PERCENT_MAX,
  SCORE_MAX,
  SCORE_MIN,
} from "../lib/scoring";

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

  it("zero max_power safely defaults to 0 ratio", () => {
    const scores = computeScores({
      solar: { efficiency_pct: 50, power_output_kw: 100, max_power_kw: 0 },
      satellite: { forest_density_pct: 50, ndvi_score: 0.5 },
    });
    // Division by zero avoided: ratio defaults to 0, forest component = 25
    expect(scores.green_impact).toBe(25);
  });

  it("NaN inputs handled gracefully with defaults", () => {
    const scores = computeScores({
      solar: { efficiency_pct: NaN, power_output_kw: 100, max_power_kw: 1000 },
      satellite: { forest_density_pct: 50, ndvi_score: 0.5 },
    });
    // NaN replaced with 0, clamped to 0
    expect(scores.credit_quality).toBe(0);
  });

  it("all NaN inputs → scores are 0, not NaN", () => {
    const scores = computeScores({
      solar: { efficiency_pct: NaN, power_output_kw: NaN, max_power_kw: NaN },
      satellite: { forest_density_pct: NaN, ndvi_score: NaN },
    });
    expect(scores.credit_quality).toBe(0);
    expect(scores.credit_quality).not.toBeNaN();
    expect(scores.green_impact).not.toBeNaN();
    expect(scores.green_impact).toBe(0);
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

  // ── Green impact formula edge cases ────────────────────────────────────

  describe("green_impact formula edge cases", () => {
    it("zero power_output_kw → green_impact based on forest only", () => {
      // (0/1000)*50 + (60/100)*50 = 0 + 30 = 30
      const scores = computeScores({
        solar: { efficiency_pct: 80, power_output_kw: 0, max_power_kw: 1000 },
        satellite: { forest_density_pct: 60, ndvi_score: 0.6 },
      });
      expect(scores.green_impact).toBe(30);
    });

    it("zero max_power_kw → handled gracefully (not NaN)", () => {
      // maxPower > 0 is false → powerRatio = 0 → (0)*50 + (50/100)*50 = 25
      const scores = computeScores({
        solar: { efficiency_pct: 50, power_output_kw: 100, max_power_kw: 0 },
        satellite: { forest_density_pct: 50, ndvi_score: 0.5 },
      });
      expect(scores.green_impact).toBe(25);
      expect(Number.isNaN(scores.green_impact)).toBe(false);
    });

    it("zero forest_density_pct → green_impact based on power only", () => {
      // (500/1000)*50 + (0/100)*50 = 25 + 0 = 25
      const scores = computeScores({
        solar: { efficiency_pct: 50, power_output_kw: 500, max_power_kw: 1000 },
        satellite: { forest_density_pct: 0, ndvi_score: 0 },
      });
      expect(scores.green_impact).toBe(25);
    });

    it("both power_output_kw and forest_density_pct zero → green_impact = 0", () => {
      // (0/1000)*50 + (0/100)*50 = 0
      const scores = computeScores({
        solar: { efficiency_pct: 50, power_output_kw: 0, max_power_kw: 1000 },
        satellite: { forest_density_pct: 0, ndvi_score: 0 },
      });
      expect(scores.green_impact).toBe(0);
    });
  });

  // ── Rounding behavior ──────────────────────────────────────────────────

  describe("Math.round() rounding behavior at .5 boundaries", () => {
    /**
     * JavaScript's Math.round rounds .5 up (away from zero).
     * For green_impact, Math.round(value) is used where value is a number
     * computed from powerRatio * 50 + (forestDensity / 100) * 50.
     * This means 70.5 → 71, 70.4 → 70, 70.6 → 71.
     */

    it("value at exactly .5 boundary rounds up (e.g. 70.5 → 71)", () => {
      // Solve for inputs that give 70.5 before rounding:
      // (powerRatio)*50 + (forestDensity/100)*50 = 70.5
      // Using powerRatio = 0.5 (500/1000) → 25 from power
      // Need 45.5 from forest → forestDensity = 91
      // 25 + 45.5 = 70.5 → Math.round(70.5) = 71
      const scores = computeScores({
        solar: { efficiency_pct: 50, power_output_kw: 500, max_power_kw: 1000 },
        satellite: { forest_density_pct: 91, ndvi_score: 0.91 },
      });
      expect(scores.green_impact).toBe(71);
    });

    it("value below .5 rounds down (e.g. 70.4 → 70)", () => {
      // (500/1000)*50 + (40.8/100)*50 = 25 + 20.4 = 45.4 → Math.round(45.4) = 45
      const scores = computeScores({
        solar: { efficiency_pct: 50, power_output_kw: 500, max_power_kw: 1000 },
        satellite: { forest_density_pct: 40.8, ndvi_score: 0.408 },
      });
      expect(scores.green_impact).toBe(45);
    });

    it("value above .5 rounds up (e.g. 70.6 → 71)", () => {
      // (500/1000)*50 + (41.2/100)*50 = 25 + 20.6 = 45.6 → Math.round(45.6) = 46
      const scores = computeScores({
        solar: { efficiency_pct: 50, power_output_kw: 500, max_power_kw: 1000 },
        satellite: { forest_density_pct: 41.2, ndvi_score: 0.412 },
      });
      expect(scores.green_impact).toBe(46);
    });
  });

  // ── Named constants ────────────────────────────────────────────────────

  describe("scoring constants", () => {
    it("green_impact weights sum to SCORE_MAX", () => {
      expect(GREEN_IMPACT_POWER_WEIGHT + GREEN_IMPACT_FOREST_WEIGHT).toBe(SCORE_MAX);
    });

    it("formula matches the named constants", () => {
      const power_output_kw = 800;
      const max_power_kw = 1000;
      const forest_density_pct = 60;
      const expected = Math.round(
        (power_output_kw / max_power_kw) * GREEN_IMPACT_POWER_WEIGHT +
          (forest_density_pct / PERCENT_MAX) * GREEN_IMPACT_FOREST_WEIGHT,
      );
      const scores = computeScores({
        solar: { efficiency_pct: 80, power_output_kw, max_power_kw },
        satellite: { forest_density_pct, ndvi_score: 0.6 },
      });
      expect(scores.green_impact).toBe(expected);
      expect(scores.green_impact).toBeGreaterThanOrEqual(SCORE_MIN);
      expect(scores.green_impact).toBeLessThanOrEqual(SCORE_MAX);
    });
  });

  // ── Timestamps ─────────────────────────────────────────────────────────

  describe("reading timestamps", () => {
    it("accepts timestamps on solar and satellite readings", () => {
      const scores = computeScores({
        solar: {
          efficiency_pct: 80,
          power_output_kw: 800,
          max_power_kw: 1000,
          timestamp: 1_700_000_000_000,
        },
        satellite: { forest_density_pct: 60, ndvi_score: 0.6, timestamp: 1_700_000_000_000 },
      });
      expect(scores.credit_quality).toBe(80);
      expect(scores.green_impact).toBe(70);
    });

    it("ignores timestamps: stale and fresh readings score identically", () => {
      const solar = { efficiency_pct: 80, power_output_kw: 800, max_power_kw: 1000 };
      const satellite = { forest_density_pct: 60, ndvi_score: 0.6 };
      const stale = computeScores({
        solar: { ...solar, timestamp: 0 },
        satellite: { ...satellite, timestamp: 0 },
      });
      const fresh = computeScores({
        solar: { ...solar, timestamp: 1_900_000_000_000 },
        satellite: { ...satellite, timestamp: 1_900_000_000_000 },
      });
      expect(stale).toEqual(fresh);
    });

    it("timestamps remain optional (existing callers unaffected)", () => {
      const scores = computeScores({
        solar: { efficiency_pct: 80, power_output_kw: 800, max_power_kw: 1000 },
        satellite: { forest_density_pct: 60, ndvi_score: 0.6 },
      });
      expect(scores.green_impact).toBe(70);
    });
  });
});
