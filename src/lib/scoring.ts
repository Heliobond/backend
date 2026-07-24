import { logger } from "./logger";

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

function safeNum(v: number, fallback: number): number {
  if (!Number.isFinite(v)) {
    logger.warn("Non-finite value encountered, using fallback", { value: v, fallback });
    return fallback;
  }
  return v;
}

export function computeScores(input: IotInput): ImpactScores {
  const { solar, satellite } = input;
  const efficiency = clamp(safeNum(solar.efficiency_pct, 0), 0, 100);
  const powerOutput = clamp(safeNum(solar.power_output_kw, 0), 0, Infinity);
  const maxPower = clamp(safeNum(solar.max_power_kw, 0), 0, Infinity);
  const forestDensity = clamp(safeNum(satellite.forest_density_pct, 0), 0, 100);

  const credit_quality = Math.round(efficiency);
  const powerRatio = maxPower > 0 ? powerOutput / maxPower : 0;
  const green_impact = Math.round(
    clamp(powerRatio * 50 + (forestDensity / 100) * 50, 0, 100)
  );
  return { credit_quality, green_impact };
}
