export interface IotInput {
  solar: { efficiency_pct: number; power_output_kw: number; max_power_kw: number };
  satellite: { forest_density_pct: number; ndvi_score: number };
}

export interface ImpactScores {
  credit_quality: number;
  green_impact: number;
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

export function computeScores(input: IotInput): ImpactScores {
  const { solar, satellite } = input;
  const credit_quality = Math.round(clamp(solar.efficiency_pct, 0, 100));
  const green_impact = Math.round(
    clamp(
      (solar.power_output_kw / solar.max_power_kw) * 50 +
        (satellite.forest_density_pct / 100) * 50,
      0,
      100
    )
  );
  return { credit_quality, green_impact };
}
