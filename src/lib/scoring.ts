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
  
  // Validate inputs
  const efficiency = Number.isFinite(solar.efficiency_pct) ? solar.efficiency_pct : 0;
  const power_output = Number.isFinite(solar.power_output_kw) ? Math.max(0, solar.power_output_kw) : 0;
  const max_power = Number.isFinite(solar.max_power_kw) ? Math.max(0, solar.max_power_kw) : 1;
  const forest_density = Number.isFinite(satellite.forest_density_pct) ? satellite.forest_density_pct : 0;

  const credit_quality = Math.round(clamp(efficiency, 0, 100));
  
  // Handle floating point precision and division by zero
  const power_ratio = max_power > 0 ? clamp(power_output / max_power, 0, 1) : 0;
  const density_ratio = clamp(forest_density / 100, 0, 1);
  
  const raw_green_impact = (power_ratio * 50) + (density_ratio * 50);
  const green_impact = Math.round(clamp(raw_green_impact, 0, 100));
  
  return { credit_quality, green_impact };
}
