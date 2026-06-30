import { Router, Request, Response } from "express";
import { parseProjectId } from "../middleware/errors";
import { logger } from "../lib/logger";

const MAX_POWER_KW = 1000;
const DEFAULT_EFFICIENCY_PCT = 60;
const DEFAULT_FOREST_DENSITY_PCT = 50;

const CRON_TIMEZONE = process.env.CRON_TIMEZONE ?? "UTC";

/**
 * Returns a stable hour metric respecting CRON_TIMEZONE.
 * Defends aggressively against NaN parsing issues.
 */
function getHourSeed(): number {
  try {
    const now = new Date();
    const formatter = new Intl.DateTimeFormat("en-US", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      hour12: false,
      timeZone: CRON_TIMEZONE,
    });

    const parts = formatter.formatToParts(now);
    const get = (type: string): number => {
      const val = parts.find((p) => p.type === type)?.value;
      const parsed = parseInt(val ?? "0", 10);
      return Number.isNaN(parsed) ? 0 : parsed;
    };

    const seed = (get("year") * 10000 + get("month") * 100 + get("day")) * 24 + get("hour");
    return Number.isNaN(seed) ? Math.floor(Date.now() / 3_600_000) : seed;
  } catch (error) {
    logger.error("Invalid CRON_TIMEZONE configuration, falling back to UTC epoch hours", {
      CRON_TIMEZONE,
      error,
    });
    return Math.floor(Date.now() / 3_600_000);
  }
}

/**
 * Generates a deterministic pseudo-random number in [0, 1) for a given seed.
 * Uses MurmurHash3 avalanche properties to avoid adjacent collision.
 */
function seededRandom(seed: number): number {
  const hourSeed = getHourSeed();
  // Ensure the inputs aren't NaN before bitwise operations
  const safeSeed = Number.isNaN(seed) ? 0 : seed;

  let h = (safeSeed * 2654435761) ^ (hourSeed * 40503) ^ 0x9e3779b9;
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

  const efficiency_pct = Math.min(98, Math.max(40, 40 + base * 58 + drift * 2 - 1));
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

  const forest_density_pct = Math.min(100, Math.max(0, 30 + base * 65 + drift * 5 - 2.5));
  return {
    forest_density_pct: Math.round(forest_density_pct * 100) / 100,
    ndvi_score: Math.round(Math.min(1, forest_density_pct / 100) * 1000) / 1000,
    timestamp: Date.now(),
  };
}

const router = Router();

router.get("/solar/:id", (req: Request, res: Response) => {
  try {
    const id = parseProjectId(req.params.id, "project id");
    res.json(getSolarData(id));
  } catch (err) {
    logger.error("Failed to parse project ID for solar data", { error: err });
    res.status(400).json({ error: "Invalid project ID format" });
  }
});

router.get("/satellite/:id", (req: Request, res: Response) => {
  try {
    const id = parseProjectId(req.params.id, "project id");
    res.json(getSatelliteData(id));
  } catch (err) {
    logger.error("Failed to parse project ID for satellite data", { error: err });
    res.status(400).json({ error: "Invalid project ID format" });
  }
});

export default router;
