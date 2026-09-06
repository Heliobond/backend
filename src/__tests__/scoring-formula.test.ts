import {
  validateWeights,
  createFormula,
  listFormulas,
  computeScoresWithFormula,
} from "../lib/scoring-formula";

const input = {
  solar: { efficiency_pct: 50, power_output_kw: 500, max_power_kw: 1000 },
  satellite: { forest_density_pct: 60, ndvi_score: 0.6 },
};

test("validateWeights accepts valid weights and rejects out-of-range values", () => {
  expect(validateWeights({ efficiency_weight: 1 }).valid).toBe(true);
  const bad = validateWeights({ power_weight: 99 });
  expect(bad.valid).toBe(false);
  expect(bad.errors.join(" ")).toContain("power_weight");
});

test("createFormula stores a formula that listFormulas returns", () => {
  const created = createFormula("aggressive", "Aggressive", { efficiency_weight: 2 });
  expect(created.valid).toBe(true);
  expect(created.formula?.id).toBe("aggressive");
  expect(listFormulas().some((f) => f.id === "aggressive")).toBe(true);
});

test("computeScoresWithFormula returns numeric scores", () => {
  const scores = computeScoresWithFormula(input);
  expect(typeof scores.credit_quality).toBe("number");
  expect(typeof scores.green_impact).toBe("number");
  expect(scores.credit_quality).toBeGreaterThanOrEqual(0);
  expect(scores.green_impact).toBeGreaterThanOrEqual(0);
});
