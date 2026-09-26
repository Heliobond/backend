import {
  validateWeights,
  createFormula,
  listFormulas,
  computeScoresWithFormula,
  deleteFormula,
  getFormula,
  setActiveFormula,
  getActiveFormula,
} from "../lib/scoring-formula";
import type { IotInput } from "../lib/scoring";

const defaultInput: IotInput = {
  solar: { efficiency_pct: 50, power_output_kw: 500, max_power_kw: 1000 },
  satellite: { forest_density_pct: 60, ndvi_score: 0.6 },
};

describe("scoring-formula", () => {
  beforeEach(() => {
    // Clean up formulas created in tests
    const formulas = listFormulas();
    for (const f of formulas) {
      deleteFormula(f.id);
    }
  });

  describe("validateWeights", () => {
    test("accepts valid weights and rejects out-of-range values", () => {
      expect(validateWeights({ efficiency_weight: 1 }).valid).toBe(true);
      const bad = validateWeights({ power_weight: 99 });
      expect(bad.valid).toBe(false);
      expect(bad.errors.join(" ")).toContain("power_weight");
    });

    test("rejects negative weights", () => {
      const result = validateWeights({ power_weight: -1 });
      expect(result.valid).toBe(false);
      expect(result.errors).toContain("power_weight must be between 0 and 10");
    });

    test("allows zero weights", () => {
      const result = validateWeights({ ndvi_weight: 0 });
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    test("rejects NaN weights", () => {
      const result = validateWeights({ forest_weight: NaN });
      expect(result.valid).toBe(false);
      expect(result.errors).toContain("forest_weight must be a number");
    });
  });

  describe("createFormula", () => {
    test("creates and stores a formula that listFormulas returns", () => {
      const created = createFormula("aggressive", "Aggressive", { efficiency_weight: 2 });
      expect(created.valid).toBe(true);
      expect(created.formula?.id).toBe("aggressive");
      expect(listFormulas().some((f) => f.id === "aggressive")).toBe(true);
    });

    test("returns validation errors for invalid weights", () => {
      const result = createFormula("invalid", "Invalid", { power_weight: -5 });
      expect(result.valid).toBe(false);
      expect(result.errors).toContain("power_weight must be between 0 and 10");
      expect(result.formula).toBeUndefined();
    });

    test("fills missing weights with defaults", () => {
      const created = createFormula("partial", "Partial", { power_weight: 2.0 });
      expect(created.formula?.weights.power_weight).toBe(2.0);
      expect(created.formula?.weights.efficiency_weight).toBeDefined();
    });
  });

  describe("computeScoresWithFormula", () => {
    test("returns numeric scores with default weights", () => {
      const scores = computeScoresWithFormula(defaultInput);
      expect(typeof scores.credit_quality).toBe("number");
      expect(typeof scores.green_impact).toBe("number");
      expect(scores.credit_quality).toBeGreaterThanOrEqual(0);
      expect(scores.green_impact).toBeGreaterThanOrEqual(0);
    });

    test("scores are always finite (never NaN or Infinity)", () => {
      const scores = computeScoresWithFormula(defaultInput);
      expect(Number.isFinite(scores.credit_quality)).toBe(true);
      expect(Number.isFinite(scores.green_impact)).toBe(true);
    });

    test("scores are clamped to 0–100", () => {
      const scores = computeScoresWithFormula(defaultInput);
      expect(scores.credit_quality).toBeGreaterThanOrEqual(0);
      expect(scores.credit_quality).toBeLessThanOrEqual(100);
      expect(scores.green_impact).toBeGreaterThanOrEqual(0);
      expect(scores.green_impact).toBeLessThanOrEqual(100);
    });

    test("scores are integers", () => {
      const scores = computeScoresWithFormula(defaultInput);
      expect(Number.isInteger(scores.credit_quality)).toBe(true);
      expect(Number.isInteger(scores.green_impact)).toBe(true);
    });

    test("perfect data → 100/100", () => {
      const input: IotInput = {
        solar: { efficiency_pct: 100, power_output_kw: 1000, max_power_kw: 1000 },
        satellite: { forest_density_pct: 100, ndvi_score: 1.0 },
      };
      const scores = computeScoresWithFormula(input);
      expect(scores.credit_quality).toBe(100);
      expect(scores.green_impact).toBe(100);
    });

    test("zero data → 0/0", () => {
      const input: IotInput = {
        solar: { efficiency_pct: 0, power_output_kw: 0, max_power_kw: 1000 },
        satellite: { forest_density_pct: 0, ndvi_score: 0 },
      };
      const scores = computeScoresWithFormula(input);
      expect(scores.credit_quality).toBe(0);
      expect(scores.green_impact).toBe(0);
    });

    describe("CRITICAL: zero-guard for max_power_kw (division by zero protection)", () => {
      test("zero max_power_kw with zero power_output_kw (idle/misconfigured panel) does NOT produce NaN", () => {
        // This is the critical bug case: 0 / 0 = NaN
        const input: IotInput = {
          solar: {
            efficiency_pct: 50,
            power_output_kw: 0,
            max_power_kw: 0,
          },
          satellite: {
            forest_density_pct: 50,
            ndvi_score: 0.5,
          },
        };
        const scores = computeScoresWithFormula(input);
        expect(isNaN(scores.credit_quality)).toBe(false);
        expect(isNaN(scores.green_impact)).toBe(false);
        expect(Number.isFinite(scores.credit_quality)).toBe(true);
        expect(Number.isFinite(scores.green_impact)).toBe(true);
      });

      test("zero max_power_kw with nonzero power_output_kw (impossible state, but safe) does NOT produce NaN", () => {
        const input: IotInput = {
          solar: {
            efficiency_pct: 75,
            power_output_kw: 500, // Impossible when max_power_kw = 0
            max_power_kw: 0,
          },
          satellite: {
            forest_density_pct: 40,
            ndvi_score: 0.4,
          },
        };
        const scores = computeScoresWithFormula(input);
        expect(Number.isFinite(scores.credit_quality)).toBe(true);
        expect(Number.isFinite(scores.green_impact)).toBe(true);
      });

      test("zero max_power_kw with custom formula weights still prevents NaN", () => {
        const { formula } = createFormula("zero-guard", "Zero Guard Test", {
          efficiency_weight: 1.0,
          power_weight: 2.0, // Heavy power weight
          forest_weight: 0.5,
          ndvi_weight: 0.5,
        });
        const input: IotInput = {
          solar: {
            efficiency_pct: 60,
            power_output_kw: 0,
            max_power_kw: 0,
          },
          satellite: {
            forest_density_pct: 50,
            ndvi_score: 0.5,
          },
        };
        const scores = computeScoresWithFormula(input, formula);
        expect(isNaN(scores.credit_quality)).toBe(false);
        expect(isNaN(scores.green_impact)).toBe(false);
        expect(Number.isFinite(scores.credit_quality)).toBe(true);
        expect(Number.isFinite(scores.green_impact)).toBe(true);
      });

      test("endpoint preview path: zero max_power_kw does NOT produce NaN in delta", () => {
        // Simulates: GET /v1/scoring/formulas/:id/preview/:projectId
        // The response should never have NaN in scores.withFormula/delta fields
        const { formula } = createFormula("preview", "Preview", {
          efficiency_weight: 1.0,
          power_weight: 1.5,
          forest_weight: 0.5,
          ndvi_weight: 0.5,
        });

        const input: IotInput = {
          solar: {
            efficiency_pct: 20,
            power_output_kw: 0,
            max_power_kw: 0,
          },
          satellite: {
            forest_density_pct: 25,
            ndvi_score: 0.25,
          },
        };

        const withFormula = computeScoresWithFormula(input, formula);
        const withDefault = computeScoresWithFormula(input);

        // Both results must have valid numbers
        expect(Number.isFinite(withFormula.credit_quality)).toBe(true);
        expect(Number.isFinite(withFormula.green_impact)).toBe(true);
        expect(Number.isFinite(withDefault.credit_quality)).toBe(true);
        expect(Number.isFinite(withDefault.green_impact)).toBe(true);

        // Delta calculation must also be safe
        const delta = {
          credit_quality: withFormula.credit_quality - withDefault.credit_quality,
          green_impact: withFormula.green_impact - withDefault.green_impact,
        };
        expect(Number.isFinite(delta.credit_quality)).toBe(true);
        expect(Number.isFinite(delta.green_impact)).toBe(true);
      });
    });

    describe("edge cases and overflow safety", () => {
      test("negative values do not crash", () => {
        const input: IotInput = {
          solar: {
            efficiency_pct: -50,
            power_output_kw: -100,
            max_power_kw: 1000,
          },
          satellite: {
            forest_density_pct: -30,
            ndvi_score: -0.5,
          },
        };
        const scores = computeScoresWithFormula(input);
        expect(Number.isFinite(scores.credit_quality)).toBe(true);
        expect(Number.isFinite(scores.green_impact)).toBe(true);
      });

      test("very large numbers do not overflow", () => {
        const input: IotInput = {
          solar: {
            efficiency_pct: 1e15,
            power_output_kw: 1e15,
            max_power_kw: 1,
          },
          satellite: {
            forest_density_pct: 1e15,
            ndvi_score: 1e15,
          },
        };
        const scores = computeScoresWithFormula(input);
        expect(scores.credit_quality).toBeLessThanOrEqual(100);
        expect(scores.green_impact).toBeLessThanOrEqual(100);
      });

      test("power_output > max_power (over-production)", () => {
        const input: IotInput = {
          solar: {
            efficiency_pct: 80,
            power_output_kw: 1500,
            max_power_kw: 1000,
          },
          satellite: {
            forest_density_pct: 50,
            ndvi_score: 0.5,
          },
        };
        const scores = computeScoresWithFormula(input);
        expect(Number.isFinite(scores.credit_quality)).toBe(true);
        expect(Number.isFinite(scores.green_impact)).toBe(true);
      });
    });

    describe("formula weight application", () => {
      test("all weight on efficiency", () => {
        const { formula } = createFormula("eff-only", "Efficiency Only", {
          efficiency_weight: 10.0,
          power_weight: 0,
          forest_weight: 0,
          ndvi_weight: 0,
        });
        const input: IotInput = {
          solar: { efficiency_pct: 75, power_output_kw: 0, max_power_kw: 1 },
          satellite: { forest_density_pct: 0, ndvi_score: 0 },
        };
        const scores = computeScoresWithFormula(input, formula);
        expect(scores.credit_quality).toBe(75);
      });

      test("all weight on power", () => {
        const { formula } = createFormula("power-only", "Power Only", {
          efficiency_weight: 0,
          power_weight: 10.0,
          forest_weight: 0,
          ndvi_weight: 0,
        });
        const input: IotInput = {
          solar: {
            efficiency_pct: 0,
            power_output_kw: 800,
            max_power_kw: 1000,
          },
          satellite: { forest_density_pct: 0, ndvi_score: 0 },
        };
        const scores = computeScoresWithFormula(input, formula);
        // power_ratio = 0.8; 0.8 * 100 * 10 / 10 = 80
        expect(scores.credit_quality).toBe(80);
      });

      test("zero weights (denominator safety check)", () => {
        const { formula } = createFormula("zero-weights", "All Zero Weights", {
          efficiency_weight: 0,
          power_weight: 0,
          forest_weight: 0,
          ndvi_weight: 0,
        });
        const scores = computeScoresWithFormula(defaultInput, formula);
        expect(Number.isFinite(scores.credit_quality)).toBe(true);
        expect(Number.isFinite(scores.green_impact)).toBe(true);
      });
    });
  });

  describe("formula store management", () => {
    test("getFormula retrieves by id", () => {
      createFormula("get-test", "Get Test", { power_weight: 2.0 });
      const formula = getFormula("get-test");
      expect(formula?.name).toBe("Get Test");
      expect(formula?.weights.power_weight).toBe(2.0);
    });

    test("getFormula returns undefined for missing id", () => {
      expect(getFormula("nonexistent")).toBeUndefined();
    });

    test("setActiveFormula succeeds for existing formula", () => {
      createFormula("active-test", "Active", {});
      const result = setActiveFormula("active-test");
      expect(result).toBe(true);
      expect(getActiveFormula()?.id).toBe("active-test");
    });

    test("setActiveFormula fails for non-existent formula", () => {
      const result = setActiveFormula("missing");
      expect(result).toBe(false);
    });

    test("can switch active formula", () => {
      createFormula("switch-1", "First", {});
      createFormula("switch-2", "Second", {});
      setActiveFormula("switch-1");
      expect(getActiveFormula()?.id).toBe("switch-1");
      setActiveFormula("switch-2");
      expect(getActiveFormula()?.id).toBe("switch-2");
    });

    test("deleteFormula removes formula and clears active if needed", () => {
      createFormula("to-delete", "Delete Me", {});
      setActiveFormula("to-delete");
      expect(getActiveFormula()?.id).toBe("to-delete");
      const deleted = deleteFormula("to-delete");
      expect(deleted).toBe(true);
      expect(getFormula("to-delete")).toBeUndefined();
      expect(getActiveFormula()).toBeNull();
    });

    test("only one formula can be active at a time", () => {
      createFormula("f1", "F1", {});
      createFormula("f2", "F2", {});
      setActiveFormula("f1");
      expect(getFormula("f1")?.active).toBe(true);
      setActiveFormula("f2");
      expect(getFormula("f1")?.active).toBe(false);
      expect(getFormula("f2")?.active).toBe(true);
    });
  });
});
