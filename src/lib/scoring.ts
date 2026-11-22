import { logger } from "./logger";

/* ── Scoring constants ────────────────────────────────────────────────────
 * Every number the scoring formula depends on lives here, so the formula
 * reads as intent rather than arithmetic and a weight change lands in one
 * place.
 */

/** Lowest value any impact score can take. */
export const SCORE_MIN = 0;
/** Highest value any impact score can take. */
export const SCORE_MAX = 100;

/** Upper bound of any percentage input (efficiency, forest density). */
export const PERCENT_MAX = 100;

/**
 * Share of `green_impact` contributed by solar power output, in points out of
 * `SCORE_MAX`. Applied to the power_output / max_power ratio.
 */
export const GREEN_IMPACT_POWER_WEIGHT = 50;

/**
 * Share of `green_impact` contributed by forest density, in points out of
 * `SCORE_MAX`. Applied to forest_density_pct normalised to 0–1.
 */
export const GREEN_IMPACT_FOREST_WEIGHT = 50;

/** Ratio used when max_power_kw is missing or zero (avoids divide-by-zero). */
export const POWER_RATIO_FALLBACK = 0;

export interface IotInput {
  solar: {
    efficiency_pct: number;
    power_output_kw: number;
    max_power_kw: number;
    /**
     * Epoch milliseconds the solar reading was produced.
     *
     * Optional, and intentionally NOT read by `computeScores` — scoring is a
     * pure function of the reading's values. It is declared so the freshness
     * data returned by `getSolarData` survives the type boundary instead of
     * being silently discarded, and so a future staleness check has something
     * to read.
     */
    timestamp?: number;
  };
  satellite: {
    forest_density_pct: number;
    /**
     * Normalised vegetation index (0–1).
     *
     * Kept deliberately: the default `computeScores` formula below scores
     * greenery from `forest_density_pct` alone, but the configurable formula
     * engine in `scoring-formula.ts` (`computeScoresWithFormula`) weights
     * `ndvi_score` through `ndvi_weight`. Dropping the field from this
     * interface would break that formula, so it is documented rather than
     * removed.
     */
    ndvi_score: number;
    /**
     * Epoch milliseconds the satellite reading was produced.
     * Optional and unused by `computeScores` — see `solar.timestamp`.
     */
    timestamp?: number;
  };
}

export interface ImpactScores {
  credit_quality: number;
  green_impact: number;
}

export function clamp(v: number, min: number, max: number): number {
  if (isNaN(v)) return 0;
  return Math.max(min, Math.min(max, v));
}

function safeNum(v: number, fallback: number): number {
  if (!Number.isFinite(v)) {
    logger.warn("Non-finite value encountered, using fallback", { value: v, fallback });
    return fallback;
  }
  return v;
}

/**
 * Computes the two impact scores for a project reading.
 *
 * - `credit_quality` — solar panel efficiency percentage, rounded.
 * - `green_impact`   — a blend of power utilisation and forest density:
 *   `(power_output / max_power) * GREEN_IMPACT_POWER_WEIGHT +
 *    (forest_density_pct / PERCENT_MAX) * GREEN_IMPACT_FOREST_WEIGHT`,
 *   clamped to `SCORE_MIN..SCORE_MAX`.
 *
 * Reading timestamps are ignored; see `IotInput`.
 */
export function computeScores(input: IotInput): ImpactScores {
  const { solar, satellite } = input;
  const efficiency = clamp(safeNum(solar.efficiency_pct, SCORE_MIN), SCORE_MIN, PERCENT_MAX);
  const powerOutput = clamp(safeNum(solar.power_output_kw, SCORE_MIN), SCORE_MIN, Infinity);
  const maxPower = clamp(safeNum(solar.max_power_kw, SCORE_MIN), SCORE_MIN, Infinity);
  const forestDensity = clamp(
    safeNum(satellite.forest_density_pct, SCORE_MIN),
    SCORE_MIN,
    PERCENT_MAX,
  );

  const credit_quality = Math.round(efficiency);
  const powerRatio = maxPower > 0 ? powerOutput / maxPower : POWER_RATIO_FALLBACK;
  const green_impact = Math.round(
    clamp(
      powerRatio * GREEN_IMPACT_POWER_WEIGHT +
        (forestDensity / PERCENT_MAX) * GREEN_IMPACT_FOREST_WEIGHT,
      SCORE_MIN,
      SCORE_MAX,
    ),
  );
  return { credit_quality, green_impact };
}
