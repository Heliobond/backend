// Fixture data for scoring tests
// Each entry provides input parameters and the expected scoring results.
// This file is used by scoring tests to verify computeScores correctness.

export const projectFixtures = [
  {
    projectId: "perfect-data",
    solar: { efficiency_pct: 100, power_output_kw: 1000, max_power_kw: 1000 },
    satellite: { forest_density_pct: 100, ndvi_score: 1 },
    expectedCreditQuality: 100,
    expectedGreenImpact: 100,
  },
  {
    projectId: "zero-data",
    solar: { efficiency_pct: 0, power_output_kw: 0, max_power_kw: 1000 },
    satellite: { forest_density_pct: 0, ndvi_score: 0 },
    expectedCreditQuality: 0,
    expectedGreenImpact: 0,
  },
  {
    projectId: "negative-efficiency",
    solar: { efficiency_pct: -50, power_output_kw: 100, max_power_kw: 1000 },
    satellite: { forest_density_pct: 50, ndvi_score: 0.5 },
    expectedCreditQuality: 0, // clamped to 0
    expectedGreenImpact: 30, // (power/max)*50 + (forest/100)*50 = (100/1000)*50 + (50/100)*50 = 5 + 25 = 30
  },
  {
    projectId: "excess-efficiency",
    solar: { efficiency_pct: 150, power_output_kw: 2000, max_power_kw: 1000 },
    satellite: { forest_density_pct: 120, ndvi_score: 1.5 },
    expectedCreditQuality: 100, // clamped
    expectedGreenImpact: 100, // clamped
  },
  {
    projectId: "zero-max-power",
    solar: { efficiency_pct: 50, power_output_kw: 100, max_power_kw: 0 },
    satellite: { forest_density_pct: 50, ndvi_score: 0.5 },
    expectedCreditQuality: 50,
    expectedGreenImpact: 25, // power component 0, forest 25
  },
];
