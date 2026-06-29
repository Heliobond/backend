import { Router } from "express";
import { parseProjectId } from "../middleware/errors";

const MAX_POWER_KW = 1000;

// Configurable timezone for seeded-random hour boundaries.
// Defaults to UTC so results are identical across servers regardless of OS locale.
// Set CRON_TIMEZONE=America/New_York to align hourly boundaries with a local clock.
const CRON_TIMEZONE = process.env.CRON_TIMEZONE ?? 'UTC'

/**
 * Return a stable integer that changes once per hour in the configured timezone.
 * Uses Intl.DateTimeFormat so hour boundaries respect the CRON_TIMEZONE setting
 * rather than the server's OS locale.
 */
function getHourSeed(): number {
  try {
    const now = new Date()
    const formatter = new Intl.DateTimeFormat('en-US', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      hour12: false,
      timeZone: CRON_TIMEZONE,
    })
    const parts = formatter.formatToParts(now)
    const get = (type: string) =>
      parseInt(parts.find(p => p.type === type)?.value ?? '0', 10)
    return (get('year') * 10000 + get('month') * 100 + get('day')) * 24 + get('hour')
  } catch {
    // Fallback to UTC hour-count if CRON_TIMEZONE is invalid
    return Math.floor(Date.now() / 3_600_000)
  }
}

function seededRandom(seed: number): number {
  const hourSeed = getHourSeed()
  const x = Math.sin(seed * 9301 + hourSeed * 49297 + 233) * 10000;
  return x - Math.floor(x);
}

export function getSolarData(projectId: number) {
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

router.get("/solar/:id", (req, res) => {
  const id = parseProjectId(req.params.id, "project id");
  res.json(getSolarData(id));
});

router.get("/satellite/:id", (req, res) => {
  const id = parseProjectId(req.params.id, "project id");
  res.json(getSatelliteData(id));
});

export default router;
