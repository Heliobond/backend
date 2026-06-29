import { Router } from "express";
import { parseProjectId } from "../middleware/errors";
import { logger } from "../lib/logger";

const MAX_POWER_KW = 1000;
const DEFAULT_EFFICIENCY_PCT = 60;
const DEFAULT_FOREST_DENSITY_PCT = 50;

/**
 * Generates a deterministic pseudo-random number in [0, 1) for a given seed.
 * Uses a MurmurHash3 finalizer to ensure avalanche: nearby seeds produce
 * vastly different outputs, preventing seed collision for adjacent project IDs.
 * The hourSeed component adds time-based drift that changes hourly.
 */
function seededRandom(seed: number): number {
  const hourSeed = Math.floor(Date.now() / 3_600_000);
  let h = (seed * 2654435761) ^ (hourSeed * 40503) ^ 0x9e3779b9;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h = (h ^ (h >>> 16)) >>> 0;
  return h / 0xffffffff;
}

export function getSolarData(projectId: number) {
  if (projectId == null || Number.isNaN(projectId)) {
    logger.warn("getSolarData called with null/NaN projectId, using defaults", { projectId });
    return {
      power_output_kw: (DEFAULT_EFFICIENCY_PCT / 100) * MAX_POWER_KW,
      efficiency_pct: DEFAULT_EFFICIENCY_PCT,
      max_power_kw: MAX_POWER_KW,
      timestamp: Date.now(),
    };
  }

  const base = seededRandom(projectId);
  const drift = seededRandom(projectId * 7 + 1);
  const safeBase = Number.isNaN(base) ? 0 : base;
  const safeDrift = Number.isNaN(drift) ? 0 : drift;

  if (Number.isNaN(base) || Number.isNaN(drift)) {
    logger.warn("getSolarData: seededRandom returned NaN, using fallback", { projectId, base, drift });
  }

  const efficiency_pct = Math.min(98, Math.max(40, 40 + safeBase * 58 + safeDrift * 2 - 1));
  const power_output_kw = (efficiency_pct / 100) * MAX_POWER_KW;
  return {
    power_output_kw: Math.round(power_output_kw * 100) / 100,
    efficiency_pct: Math.round(efficiency_pct * 100) / 100,
    max_power_kw: MAX_POWER_KW,
    timestamp: Date.now(),
  };
}

export function getSatelliteData(projectId: number) {
  if (projectId == null || Number.isNaN(projectId)) {
    logger.warn("getSatelliteData called with null/NaN projectId, using defaults", { projectId });
    return {
      forest_density_pct: DEFAULT_FOREST_DENSITY_PCT,
      ndvi_score: Math.round(Math.min(1, DEFAULT_FOREST_DENSITY_PCT / 100) * 1000) / 1000,
      timestamp: Date.now(),
    };
  }

  const base = seededRandom(projectId * 3 + 5);
  const drift = seededRandom(projectId * 11 + 2);
  const safeBase = Number.isNaN(base) ? 0 : base;
  const safeDrift = Number.isNaN(drift) ? 0 : drift;

  if (Number.isNaN(base) || Number.isNaN(drift)) {
    logger.warn("getSatelliteData: seededRandom returned NaN, using fallback", { projectId, base, drift });
  }

  const forest_density_pct = Math.min(100, Math.max(0, 30 + safeBase * 65 + safeDrift * 5 - 2.5));
  return {
    forest_density_pct: Math.round(forest_density_pct * 100) / 100,
    ndvi_score: Math.round(Math.min(1, forest_density_pct / 100) * 1000) / 1000,
    timestamp: Date.now(),
  };
}

const router = Router();

router.get("/solar/:id", (req, res) => {
  const id = parseProjectId(req.params.id, "project id");
  res.json(getSolarData(id));
});

router.get("/satellite/:id", (req, res) => {
  const id = parseProjectId(req.params.id, "project id");
  res.json(getSatelliteData(id));
});

export default router;
